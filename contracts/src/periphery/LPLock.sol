// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.24;

import {INonfungiblePositionManager, IUniswapV3Pool} from "../interfaces/IUniswapV3Minimal.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface ILaunchpadLockView {
    function treasury() external view returns (address);
    function owner() external view returns (address);
    function creatorOf(address token) external view returns (address);
    function graduationManager() external view returns (address);
}

/// @notice Where a locked position came from. Governs BOTH the creator fee split and `reclaim`.
/// @dev ⚠️ `None` occupies the zero slot ON PURPOSE and this ordering is load-bearing. Every field of
///      an unregistered `tokenId` reads as zero, so if `Launch` sat at 0 then any NFT a stranger
///      transferred into this contract would read as a launch position and satisfy `reclaim`'s origin
///      guard. The stated requirement is that reclaiming third-party liquidity be STRUCTURALLY
///      impossible, not merely unintended - reordering this enum silently defeats that.
enum LockOrigin {
    None,
    Launch,
    ThirdParty
}

/// @notice Why a `reclaim` would be refused. `NoBlocker` means it would succeed.
/// @dev Named rather than boolean so callers (and the UI in #37) can say WHICH condition is
///      outstanding instead of only that the position is not yet reclaimable.
enum ReclaimBlocker {
    NoBlocker,
    NotALaunchPosition,
    AlreadyReclaimedBlocker,
    PermanentLock,
    NotExpired,
    PoolActive
}

/// @notice One locked position. Terms are frozen here at lock time and can never move against the
///         creator afterwards (see the retroactive-lever note on the contract).
struct LockRecord {
    // --- slot 0 (30 bytes) ---
    address launchToken; // the launch's ERC-20; address(0) for third-party locks
    uint64 lockUntil; // PERMANENT sentinel == type(uint64).max
    LockOrigin origin;
    bool reclaimed;
    // --- slot 1 (30 bytes) ---
    address pool; // the V3 pool this position is in; source of the liveness read
    uint64 lockedAt;
    uint16 creatorFeeBps; // creator's share of THIS position's LP fees, frozen at lock time
}

/// @notice Trustless custodian for graduated LP positions (#17, rewritten in #33).
///
/// @dev ⚠️ **The security model CHANGED in #33 and the old claim no longer holds.** This contract
///      previously exposed no function that could transfer, burn, approve or `decreaseLiquidity` a
///      position, so "the principal can never be withdrawn" was verifiable by reading the bytecode and
///      finding the capability absent. `reclaim` introduces that capability deliberately. The lock is
///      now CONDITIONAL: principal can leave, but only through `reclaim`, and only when every one of
///      its guards passes. Those guards are therefore the highest-value attack surface in the protocol
///      - a defect in them drains every graduated pool this factory has ever created.
///
///      What survives unchanged: nothing here can send principal to a caller, to the owner, or to any
///      address the caller chooses. Reclaimed value has exactly two fixed destinations - the launch
///      token is burned to `DEAD` and the paired WETH goes to the launchpad's treasury. There is no
///      recipient parameter anywhere in this contract.
///
///      **Three things are frozen per position at lock time rather than read live**, because reading
///      them live would make each an owner-controlled retroactive lever over a position that already
///      exists: the lock expiry, the creator's fee share, and the origin. The one term that IS read
///      live is `inactivityPeriod`, which is why its setter is monotonic (lengthen only).
///
///      The treasury is read live from the launchpad on purpose - it is a destination, not a term, and
///      routing future collections to a new treasury confers no power over locked principal.
contract LPLock is IERC721Receiver, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Sentinel `lockUntil` meaning "never expires". Chosen at creation or reached via `extend`.
    uint64 public constant PERMANENT = type(uint64).max;

    /// @notice Burn address for the launch-token side of a reclaimed position.
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @notice Ceiling on the creator's share of a position's LP fees: 100%.
    uint16 public constant MAX_CREATOR_FEE_BPS = 10_000;

    /// @notice The V3 NonfungiblePositionManager holding the actual position state.
    INonfungiblePositionManager public immutable positionManager;

    /// @notice The launchpad factory; source of the treasury, the owner, and each launch's creator.
    address public immutable launchpad;

    /// @notice How long a graduated pool must go without a swap before an EXPIRED lock can be
    ///         reclaimed. Read live at `reclaim` time, hence the monotonic setter below.
    uint32 public inactivityPeriod = 180 days;

    /// @notice tokenId => its lock terms.
    mapping(uint256 => LockRecord) internal _locks;

    event LockRegistered(
        uint256 indexed tokenId,
        address indexed launchToken,
        address indexed pool,
        LockOrigin origin,
        uint64 lockUntil,
        uint16 creatorFeeBps
    );
    event LockExtended(uint256 indexed tokenId, uint64 oldLockUntil, uint64 newLockUntil);
    event FeesCollected(
        uint256 indexed tokenId,
        address indexed treasury,
        address indexed creator,
        uint256 treasuryAmount0,
        uint256 treasuryAmount1,
        uint256 creatorAmount0,
        uint256 creatorAmount1
    );
    event Reclaimed(uint256 indexed tokenId, address indexed launchToken, uint256 ethAmount, uint256 tokensBurned);
    event InactivityPeriodUpdated(uint32 oldPeriod, uint32 newPeriod);

    error ZeroAddress();
    error NotGraduationManager();
    error NotLaunchCreator();
    error AlreadyLocked();
    error UnknownLock();
    error InvalidCreatorFee();
    error CannotShortenLock();
    error NotReclaimable();
    error AlreadyReclaimed();
    error LockNotExpired();
    error PoolStillActive();
    error CannotShortenInactivityPeriod();
    error NotOwner();

    constructor(address positionManager_, address launchpad_) {
        if (positionManager_ == address(0) || launchpad_ == address(0)) revert ZeroAddress();
        positionManager = INonfungiblePositionManager(positionManager_);
        launchpad = launchpad_;
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @notice The lock terms for `tokenId`. An unregistered id reads as `origin == None`.
    function lockOf(uint256 tokenId) external view returns (LockRecord memory) {
        return _locks[tokenId];
    }

    /// @notice Seconds since the pool last recorded an observation, i.e. since it was last swapped.
    /// @dev ⚠️ Two mechanical traps live in these five lines.
    ///
    ///      (1) The observation timestamp is a `uint32` that wraps roughly every 136 years, and the
    ///      pool's own comparisons are overflow-safe by construction. Subtracting it from
    ///      `block.timestamp` in checked 256-bit arithmetic is wrong across the wrap - it would
    ///      underflow and revert, permanently bricking `reclaim` for every position. The subtraction
    ///      is therefore done in `unchecked` uint32 arithmetic, which is modular and yields the true
    ///      elapsed time for any gap under 2^32 seconds. This is exactly V3's own oracle convention.
    ///
    ///      (2) The index comes from `slot0`, never a hardcoded 0. Cardinality is 1 on every pool we
    ///      create, but `increaseObservationCardinalityNext` is permissionless, so any third party can
    ///      grow the ring buffer and leave slot 0 holding a stale timestamp forever.
    ///
    ///      Note mints and burns also write an observation, so a dust liquidity change counts as
    ///      activity. That is an accepted definition of "the pool is still responsive".
    function secondsSincePoolActivity(address pool) public view returns (uint32) {
        // `unused-return` x2: both are destructures of multi-value V3 getters where only the named
        // fields matter. Reading the rest would cost stack slots and say nothing.
        // slither-disable-next-line unused-return
        (,, uint16 observationIndex,,,,) = IUniswapV3Pool(pool).slot0();
        // slither-disable-next-line unused-return
        (uint32 lastTs,,, bool initialized) = IUniswapV3Pool(pool).observations(observationIndex);
        // An uninitialized observation means we cannot date the pool's last activity, so it reads as
        // maximally recent. Failing CLOSED here is deliberate: the alternative would let an unreadable
        // oracle satisfy reclaim's decisive guard.
        if (!initialized) return 0;
        unchecked {
            return uint32(block.timestamp) - lastTs;
        }
    }

    /// @notice Why `reclaim(tokenId)` would fail right now, or `NoBlocker` if it would succeed.
    /// @dev The single source of truth for reclaim's conditions. `reclaim` reverts on whatever this
    ///      returns and `isReclaimable` just tests it for `NoBlocker`, so the two can never drift -
    ///      previously they were two hand-copied cascades of the same four conditions, which is a
    ///      silent-divergence risk on the one code path that moves locked principal.
    function reclaimBlocker(uint256 tokenId) public view returns (ReclaimBlocker) {
        LockRecord storage r = _locks[tokenId];
        if (r.origin != LockOrigin.Launch) return ReclaimBlocker.NotALaunchPosition;
        if (r.reclaimed) return ReclaimBlocker.AlreadyReclaimedBlocker;
        if (r.lockUntil == PERMANENT) return ReclaimBlocker.PermanentLock;
        // ⚠️ Suppressed deliberately, and the reason is chain-specific rather than general. On an
        // Arbitrum Orbit chain `block.number` is an L1 estimate and is explicitly NOT a clock
        // (`lib/evm-security-standards/profiles/robinhood-4663.md` §1), so `block.timestamp` is the
        // only clock available - the lint's implied alternative does not exist here. The manipulation
        // it warns about is also not a threat at this scale: the guard is a one-year lock followed by
        // 180 days of pool inactivity, and a sequencer able to skew the clock by a few seconds cannot
        // reach either boundary. `secondsSincePoolActivity` above deliberately fails closed for the
        // same guard, which is where the real risk sits.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp <= r.lockUntil) return ReclaimBlocker.NotExpired;
        if (secondsSincePoolActivity(r.pool) < inactivityPeriod) return ReclaimBlocker.PoolActive;
        return ReclaimBlocker.NoBlocker;
    }

    /// @notice Whether `reclaim(tokenId)` would succeed right now.
    function isReclaimable(uint256 tokenId) external view returns (bool) {
        return reclaimBlocker(tokenId) == ReclaimBlocker.NoBlocker;
    }

    /// @dev The launch's creator, read live from the launchpad so a single lookup shape is used
    ///      everywhere the creator matters.
    function _creatorOf(address launchToken) private view returns (address) {
        return ILaunchpadLockView(launchpad).creatorOf(launchToken);
    }

    // ---------------------------------------------------------------------------------------------
    // Locking
    // ---------------------------------------------------------------------------------------------

    /// @notice Record the terms for a position the GraduationManager has just minted into this lock.
    /// @dev Called by the GraduationManager in the same transaction as the mint. The NFT arrives via a
    ///      bare NPM mint, which tells this contract nothing at all, so registration is the only way it
    ///      ever learns the tokenId, the launch token, the pool or the terms.
    function registerLock(uint256 tokenId, address launchToken, address pool, uint64 lockUntil, uint16 creatorFeeBps)
        external
    {
        if (msg.sender != ILaunchpadLockView(launchpad).graduationManager()) revert NotGraduationManager();
        if (launchToken == address(0) || pool == address(0)) revert ZeroAddress();
        if (creatorFeeBps > MAX_CREATOR_FEE_BPS) revert InvalidCreatorFee();
        LockRecord storage r = _locks[tokenId];
        if (r.origin != LockOrigin.None) revert AlreadyLocked();

        r.launchToken = launchToken;
        r.pool = pool;
        r.origin = LockOrigin.Launch;
        r.lockUntil = lockUntil;
        r.lockedAt = uint64(block.timestamp);
        r.creatorFeeBps = creatorFeeBps;

        emit LockRegistered(tokenId, launchToken, pool, LockOrigin.Launch, lockUntil, creatorFeeBps);
    }

    /// @notice Extend a lock. Monotonic: the new expiry must be strictly later than the current one,
    ///         so a lock's terms can only ever become MORE favourable to holders. Passing `PERMANENT`
    ///         makes it permanent, which is terminal.
    /// @dev Creator-only. Extending is strictly safer for traders, but it is not harmless to make it
    ///      permissionless: a stranger could extend indefinitely and so deny the treasury a reclaim it
    ///      would otherwise be entitled to.
    function extend(uint256 tokenId, uint64 newLockUntil) external {
        LockRecord storage r = _locks[tokenId];
        if (r.origin == LockOrigin.None) revert UnknownLock();
        if (r.reclaimed) revert AlreadyReclaimed();
        if (msg.sender != _creatorOf(r.launchToken)) revert NotLaunchCreator();
        if (newLockUntil <= r.lockUntil) revert CannotShortenLock();

        emit LockExtended(tokenId, r.lockUntil, newLockUntil);
        r.lockUntil = newLockUntil;
    }

    // ---------------------------------------------------------------------------------------------
    // Fees
    // ---------------------------------------------------------------------------------------------

    /// @notice Collect a locked position's accrued trading fees and route them to the treasury and,
    ///         for launch positions, to the launch's creator.
    ///
    /// @dev Permissionless throughout the life of the lock - anyone can trigger a collection, but the
    ///      funds can only ever reach the two fixed destinations, never the caller. Principal is
    ///      untouched.
    ///
    ///      The creator's share is `creatorFeeBps` of the LP fees THIS position earned, which is the
    ///      pool's 0.75% LP share (the pool's other 0.25% is the protocol fee and is swept separately
    ///      by the factory, entirely to treasury). Splitting the LP share rather than promising a
    ///      percentage of raw swap volume is what keeps the promise payable: as third-party liquidity
    ///      joins the pool, this position earns proportionally less, and a fraction of "what we
    ///      actually collected" scales down with it while a fraction of volume would not.
    ///
    ///      Third-party locks (origin `ThirdParty`) have no launch creator, so 100% goes to treasury.
    function collect(uint256 tokenId) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        LockRecord storage r = _locks[tokenId];
        address treasury = ILaunchpadLockView(launchpad).treasury();

        // Collect to this contract first so the split can be applied. Pre-#33 this went straight to
        // the treasury via the recipient parameter.
        (amount0, amount1) = positionManager.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId, recipient: address(this), amount0Max: type(uint128).max, amount1Max: type(uint128).max
            })
        );

        // ⚠️ Explicitly zero rather than defaulted, because the zero values are the LOAD-BEARING
        // case: they are what "this position has no creator share" means, and they are what a
        // third-party lock and a `creatorFeeBps` of zero both fall through to. `FeeCollection.creator`
        // in the subgraph reads this zero address as null for the same reason. A defaulted zero and a
        // forgotten assignment look identical here, on the split that decides where money goes.
        address creator = address(0);
        uint256 creator0 = 0;
        uint256 creator1 = 0;
        if (r.origin == LockOrigin.Launch && r.creatorFeeBps > 0) {
            creator = _creatorOf(r.launchToken);
            if (creator != address(0)) {
                creator0 = (amount0 * r.creatorFeeBps) / MAX_CREATOR_FEE_BPS;
                creator1 = (amount1 * r.creatorFeeBps) / MAX_CREATOR_FEE_BPS;
            }
        }

        // The position's own tokens, read from the NPM rather than the record, so this still works for
        // any position type. Rounding on the split favours the treasury by construction (floor).
        // `unused-return`: only the pair is needed. NPM's `positions` returns twelve fields.
        // slither-disable-next-line unused-return
        (,, address token0, address token1,,,,,,,,) = positionManager.positions(tokenId);
        _payOut(token0, treasury, creator, amount0 - creator0, creator0);
        _payOut(token1, treasury, creator, amount1 - creator1, creator1);

        emit FeesCollected(tokenId, treasury, creator, amount0 - creator0, amount1 - creator1, creator0, creator1);
    }

    function _payOut(address token, address treasury, address creator, uint256 toTreasury, uint256 toCreator) private {
        if (toTreasury > 0) IERC20(token).safeTransfer(treasury, toTreasury);
        if (toCreator > 0) IERC20(token).safeTransfer(creator, toCreator);
    }

    // ---------------------------------------------------------------------------------------------
    // Reclaim
    // ---------------------------------------------------------------------------------------------

    /// @notice Wind up an expired lock on a pool that has gone quiet: drain the position, burn the
    ///         launch tokens, and route the paired WETH to the treasury.
    ///
    /// @dev Permissionless, and gated on FOUR conditions, all of which must hold:
    ///      1. `origin == Launch` - third-party locked liquidity can never be swept. This is why the
    ///         enum reserves zero for `None`.
    ///      2. not already reclaimed.
    ///      3. the lock has expired and is not permanent.
    ///      4. the pool has had no swap (nor mint/burn) for at least `inactivityPeriod`.
    ///
    ///      ⚠️ Condition 4 is not decoration and must never be relaxed to a pure calendar test. A
    ///      graduated position is the COUNTERPARTY to every trade, not a vault holding the raise: a
    ///      healthy pool's position is worth ~10 ETH while a fully-exited one is worth ~2 ETH. A
    ///      time-only unlock right would therefore be worth 5x more when abused than when used as
    ///      intended. Gating on measured inactivity is what inverts that.
    ///
    ///      The launch tokens are burned rather than sold, because selling a billion tokens into the
    ///      pool we are simultaneously draining would be an exit at a price we ourselves destroy.
    function reclaim(uint256 tokenId) external nonReentrant returns (uint256 ethAmount, uint256 tokensBurned) {
        ReclaimBlocker blocker = reclaimBlocker(tokenId);
        if (blocker == ReclaimBlocker.AlreadyReclaimedBlocker) revert AlreadyReclaimed();
        if (blocker == ReclaimBlocker.NotExpired) revert LockNotExpired();
        if (blocker == ReclaimBlocker.PoolActive) revert PoolStillActive();
        // NotALaunchPosition and PermanentLock both mean "this position is not the kind of thing
        // reclaim can ever touch", which is one condition to a caller.
        if (blocker != ReclaimBlocker.NoBlocker) revert NotReclaimable();

        LockRecord storage r = _locks[tokenId];
        r.reclaimed = true; // effects before interactions; also makes reclaim single-shot

        // `unused-return`: only `liquidity` is needed from the twelve fields.
        // slither-disable-next-line unused-return
        (,,,,,,, uint128 liquidity,,,,) = positionManager.positions(tokenId);
        if (liquidity > 0) {
            // ⚠️ `unused-return`: `decreaseLiquidity` returns the amounts it moved into the position's
            // owed balance, and ignoring them is deliberate rather than lax. What is actually swept is
            // whatever `collect` returns immediately below - principal AND any uncollected fees - and
            // that is the figure the burn and the treasury transfer use. Trusting the earlier return
            // instead would silently drop the fee half.
            // slither-disable-next-line unused-return
            positionManager.decreaseLiquidity(
                INonfungiblePositionManager.DecreaseLiquidityParams({
                    tokenId: tokenId,
                    liquidity: liquidity,
                    // No slippage floor, deliberately: this is a wind-up of a pool that has had no
                    // activity for at least `inactivityPeriod`, and the launch-token side is burned
                    // rather than sold, so there is no price to be sandwiched on.
                    amount0Min: 0,
                    amount1Min: 0,
                    deadline: block.timestamp
                })
            );
        }
        // Sweeps principal AND any uncollected fees in one call; the amounts returned are exact, so
        // this never depends on this contract's balance (which a donation could otherwise inflate).
        (uint256 amount0, uint256 amount1) = positionManager.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId, recipient: address(this), amount0Max: type(uint128).max, amount1Max: type(uint128).max
            })
        );

        // The non-launch side of the pair is WETH by construction (GraduationManager only ever creates
        // TOKEN/WETH pools), so it is derived from the pool rather than needing a stored address.
        address launchToken = r.launchToken;
        address token0 = IUniswapV3Pool(r.pool).token0();
        address weth = token0 == launchToken ? IUniswapV3Pool(r.pool).token1() : token0;
        (tokensBurned, ethAmount) = token0 == launchToken ? (amount0, amount1) : (amount1, amount0);

        // Position is empty and its fees are cleared, so burn() is guaranteed to pass.
        positionManager.burn(tokenId);

        if (tokensBurned > 0) IERC20(launchToken).safeTransfer(DEAD, tokensBurned);
        if (ethAmount > 0) {
            IERC20(weth).safeTransfer(ILaunchpadLockView(launchpad).treasury(), ethAmount);
        }

        emit Reclaimed(tokenId, launchToken, ethAmount, tokensBurned);
    }

    // ---------------------------------------------------------------------------------------------
    // Owner params
    // ---------------------------------------------------------------------------------------------

    /// @notice Retune the inactivity period required before an expired lock can be reclaimed.
    /// @dev ⚠️ MONOTONIC - lengthen only. This is the one lock term read live rather than frozen per
    ///      position, which makes it the sharpest retroactive lever in the protocol: shortening it
    ///      would bring forward the moment every EXISTING lock becomes reclaimable, changing the terms
    ///      of positions that already exist. Refusing to shorten means a creator can verify from the
    ///      bytecode that their lock's terms can only ever move in their favour.
    ///
    ///      The accepted cost is that a mistake is permanent: setting five years by accident cannot be
    ///      undone. That is the same trade `extend` already makes.
    function setInactivityPeriod(uint32 newPeriod) external {
        if (msg.sender != ILaunchpadLockView(launchpad).owner()) revert NotOwner();
        if (newPeriod < inactivityPeriod) revert CannotShortenInactivityPeriod();
        emit InactivityPeriodUpdated(inactivityPeriod, newPeriod);
        inactivityPeriod = newPeriod;
    }

    /// @notice Accept position NFTs (via safe transfer or mint).
    /// @dev ⚠️ Accepting an NFT does NOT create a lock record. An unregistered position reads as
    ///      `origin == None`, which fails every guard in `reclaim` - so a stray or hostile transfer
    ///      into this contract is inert, not reclaimable. That is the intended behaviour, and it is
    ///      the reason `None` and not `Launch` occupies the enum's zero slot.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}
