// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {LaunchToken} from "./LaunchToken.sol";
import {BondingCurve, CurveConfig} from "./BondingCurve.sol";
import {GraduationManager} from "./periphery/GraduationManager.sol";
import {LPLock} from "./periphery/LPLock.sol";
import {DevVesting} from "./periphery/DevVesting.sol";
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
    /// @notice Creator's free token allocation, in bps of `CURVE_SUPPLY`, 0 to `maxDevAllocationBps`
    ///         (#34). Carved OUT of the curve allocation, never out of the 200M graduation reserve,
    ///         so the pool is never thinned and `FDV/raise` is untouched. The tokens go straight to
    ///         `DevVesting`, which releases them linearly from GRADUATION (#35) - never from creation,
    ///         because most launches never graduate and a creator on a dying curve would otherwise be
    ///         able to sell back into the curve and extract what other buyers paid in.
    uint16 devAllocationBps;
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
///      creation fee. The full 1B supply is minted to this factory as custodian. Build 03/04
///      route the curve allocation to a bonding curve; Build 05 (#16) escrows the 200M graduation
///      reserve in the GraduationManager and wires each curve to it for atomic graduation.
///      ⚠️ Build #34 ended the "no pre-mine" property: a creator may take 0-5% of the curve supply
///      as a free, vesting dev allocation. The PROTOCOL allocation is still zero (decision #5).
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

    /// @notice The curve calibration at a ZERO dev allocation (#16).
    ///
    ///         ⚠️ `DEFAULT_VIRTUAL_ETH_RESERVE` is live: it is the owner-tunable `virtualEthReserve`'s
    ///         initial value and the base every per-launch solve rescales from.
    ///         ⚠️ `DEFAULT_VIRTUAL_TOKEN_RESERVE` is NOT live and is no longer a default anything.
    ///         Since #34 `_solveCalibration` derives `V_tok` per launch and never reads this constant.
    ///         It is retained as the published calibration anchor: it is the exact value the solve
    ///         must still return at `devAllocationBps == 0`, which
    ///         `test_Calibration_ReproducesTheConstantsAtZeroDev` pins bit-for-bit, and it is the
    ///         pinned value `test_PriceContinuity_BreaksIfVirtualTokenIsPinned` proves is WRONG for
    ///         any carved launch. Do not reintroduce it into a calibration path.
    ///
    ///         Writing `C` for a launch's curve allocation and `G` for `GRADUATION_RESERVE`, price
    ///         continuity (decision #6) requires `V_tok = C^2 / (C - G)`: when `C` sells out, the
    ///         raised ETH divided by the 200M reserve equals the curve's final marginal price, so the
    ///         pool seeds at exactly the price the curve closed at, with no leftover reserves and no
    ///         arbitrage gift to the first swapper.
    ///
    ///         ⚠️ `V_tok` depends on `C`, so it is NOT a constant once a dev allocation exists. Left
    ///         pinned at the 800M value while `C` carves to 760M, the pool opens 9.25% above the
    ///         curve's last price and the raise lands 1.15 ETH short of target. See `docs/tokenomics.md`.
    uint256 public constant DEFAULT_VIRTUAL_ETH_RESERVE = uint256(10 ether) / 3;
    uint256 public constant DEFAULT_VIRTUAL_TOKEN_RESERVE = 1_066_666_666_666_666_666_666_666_666; // 800M^2 / 600M

    /// @notice Ceiling on the owner-tunable `virtualEthReserve`. 1e6 ETH of virtual reserve is a
    ///         3e6 ETH graduation target: absurd, but finite.
    /// @dev ⚠️ **This is a policy bound, not an overflow fix, and the distinction is honest.** An
    ///      overflow does exist - `_solveCalibration` multiplies `virtualEthReserve` by
    ///      600M-with-18-decimals and `BondingCurve` multiplies it again into `k = V_eth * V_tok`,
    ///      both checked, so a large enough value would revert `createLaunch` for every launch made
    ///      under that config. But it sits ~26 orders of magnitude above this ceiling, so no plausible
    ///      value reaches it and calling this bound an overflow guard would overstate it.
    ///
    ///      What it actually buys is that `virtualEthReserve` had NO upper bound at all, in the same
    ///      contract where `MAX_TRADE_FEE_BPS` and `MAX_LOCK_DURATION` exist precisely so an owner
    ///      param cannot be set to a value that makes the product unusable. This closes that gap by
    ///      symmetry with its neighbours, not because an exploit was found.
    ///      ⚠️ Added in #34, outside the ticket's stated scope. Recorded in `docs/tokenomics.md`
    ///      under "Amendments made during implementation".
    uint256 public constant MAX_VIRTUAL_ETH_RESERVE = 1_000_000 ether;

    /// @notice Default curve trade fee, 1% (decision #5). Passed to each curve at creation.
    uint16 public constant DEFAULT_TRADE_FEE_BPS = 100;

    /// @notice Anti-snipe defaults (decision #7): per-wallet cap = 1% of the 800M curve
    ///         allocation, in force until 15% of the curve has sold, then auto-lifts.
    /// @dev ⚠️ Both are SHARES of `CURVE_SUPPLY`, not absolute token counts, and `_curveConfigFor`
    ///      rescales them by `C / CURVE_SUPPLY` so the documented "1%" and "15%" hold for every
    ///      launch whatever its dev allocation (#34).
    ///
    ///      Rescaling rather than clamping is deliberate. A threshold above a launch's own `C` is
    ///      unreachable, so `tokensSold` never crosses it and the per-wallet cap **never lifts** for
    ///      the entire life of that curve - and clamping to `C` reproduces exactly that state, since
    ///      `buyCapActive()` is `tokensSold < antiSnipeThreshold` and sellout is `tokensSold == C`.
    ///      `AntiSnipe.t.sol` deploys `threshold == ALLOC` precisely to mean "window covers the whole
    ///      curve". Scaling makes the unreachable case impossible by construction instead.
    uint256 public constant DEFAULT_MAX_BUY_PER_WALLET = 8_000_000e18; // 1% of 800M
    uint256 public constant DEFAULT_ANTI_SNIPE_THRESHOLD = 120_000_000e18; // 15% of 800M

    /// @notice Ceiling on the creator-selectable dev allocation: 5% of the curve supply (decision #2).
    ///         Free, carved out of `C`, and vested linearly from graduation by #35's vault.
    /// @dev ⚠️ This is a PRE-MINE and it retires the "no pre-mine" claim. The *protocol* allocation
    ///      stays zero (decision #5). Reversible on testnet by setting `maxDevAllocationBps` to 0.
    uint16 public constant MAX_DEV_ALLOCATION_BPS = 500; // 5%

    uint256 internal constant BPS = 10_000;

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

    /// @notice Default linear vesting window for the creator's dev allocation: 30 days from GRADUATION
    ///         (#35). Owner-tunable and frozen per launch at `createLaunch`.
    /// @dev ⚠️ The default sits exactly ON `MIN_VESTING_DURATION`, which is deliberate: from here the
    ///      owner can only ever LENGTHEN the schedule, and lengthening is the direction that favours
    ///      holders. A 5% allocation at this default releases roughly 1.33M tokens a day and is fully
    ///      liquid a month after graduation, where `docs/tokenomics.md` measures a complete 5% exit at
    ///      about -30.6% on price. Vesting delays that, it does not prevent it.
    uint64 public constant DEFAULT_VESTING_DURATION = 30 days;

    /// @notice Floor on the owner-tunable vesting duration, matching `MIN_LOCK_DURATION`. A schedule
    ///         the owner could shrink toward zero would make the whole "vested allocation" claim
    ///         meaningless, so the setter cannot go below it even for launches that do not exist yet.
    uint64 public constant MIN_VESTING_DURATION = 30 days;

    /// @notice Ceiling on the owner-tunable vesting duration: 1460 days, i.e. 4 x 365.
    ///         Not four calendar years - it ignores leap days, exactly as `DEFAULT_LOCK_DURATION`'s
    ///         `365 days` does. Nothing depends on it landing on a calendar boundary.
    /// @dev ⚠️ Unlike `MAX_LOCK_DURATION`, this bound is POLICY and not load-bearing, and the
    ///      difference is worth stating rather than leaving to look alike. The lock's ceiling exists
    ///      because `GraduationManager` computes an expiry as `block.timestamp + lockDuration` in
    ///      checked arithmetic, so an unbounded duration would overflow and brick `graduate` outright.
    ///      `DevVesting` never adds a duration to anything - it compares elapsed time against it - so
    ///      no value here can overflow or divide by zero. The ceiling exists so an owner cannot set a
    ///      schedule longer than a creator would outlive, which would be an unclaimable grant dressed
    ///      up as a vesting one.
    uint64 public constant MAX_VESTING_DURATION = 1460 days;

    /// @notice Default creator share of a graduated position's LP fees: 70% (#33). The pool charges 1%
    ///         per swap, of which Uniswap routes 0.25% to the protocol fee and 0.75% to this position;
    ///         70% of that 0.75% is 0.525% of volume to the creator, 0.475% total to the protocol.
    /// @dev ⚠️ It is a share of what the position ACTUALLY EARNS, not of raw swap volume. That
    ///      distinction is what keeps the promise payable once third-party liquidity joins the pool and
    ///      our position stops earning the whole LP share.
    uint16 public constant DEFAULT_CREATOR_FEE_BPS = 7000;

    /// @notice Executes atomic graduation and escrows the 200M reserve for every launch (#16).
    GraduationManager public immutable graduationManager;

    /// @notice Custodian that owns every graduated LP position (#17, rewritten in #33).
    /// @dev ⚠️ Not a *permanent* lock since #33 - see ADR-0005. The term is per position, one year by
    ///      default, and an expired lock over a pool that has gone quiet is reclaimable by anyone.
    LPLock public immutable lpLock;

    /// @notice Custodian for every creator's dev allocation, releasing it linearly from graduation (#35).
    DevVesting public immutable devVesting;

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
    ///         deliberately NOT tunable: since #34 it is DERIVED per launch as `C^2 / (C - G)`, which
    ///         is what makes graduation price continuity (#16) hold for any `virtualEthReserve` AND
    ///         any dev allocation. An owner-settable `V_tok` could break that invariant directly.
    uint256 public virtualEthReserve = DEFAULT_VIRTUAL_ETH_RESERVE;
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

    /// @notice token => the creator's dev allocation in tokens, carved out of the curve supply (#34).
    /// @dev Zero for a launch that chose no allocation, and zero for any token this factory did not
    ///      launch - so it is never on its own a proof of anything. `curveOf(token) != 0` is the
    ///      identity check (ADR-0003). The tokens themselves left for `devVesting` in the same
    ///      transaction (#35); this is the factory-side record of what was carved, kept so #36 can
    ///      emit it in `LaunchConfig` without an external call. `DevVesting.grantOf(token).total` is
    ///      the same number, written from the same expression in the same transaction, and
    ///      `DevVesting.t.sol` pins the two together so they cannot drift.
    mapping(address => uint256) public devAllocationOf;

    /// @notice The owner-tunable params that fit alongside each other, deliberately declared together.
    ///
    /// @dev ⚠️ **This grouping is a STORAGE LAYOUT decision, not a stylistic one - do not reorder or
    ///      split it, and do not insert a `uint256` in the middle.** All five pack into a single slot
    ///      (8 + 2 + 2 + 8 + 2 = 22 of 32 bytes), and `createLaunch` reads every one of them, so the
    ///      whole group costs one cold SLOAD instead of two.
    ///
    ///      `tradeFeeBps` lives here rather than with the other curve defaults above for exactly that
    ///      reason: sitting between two `uint256`s it occupied a slot of its own and wasted 30 bytes
    ///      of it. Moved in #35a and measured, not assumed - see `docs/security-checklist.md`.
    ///
    ///      All five apply to FUTURE launches only and are frozen per launch at `createLaunch`
    ///      (#18/#33/#34/#35), so no in-flight launch changes under a trader.
    uint64 public defaultLockDuration = DEFAULT_LOCK_DURATION;
    uint16 public creatorFeeBps = DEFAULT_CREATOR_FEE_BPS;
    /// @notice Setting this to 0 turns the pre-mine off entirely without a redeploy.
    uint16 public maxDevAllocationBps = MAX_DEV_ALLOCATION_BPS;
    uint64 public vestingDuration = DEFAULT_VESTING_DURATION;
    uint16 public tradeFeeBps = DEFAULT_TRADE_FEE_BPS;

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
    /// @notice The per-launch terms that `LaunchCreated` has no room to carry: the dev carve, the
    ///         vesting schedule it vests on, and this launch's frozen LP lock terms.
    /// @dev A SECOND event rather than more fields on `LaunchCreated`, which already carries 12 and
    ///      only fits because `_emitLaunchCreated` exists to give it a shallow stack frame.
    ///
    ///      No `devAllocationBps`. The percentage is exactly derivable from `devAllocation` and the
    ///      `CURVE_SUPPLY` constant, and a second encoding of one fact is a thing that can drift.
    ///
    ///      `lockDuration` is meaningless when `permanentLock` is true, and is emitted anyway so the
    ///      value is not silently reinterpreted; consumers must branch on `permanentLock` first.
    /// @param token The launch this configuration belongs to.
    /// @param devAllocation Tokens carved from the curve supply for the creator, held by
    ///        `DevVesting` from this transaction. Zero means no carve and no grant was registered.
    /// @param vestingDuration Seconds the carve vests over, linearly, measured FROM GRADUATION and
    ///        not from creation ([ADR-0007](docs/adr/0007-vesting-runs-from-graduation.md)).
    /// @param lockDuration Seconds the graduated LP position stays locked, from graduation.
    /// @param creatorFeeBps The creator's share of the graduated position's LP fees.
    /// @param permanentLock True if the creator chose a permanent lock at creation, which is terminal.
    event LaunchConfig(
        address indexed token,
        uint256 devAllocation,
        uint64 vestingDuration,
        uint64 lockDuration,
        uint16 creatorFeeBps,
        bool permanentLock
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
    event MaxDevAllocationUpdated(uint16 oldMaxBps, uint16 newMaxBps);
    event VestingDurationUpdated(uint64 oldDuration, uint64 newDuration);

    error InsufficientCreationFee(uint256 sent, uint256 required);
    error ZeroTreasury();
    error FeeTransferFailed();
    error RefundFailed();
    error NotGraduationManager();
    error InvalidProtocolFee(uint8 value);
    error InvalidCurveParams();
    error InvalidLockParams();
    error InvalidDevAllocation();
    error InvalidVestingDuration();

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
        // Deployed last: the vesting vault reads each schedule's start from the GraduationManager, so
        // it needs that address, and holding it immutable keeps `vestingStart` a plain storage read.
        devVesting = new DevVesting(address(this), address(graduationManager));
    }

    /// @notice Number of launches created so far.
    function launchCount() external view returns (uint256) {
        return launches.length;
    }

    /// @notice Preview the curve calibration a launch would get for a given dev allocation, under
    ///         the params in force right now. Lets the create form show the real numbers before the
    ///         creator commits, and lets a caller verify the solve without simulating `createLaunch`.
    /// @dev Reads the same private solve `createLaunch` uses, so a preview and the launch it previews
    ///      cannot disagree. It also REVERTS on an allocation `createLaunch` would reject, rather than
    ///      returning a plausible calibration nobody can actually get. Still only a preview: the owner
    ///      may retune between the two calls, exactly as with every other future-only param.
    function curveCalibrationFor(uint16 devAllocationBps_)
        external
        view
        returns (uint256 devAllocation, uint256 curveAllocation, uint256 virtualEth, uint256 virtualToken)
    {
        (curveAllocation, virtualEth, virtualToken) = _solveCalibration(devAllocationBps_);
        devAllocation = CURVE_SUPPLY - curveAllocation;
    }

    /// @dev The calibration solve, and the single place the dev allocation is bounds-checked.
    ///
    ///      Writing `C` for the curve allocation and `G` for `GRADUATION_RESERVE`:
    ///
    ///        V_tok = C^2 / (C - G)                          price continuity (decision #6)
    ///        V_eth = target * G / (C - G)                   holds the graduation target
    ///
    ///      `virtualEthReserve` stores `V_eth` at a ZERO dev allocation, so rather than reconstruct
    ///      `target` (a second division, a second truncation) we rescale it directly by the identity
    ///      `V_eth(C) = V_eth(CURVE_SUPPLY) * (CURVE_SUPPLY - G) / (C - G)`, which is the same
    ///      expression with `target` cancelled out. Multiply-before-divide throughout, so each value
    ///      truncates exactly once and no division ever precedes a multiplication.
    ///
    ///      ⚠️ Because the stored `V_eth` is ITSELF a truncated value (`10 ether / 3`), the rescale
    ///      can land one wei below the exact solve - it does so at 3%, and nowhere else in 0..5%.
    ///      Three wei on a 10 ETH target. Route (A) was settled on the stored-`V_eth` shape and the
    ///      one-wei table row in `docs/tokenomics.md` is corrected to match this code rather than
    ///      the code bent to match the table.
    ///
    ///      ⚠️ The bound is checked HERE, not at the call sites, so the `unchecked` block below is
    ///      provable from this function alone. Moving the check outward would make the safety of
    ///      these subtractions depend on every caller remembering to do it first.
    function _solveCalibration(uint16 devAllocationBps_)
        private
        view
        returns (uint256 curveAllocation, uint256 virtualEth, uint256 virtualToken)
    {
        if (devAllocationBps_ > maxDevAllocationBps) revert InvalidDevAllocation();

        // `maxDevAllocationBps <= MAX_DEV_ALLOCATION_BPS` (500), enforced by `setMaxDevAllocationBps`
        // and by the initializer, so the product is at most 5% of CURVE_SUPPLY and `curveAllocation`
        // lands in [760M, 800M]. Both subtractions are therefore structurally underflow-free against
        // a 200M `GRADUATION_RESERVE`, which is what makes eliding the checks safe rather than merely
        // cheap. Solidity 0.8 checked arithmetic still guards every other line in this contract.
        unchecked {
            curveAllocation = CURVE_SUPPLY - (CURVE_SUPPLY * devAllocationBps_) / BPS;
            uint256 denom = curveAllocation - GRADUATION_RESERVE;
            virtualEth = (virtualEthReserve * (CURVE_SUPPLY - GRADUATION_RESERVE)) / denom;
            virtualToken = (curveAllocation * curveAllocation) / denom;
        }
    }

    /// @dev Wraps `_solveCalibration` into the full `CurveConfig` a curve is constructed from. Split
    ///      out of `createLaunch` for the same stack reason `_emitLaunchCreated` exists.
    function _curveConfigFor(address token, uint16 devAllocationBps_)
        private
        view
        returns (CurveConfig memory cfg)
    {
        (uint256 curveAllocation, uint256 virtualEth, uint256 virtualToken) =
            _solveCalibration(devAllocationBps_);

        // The anti-snipe params are shares of CURVE_SUPPLY; rescale them onto this launch's own `C`
        // so "1% of the curve" and "15% of the curve" stay true. The floor cannot reach zero for any
        // sane cap, but a cap small enough to floor to zero would trip BondingCurve's
        // `maxBuyPerWallet > 0` require and brick the launch, so it is floored at one wei.
        uint256 cap = (maxBuyPerWallet * curveAllocation) / CURVE_SUPPLY;

        cfg = CurveConfig({
            token: IERC20(token),
            treasury: treasury,
            graduationManager: address(graduationManager),
            virtualEthReserve: virtualEth,
            virtualTokenReserve: virtualToken,
            curveTokenAllocation: curveAllocation,
            tradeFeeBps: tradeFeeBps,
            maxBuyPerWallet: cap == 0 ? 1 : cap,
            antiSnipeThreshold: (antiSnipeThreshold * curveAllocation) / CURVE_SUPPLY
        });
    }

    /// @dev Send the creator's carve to the vesting vault and record it.
    /// @param curveAllocation This launch's CURVE allocation, from which the dev carve is derived as
    ///        `CURVE_SUPPLY - curveAllocation`. It takes the curve figure rather than the dev one
    ///        because `createLaunch` already holds that value in `cfg` and has no spare stack slot
    ///        for another local - the same 16-slot ceiling that forced `_emitLaunchCreated` to exist.
    ///
    /// @dev A zero carve registers nothing at all, rather than a zero-value grant. `DevVesting` then
    ///      reads that token as `UnknownGrant` instead of as an empty schedule, which is the honest
    ///      distinction: the launch has no creator allocation, not one worth nothing.
    /// @dev Its own function for the same reason `_emitLaunchCreated` is: `createLaunch` is already
    ///      at the EVM's 16-slot reachable stack limit, so the six event fields get a shallow frame
    ///      rather than six more locals on that one.
    ///
    ///      Takes `curveAllocation` and derives the dev carve from it rather than reading
    ///      `devAllocationOf`, because that mapping is written by `_grantDevCarve`, which runs after
    ///      this. Same derivation as `_grantDevCarve` uses, from the same argument, so the event and
    ///      the transfer cannot disagree about the amount.
    function _emitLaunchConfig(address token, uint256 curveAllocation) private {
        LaunchLockConfig memory lock = lockConfigOf[token];
        emit LaunchConfig(
            token, CURVE_SUPPLY - curveAllocation, vestingDuration, lock.lockDuration, lock.creatorFeeBps, lock.permanent
        );
    }

    function _grantDevCarve(address token, uint256 curveAllocation) private {
        uint256 devAllocation = CURVE_SUPPLY - curveAllocation;
        devAllocationOf[token] = devAllocation;
        if (devAllocation == 0) return;

        IERC20(token).safeTransfer(address(devVesting), devAllocation);
        devVesting.registerGrant(token, msg.sender, devAllocation, vestingDuration);
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
        // The dev allocation is bounds-checked inside `_solveCalibration`, deliberately NOT duplicated
        // here. A second copy of the bound is a second thing that can drift, and hoisting the solve
        // above the token deploy to fail earlier would push three more locals onto a frame that is
        // already at the EVM's 16-slot reachable limit (see `_emitLaunchCreated`).

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
        CurveConfig memory cfg = _curveConfigFor(token, p.devAllocationBps);
        address curve = address(new BondingCurve(cfg));
        // Register the curve before moving tokens so the GraduationManager can authorize it.
        launches.push(token);
        creatorOf[token] = msg.sender;
        curveOf[token] = curve;
        // The curve allocation (80% less any dev carve) goes to the curve for sale; the 20%
        // graduation reserve is escrowed in the GraduationManager, which seeds it into the pool at
        // graduation (#16); the dev allocation is the remainder and goes to the vesting vault (#35).
        // Between them these three transfers move the entire 1B supply out of this contract, which is
        // what keeps the factory holding no launch tokens and needing no path to move any.
        IERC20(token).safeTransfer(curve, cfg.curveTokenAllocation);
        IERC20(token).safeTransfer(address(graduationManager), GRADUATION_RESERVE);

        // ⚠️ `LaunchCreated` MUST be emitted before `GrantRegistered`, and the ordering is not
        // cosmetic. Both logs land in this one transaction, and an indexer processes them in log
        // order: `LaunchCreated` is what creates the `Launch` entity, so a `GrantRegistered` handler
        // running first would `load()` a null and either drop the grant or have to construct a
        // half-built entity. Cheap to order correctly here, expensive to discover in #36.
        _emitLaunchCreated(curve, LaunchStrings(p.name, p.symbol, p.metadataURI), cfg);
        // Between the two, deliberately: it completes the launch's configuration before
        // `_grantDevCarve` emits `GrantRegistered`, so an indexer sees the terms and then the grant
        // that honours them, never the reverse.
        _emitLaunchConfig(token, cfg.curveTokenAllocation);
        _grantDevCarve(token, cfg.curveTokenAllocation);

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
    ///         trade fee to a sane ceiling. `virtualTokenReserve` is intentionally not exposed: it is
    ///         derived per launch from that launch's curve allocation, so price continuity (#16) holds
    ///         for any `virtualEthReserve` and any dev allocation.
    ///         In-flight launches already froze their params into curve immutables and are untouched.
    function setCurveParams(
        uint256 virtualEthReserve_,
        uint16 tradeFeeBps_,
        uint256 maxBuyPerWallet_,
        uint256 antiSnipeThreshold_
    ) external onlyOwner {
        if (virtualEthReserve_ == 0 || virtualEthReserve_ > MAX_VIRTUAL_ETH_RESERVE) revert InvalidCurveParams();
        if (tradeFeeBps_ > MAX_TRADE_FEE_BPS) revert InvalidCurveParams();
        if (maxBuyPerWallet_ == 0) revert InvalidCurveParams();
        // ⚠️ Strictly less than, not `<=`. A threshold equal to the curve supply is UNREACHABLE:
        // `buyCapActive()` is `tokensSold < antiSnipeThreshold` and sellout is `tokensSold == C`, so
        // the per-wallet cap would bind for the entire life of every future curve. Rescaling onto a
        // launch's own `C` does not save it either, since `T == CURVE_SUPPLY` scales to exactly `C`.
        // `T < CURVE_SUPPLY` scales to strictly below `C`, so the lift is always reachable.
        // Pre-existing footgun, tightened in #34 because the same line now feeds the rescale.
        if (antiSnipeThreshold_ >= CURVE_SUPPLY) revert InvalidCurveParams();
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

    /// @notice Retune the ceiling on the creator-selectable dev allocation, for FUTURE launches (#34).
    ///         Existing launches carved their allocation at creation and are untouched, including
    ///         ones still on the curve - lowering this never claws back an allocation already made.
    /// @dev Bounded by the hard `MAX_DEV_ALLOCATION_BPS` constant rather than left open: the solve
    ///      needs `C > GRADUATION_RESERVE`, and `V_tok = C^2 / (C - G)` diverges as `C` approaches
    ///      `G`. 5% keeps `C` at 760M against a 200M reserve, nowhere near it. Zero is valid and is
    ///      the documented way to turn the pre-mine off without a redeploy.
    function setMaxDevAllocationBps(uint16 maxDevAllocationBps_) external onlyOwner {
        if (maxDevAllocationBps_ > MAX_DEV_ALLOCATION_BPS) revert InvalidDevAllocation();
        emit MaxDevAllocationUpdated(maxDevAllocationBps, maxDevAllocationBps_);
        maxDevAllocationBps = maxDevAllocationBps_;
    }

    /// @notice Retune the linear vesting window for the dev allocation, for FUTURE launches (#35).
    ///         Existing grants froze their duration at creation and are untouched, including grants on
    ///         launches still sitting on the curve - so lengthening this can never extend a schedule a
    ///         creator has already been promised, and shortening it can never accelerate one.
    /// @dev Bounded rather than left open, but see `MAX_VESTING_DURATION`: this ceiling is policy, not
    ///      an arithmetic guard, and nothing in `DevVesting` overflows without it.
    function setVestingDuration(uint64 vestingDuration_) external onlyOwner {
        if (vestingDuration_ < MIN_VESTING_DURATION || vestingDuration_ > MAX_VESTING_DURATION) {
            revert InvalidVestingDuration();
        }
        emit VestingDurationUpdated(vestingDuration, vestingDuration_);
        vestingDuration = vestingDuration_;
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
