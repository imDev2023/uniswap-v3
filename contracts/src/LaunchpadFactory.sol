// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {LaunchToken} from "./LaunchToken.sol";
import {BondingCurve, CurveConfig} from "./BondingCurve.sol";
import {GraduationManager} from "./periphery/GraduationManager.sol";
import {LPLock} from "./periphery/LPLock.sol";
import {IUniswapV3Factory, IUniswapV3Pool} from "./interfaces/IUniswapV3Minimal.sol";

/// @notice The three creator-supplied strings for a launch, bundled into one struct.
/// @dev Purely a stack-management device (Build 11 / #24). Three `string calldata` arguments occupy
///      six stack slots (offset + length each); behind one memory pointer they occupy one, which is
///      what keeps `_emitLaunchCreated` inside the EVM's 16-slot reachable stack under legacy codegen.
struct LaunchStrings {
    string name;
    string symbol;
    string metadataURI;
}

/// @notice Everything a creator chooses at `createLaunch`.
/// @dev A calldata struct rather than a growing argument list, for the same stack reason
///      `LaunchStrings` exists: `createLaunch` is already at the edge of the EVM's 16-slot reachable
///      stack under legacy codegen, and each new scalar argument pushes it over. It also means #34 can
///      add the dev allocation as one more field without another signature break.
struct LaunchParams {
    string name;
    string symbol;
    string metadataURI;
    /// @notice Lock the graduation LP permanently instead of for `defaultLockDuration`. Terminal:
    ///         a permanent lock can never be reclaimed, and `extend` cannot walk it back.
    bool permanentLock;
}

/// @notice The lock terms frozen into a launch at creation and consumed at graduation (#33).
/// @dev ⚠️ Frozen at CREATION, not read live at graduation, and this is a deliberate divergence from
///      the "future graduations" wording in `docs/tokenomics.md`. Read live, the owner could shorten
///      the default lock in the window between a launch's creation and its graduation, so a trader who
///      bought a curve advertising a 1-year lock could graduate into a shorter one. Freezing costs one
///      storage word and makes the terms readable, and binding, from the moment the curve opens.
struct LaunchLockConfig {
    uint64 lockDuration; // seconds from graduation; ignored when `permanent`
    uint16 creatorFeeBps; // creator's share of the graduated position's LP fees
    bool permanent;
}

/// @notice Entry point for creating a token launch.
/// @dev Build 02 (#13): deploys a fixed-supply immutable LaunchToken and collects the
///      creation fee. The full 1B supply is minted to this factory as custodian — no
///      pre-mine to the creator (fair launch, decision #5). Build 03/04 route the 800M
///      curve allocation to a bonding curve; Build 05 (#16) escrows the 200M graduation
///      reserve in the GraduationManager and wires each curve to it for atomic graduation.
///      Fee/treasury are owner-adjustable and apply only to FUTURE launches (decision #9).
///      Build 07 (#18): ownership is `Ownable2Step`, so control is handed to a Safe multisig
///      via a two-step transfer+accept (a mistyped owner can never brick the launchpad), and the
///      curve defaults become owner-tunable guarded params that likewise bind only FUTURE launches.
contract LaunchpadFactory is Ownable2Step {
    using SafeERC20 for IERC20;

    /// @notice Split of the fixed 1B supply: 80% sold on the curve, 20% reserved to seed
    ///         the graduation pool (decisions #5/#6). The reserve is escrowed in the
    ///         GraduationManager at launch creation.
    uint256 public constant CURVE_SUPPLY = 800_000_000e18;
    uint256 public constant GRADUATION_RESERVE = 200_000_000e18;

    /// @notice Default virtual reserves for new curves, calibrated for graduation (#16).
    ///         V_token = CURVE_SUPPLY^2 / (CURVE_SUPPLY - GRADUATION_RESERVE) so that when the
    ///         800M allocation sells out, 100% of the raised ETH divided by the 200M reserve
    ///         equals the curve's final marginal price — i.e. the pool seeds at exactly the
    ///         curve's final price with no leftover reserves (price continuity, decision #6).
    ///         With V_eth = 30 ether this puts the graduation threshold at 90 ETH raised.
    uint256 public constant DEFAULT_VIRTUAL_ETH_RESERVE = 30 ether;
    uint256 public constant DEFAULT_VIRTUAL_TOKEN_RESERVE = 1_066_666_666_666_666_666_666_666_666; // 800M^2 / 600M

    /// @notice Default curve trade fee, 1% (decision #5). Passed to each curve at creation.
    uint16 public constant DEFAULT_TRADE_FEE_BPS = 100;

    /// @notice Anti-snipe defaults (decision #7): per-wallet cap = 1% of the 800M curve
    ///         allocation, in force until 15% of the curve has sold, then auto-lifts.
    uint256 public constant DEFAULT_MAX_BUY_PER_WALLET = 8_000_000e18; // 1% of 800M
    uint256 public constant DEFAULT_ANTI_SNIPE_THRESHOLD = 120_000_000e18; // 15% of 800M

    /// @notice Ceiling on the owner-tunable curve trade fee: 10% (1000 bps). A generous but finite
    ///         cap so a param change can never brick a launch or gouge traders (#18).
    uint16 public constant MAX_TRADE_FEE_BPS = 1000;

    /// @notice Default LP lock for a graduated launch: 1 year, measured from graduation (#33).
    ///         Creators may select a permanent lock at creation, or `LPLock.extend` at any time after.
    uint64 public constant DEFAULT_LOCK_DURATION = 365 days;

    /// @notice Floor on the owner-tunable lock duration. A lock the owner could shrink toward zero for
    ///         future launches would make the whole "locked liquidity" claim meaningless, so the
    ///         setter cannot go below 30 days even for launches that do not exist yet.
    uint64 public constant MIN_LOCK_DURATION = 30 days;

    /// @notice Ceiling on the owner-tunable lock duration: 100 years.
    /// @dev ⚠️ This bound is load-bearing, not cosmetic. `GraduationManager` computes a launch's expiry
    ///      as `uint64(block.timestamp) + lockDuration`, in CHECKED arithmetic. Without a ceiling, a
    ///      large enough duration makes that addition overflow and `graduate()` reverts **permanently**
    ///      for every launch created under that config - an owner param that silently bricks
    ///      graduation, which is exactly what `MAX_TRADE_FEE_BPS` exists to prevent for the trade fee.
    ///      A duration landing exactly on `type(uint64).max` would be worse still: it would collide
    ///      with LPLock's PERMANENT sentinel and hand out a permanent lock the creator never chose.
    ///      100 years leaves ~5.8e11 years of headroom below the overflow, so the sum cannot approach
    ///      either failure. Anyone actually wanting "forever" selects `permanentLock` explicitly.
    uint64 public constant MAX_LOCK_DURATION = 36_500 days;

    /// @notice Default creator share of a graduated position's LP fees: 70% (#33). The pool charges 1%
    ///         per swap, of which Uniswap routes 0.25% to the protocol fee and 0.75% to this position;
    ///         70% of that 0.75% is 0.525% of volume to the creator, 0.475% total to the protocol.
    /// @dev ⚠️ It is a share of what the position ACTUALLY EARNS, not of raw swap volume. That
    ///      distinction is what keeps the promise payable once third-party liquidity joins the pool and
    ///      our position stops earning the whole LP share.
    uint16 public constant DEFAULT_CREATOR_FEE_BPS = 7000;

    /// @notice Executes atomic graduation and escrows the 200M reserve for every launch (#16).
    GraduationManager public immutable graduationManager;

    /// @notice Permanent lock that owns every graduated LP position (#17).
    LPLock public immutable lpLock;

    /// @notice The platform's own V3 factory. Ownership is transferred to this launchpad post-deploy,
    ///         which is what lets the owner exercise the protocol fee switch on graduated pools (#17).
    IUniswapV3Factory public immutable v3Factory;

    /// @notice Protocol swap-fee setting applied to graduated pools: 0 = off, else N in [4,10] meaning
    ///         the protocol takes 1/N of each swap's fee (user story 21). Owner-tunable and applies to
    ///         FUTURE graduations; default 4 (protocol takes 1/4 of swap fees).
    uint8 public protocolFee = 4;

    /// @notice Address that receives creation fees, protocol fees, and locked-LP trading fees.
    address public treasury;

    /// @notice Flat fee to create a launch (default 0.01 ETH, decision #5).
    uint256 public creationFee;

    /// @notice Owner-tunable curve defaults applied to FUTURE launches (#18). These bind at the
    ///         moment `createLaunch` runs and are then frozen into that curve's immutables, so an
    ///         in-flight launch is never affected by a later change. `virtualTokenReserve` is
    ///         deliberately NOT tunable: it stays calibration-locked to `DEFAULT_VIRTUAL_TOKEN_RESERVE`
    ///         so graduation price continuity (#16) holds for any `virtualEthReserve`.
    uint256 public virtualEthReserve = DEFAULT_VIRTUAL_ETH_RESERVE;
    uint16 public tradeFeeBps = DEFAULT_TRADE_FEE_BPS;
    uint256 public maxBuyPerWallet = DEFAULT_MAX_BUY_PER_WALLET;
    uint256 public antiSnipeThreshold = DEFAULT_ANTI_SNIPE_THRESHOLD;

    /// @notice Every token this factory has launched, in creation order.
    address[] public launches;

    /// @notice token => creator who launched it.
    mapping(address => address) public creatorOf;

    /// @notice token => its bonding curve.
    mapping(address => address) public curveOf;

    /// @notice token => the LP lock terms frozen at its creation, consumed by the GraduationManager.
    mapping(address => LaunchLockConfig) public lockConfigOf;

    /// @notice Owner-tunable lock defaults applied to FUTURE launches (#33), frozen per launch at
    ///         `createLaunch` exactly like the curve params above.
    uint64 public defaultLockDuration = DEFAULT_LOCK_DURATION;
    uint16 public creatorFeeBps = DEFAULT_CREATOR_FEE_BPS;

    /// @notice A new launch.
    /// @dev Build 11 (#24) widened this event to be self-sufficient: it carries the metadata URI plus
    ///      the complete set of curve params frozen into this launch's `BondingCurve` immutables, so
    ///      an indexer or plain-RPC client can reconstruct the curve's whole pricing state from one
    ///      log with no `eth_call`. Two concrete reasons: a pruned RPC rejects historical `eth_call`
    ///      during backfill, and an untraded launch previously indexed with `priceX18 == 0` because
    ///      price was only ever learned from a `Bought`/`Sold` that had not happened yet.
    ///
    ///      `createLaunch` builds one `CurveConfig` in memory and uses it BOTH to construct the curve
    ///      and to populate this event, so the emitted params and the deployed immutables cannot
    ///      disagree even if the owner retunes the defaults in a later block. `virtualTokenReserve`
    ///      and `curveTokenAllocation` are constants today but are emitted anyway: they belong to the
    ///      frozen set, and emitting them frees consumers from copying a constant they cannot verify.
    ///
    ///      Only 3 params are indexed — the EVM's ceiling for a non-anonymous event.
    event LaunchCreated(
        address indexed token,
        address indexed curve,
        address indexed creator,
        string name,
        string symbol,
        string metadataURI,
        uint256 virtualEthReserve,
        uint256 virtualTokenReserve,
        uint256 curveTokenAllocation,
        uint16 tradeFeeBps,
        uint256 maxBuyPerWallet,
        uint256 antiSnipeThreshold
    );
    event CreationFeeUpdated(uint256 oldFee, uint256 newFee);
    event TreasuryUpdated(address oldTreasury, address newTreasury);
    event ProtocolFeeUpdated(uint8 oldFee, uint8 newFee);
    event PoolProtocolFeeSet(address indexed pool, uint8 feeProtocol);
    event ProtocolFeeSkipped(address indexed pool);
    event ProtocolFeesCollected(address indexed pool, address indexed treasury, uint128 amount0, uint128 amount1);
    event CurveParamsUpdated(
        uint256 virtualEthReserve, uint16 tradeFeeBps, uint256 maxBuyPerWallet, uint256 antiSnipeThreshold
    );
    event LockParamsUpdated(uint64 defaultLockDuration, uint16 creatorFeeBps);

    error InsufficientCreationFee(uint256 sent, uint256 required);
    error ZeroTreasury();
    error FeeTransferFailed();
    error RefundFailed();
    error NotGraduationManager();
    error InvalidProtocolFee(uint8 value);
    error InvalidCurveParams();
    error InvalidLockParams();

    /// @param positionManager The platform's own V3 NonfungiblePositionManager (decision #4).
    /// @param v3Factory_ The platform's own V3 factory; ownership is transferred to this launchpad
    ///        post-deploy so the owner can drive the protocol fee switch (#17 / decision #9).
    /// @param weth9_ The chain's canonical wrapped-native, wrapped into the graduation pool. Passed in
    ///        (not hardcoded) so the same code deploys on testnet 46630 and mainnet 4663, whose WETH9
    ///        addresses differ (#18); defaults to `Constants.WETH9` (mainnet) in the deploy script.
    constructor(
        address initialOwner,
        address treasury_,
        uint256 creationFee_,
        address positionManager,
        address v3Factory_,
        address weth9_
    ) Ownable(initialOwner) {
        if (treasury_ == address(0)) revert ZeroTreasury();
        treasury = treasury_;
        creationFee = creationFee_;
        v3Factory = IUniswapV3Factory(v3Factory_);
        // One lock + one GraduationManager per factory. Graduated positions mint straight into the
        // lock; the manager authorizes callers via this factory's curveOf().
        lpLock = new LPLock(positionManager, address(this));
        graduationManager = new GraduationManager(address(this), positionManager, weth9_, address(lpLock));
    }

    /// @notice Number of launches created so far.
    function launchCount() external view returns (uint256) {
        return launches.length;
    }

    /// @notice Create a new token launch. The caller pays at least `creationFee`; any
    ///         excess is refunded. The full fixed supply is minted to this factory.
    /// @param p The creator's choices for this launch. `p.metadataURI` is the URI of the token's
    ///        off-chain JSON metadata (`{name, description, image,
    ///        banner, links}`). Stored permanently on the token with no setter — see
    ///        `LaunchToken.metadataURI`. Content-addressed storage (IPFS) is the intended home;
    ///        the contract does not and cannot validate that the URI resolves, so an unreachable
    ///        or mistyped URI is permanent. Passing an empty string is allowed and simply means
    ///        "no metadata"; clients should fall back to a default avatar.
    /// @return token The newly deployed LaunchToken.
    function createLaunch(LaunchParams calldata p) external payable returns (address token) {
        uint256 fee = creationFee;
        if (msg.value < fee) revert InsufficientCreationFee(msg.value, fee);

        token = address(new LaunchToken(p.name, p.symbol, p.metadataURI, address(this)));

        // Freeze this launch's lock terms now, so they are readable and binding from the moment the
        // curve opens rather than resolved at graduation under whatever the defaults are by then.
        lockConfigOf[token] = LaunchLockConfig({
            lockDuration: defaultLockDuration,
            creatorFeeBps: creatorFeeBps,
            permanent: p.permanentLock
        });

        // Read the owner-tunable params into ONE memory struct, then use that same struct both to
        // construct the curve and to populate LaunchCreated. Sharing the struct (rather than
        // re-reading storage for the event) makes it structurally impossible for the emitted params
        // to disagree with the curve's immutables — there is only one read of each storage slot.
        // It also keeps `createLaunch` under the stack limit.
        CurveConfig memory cfg = CurveConfig({
            token: IERC20(token),
            treasury: treasury,
            graduationManager: address(graduationManager),
            virtualEthReserve: virtualEthReserve,
            virtualTokenReserve: DEFAULT_VIRTUAL_TOKEN_RESERVE,
            curveTokenAllocation: CURVE_SUPPLY,
            tradeFeeBps: tradeFeeBps,
            maxBuyPerWallet: maxBuyPerWallet,
            antiSnipeThreshold: antiSnipeThreshold
        });
        address curve = address(new BondingCurve(cfg));
        // Register the curve before moving tokens so the GraduationManager can authorize it.
        launches.push(token);
        creatorOf[token] = msg.sender;
        curveOf[token] = curve;

        // 80% goes to the curve for sale; the 20% graduation reserve is escrowed in the
        // GraduationManager, which seeds it into the pool at graduation (#16).
        IERC20(token).safeTransfer(curve, CURVE_SUPPLY);
        IERC20(token).safeTransfer(address(graduationManager), GRADUATION_RESERVE);

        _emitLaunchCreated(curve, LaunchStrings(p.name, p.symbol, p.metadataURI), cfg);

        // Interactions last.
        if (fee > 0) {
            (bool ok,) = treasury.call{value: fee}("");
            if (!ok) revert FeeTransferFailed();
        }
        uint256 refund = msg.value - fee;
        if (refund > 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            if (!ok) revert RefundFailed();
        }
    }

    /// @dev Emitting `LaunchCreated` is split into its own function purely for stack room: the event
    ///      carries three dynamic strings plus six curve params, and inlining it in `createLaunch`
    ///      (which is already holding the fee, the token, the curve and the config) overflows the
    ///      EVM's 16-slot reachable stack. A shallow frame is a cheaper fix than switching the whole
    ///      project to `viaIR`, which would change the bytecode of every contract right before an audit.
    function _emitLaunchCreated(address curve, LaunchStrings memory s, CurveConfig memory cfg) private {
        emit LaunchCreated(
            address(cfg.token), // same struct the curve was built from — cannot drift
            curve,
            msg.sender,
            s.name,
            s.symbol,
            s.metadataURI,
            cfg.virtualEthReserve,
            cfg.virtualTokenReserve,
            cfg.curveTokenAllocation,
            cfg.tradeFeeBps,
            cfg.maxBuyPerWallet,
            cfg.antiSnipeThreshold
        );
    }

    /// @notice Update the creation fee (applies to future launches only).
    function setCreationFee(uint256 newFee) external onlyOwner {
        emit CreationFeeUpdated(creationFee, newFee);
        creationFee = newFee;
    }

    /// @notice Update the treasury address (applies to future fees only).
    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroTreasury();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    /// @notice Retune the curve defaults for FUTURE launches (#18). Validation mirrors BondingCurve's
    ///         constructor invariants so a launch can never be bricked by a param change, and clamps the
    ///         trade fee to a sane ceiling. `virtualTokenReserve` is intentionally not exposed — it stays
    ///         calibration-locked so graduation price continuity (#16) holds for any `virtualEthReserve`.
    ///         In-flight launches already froze their params into curve immutables and are untouched.
    function setCurveParams(
        uint256 virtualEthReserve_,
        uint16 tradeFeeBps_,
        uint256 maxBuyPerWallet_,
        uint256 antiSnipeThreshold_
    ) external onlyOwner {
        if (virtualEthReserve_ == 0) revert InvalidCurveParams();
        if (tradeFeeBps_ > MAX_TRADE_FEE_BPS) revert InvalidCurveParams();
        if (maxBuyPerWallet_ == 0) revert InvalidCurveParams();
        if (antiSnipeThreshold_ > CURVE_SUPPLY) revert InvalidCurveParams();
        virtualEthReserve = virtualEthReserve_;
        tradeFeeBps = tradeFeeBps_;
        maxBuyPerWallet = maxBuyPerWallet_;
        antiSnipeThreshold = antiSnipeThreshold_;
        emit CurveParamsUpdated(virtualEthReserve_, tradeFeeBps_, maxBuyPerWallet_, antiSnipeThreshold_);
    }

    /// @notice Retune the LP lock defaults for FUTURE launches (#33). Existing launches froze their
    ///         terms at creation and are untouched, including ones still on the curve.
    /// @dev The creator fee share is deliberately allowed across its whole 0..100% range: unlike the
    ///      trade fee it is a split of revenue we would otherwise keep, so there is no value at which
    ///      it can gouge a trader or brick a launch. The lock duration has a floor, because a
    ///      near-zero lock would make the headline claim meaningless.
    function setLockParams(uint64 lockDuration_, uint16 creatorFeeBps_) external onlyOwner {
        if (lockDuration_ < MIN_LOCK_DURATION || lockDuration_ > MAX_LOCK_DURATION) revert InvalidLockParams();
        // Single source of truth for the ceiling: the lock enforces it again on `registerLock`, and a
        // second literal here could drift away from it.
        if (creatorFeeBps_ > lpLock.MAX_CREATOR_FEE_BPS()) revert InvalidLockParams();
        defaultLockDuration = lockDuration_;
        creatorFeeBps = creatorFeeBps_;
        emit LockParamsUpdated(lockDuration_, creatorFeeBps_);
    }

    /// @notice Set the default protocol fee applied to FUTURE graduated pools. 0 = off, else 4..10.
    function setProtocolFee(uint8 newFee) external onlyOwner {
        if (newFee != 0 && (newFee < 4 || newFee > 10)) revert InvalidProtocolFee(newFee);
        emit ProtocolFeeUpdated(protocolFee, newFee);
        protocolFee = newFee;
    }

    /// @notice Turn on the current protocol fee for a freshly graduated pool. Called by the
    ///         GraduationManager during graduation. Best-effort: only acts if this launchpad owns the
    ///         V3 factory, so a fee-switch misconfiguration can never brick a graduation.
    function applyProtocolFee(address pool) external {
        if (msg.sender != address(graduationManager)) revert NotGraduationManager();
        uint8 fee = protocolFee;
        if (fee == 0) return; // protocol fee intentionally off; nothing to signal
        if (v3Factory.owner() == address(this)) {
            IUniswapV3Pool(pool).setFeeProtocol(fee, fee);
            emit PoolProtocolFeeSet(pool, fee);
        } else {
            // Misconfigured (launchpad doesn't own the V3 factory yet). Never brick graduation;
            // surface it so the owner can remediate later via setPoolProtocolFee.
            emit ProtocolFeeSkipped(pool);
        }
    }

    /// @notice Owner override to (re)set a specific pool's protocol fee. Requires this launchpad to
    ///         own the V3 factory. 0 = off, else 4..10.
    function setPoolProtocolFee(address pool, uint8 feeProtocol) external onlyOwner {
        if (feeProtocol != 0 && (feeProtocol < 4 || feeProtocol > 10)) revert InvalidProtocolFee(feeProtocol);
        IUniswapV3Pool(pool).setFeeProtocol(feeProtocol, feeProtocol);
        emit PoolProtocolFeeSet(pool, feeProtocol);
    }

    /// @notice Sweep a pool's accrued protocol fees to the treasury. Permissionless — the funds can
    ///         only ever go to the treasury. Requires this launchpad to own the V3 factory.
    function collectProtocolFees(address pool) external returns (uint128 amount0, uint128 amount1) {
        (amount0, amount1) = IUniswapV3Pool(pool).collectProtocol(treasury, type(uint128).max, type(uint128).max);
        emit ProtocolFeesCollected(pool, treasury, amount0, amount1);
    }
}
