// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IGraduationView {
    /// @dev Unix timestamp of a launch's graduation, or 0 if it has not graduated. Zero is the whole
    ///      vesting gate: it is what makes "vests from graduation" a fact about state rather than a
    ///      policy this contract has to remember to apply.
    function graduatedAt(address token) external view returns (uint64);
}

/// @notice One creator's vesting grant. Every term is frozen at `createLaunch` and nothing in this
///         contract can change any of them afterwards - there is no setter, for anyone.
/// @dev `total` and `claimed` are `uint128` because the largest grant this protocol can ever mint is
///      5% of an 800M curve supply (40e24), about 14 orders of magnitude below `uint128`'s ceiling.
///      `registerGrant` rejects anything that would not fit rather than casting on faith.
struct VestingGrant {
    // --- slot 0 (28 bytes) ---
    address creator; // the ONLY address a claim can ever pay
    uint64 duration; // linear release window, measured from graduation
    // --- slot 1 (32 bytes) ---
    uint128 total;
    uint128 claimed;
}

/// @notice Custodian for the creators' dev allocations, released linearly from GRADUATION (#35).
///
/// @dev Build #34 carved the dev allocation out of the curve supply and left it sitting in the
///      factory with no withdrawal path at all. This contract is that path, and it is the only one:
///      the factory transfers each carve here at `createLaunch` and still has no function that can
///      move a launch token anywhere.
///
///      ⚠️ **Vesting starts at graduation, never at creation, and that is the load-bearing decision.**
///      Most launches never graduate. A schedule running from creation would let the creator of a
///      dying curve claim tokens and sell them straight back into the curve, extracting the very ETH
///      other buyers put in - value taken from the people still holding, at a moment when the project
///      has already failed. Running from graduation means a grant on a launch that never makes it is
///      never claimable at all, and the tokens stay here permanently. That is the intended outcome,
///      not an oversight: it is the same thing as those tokens never having been minted into
///      circulation.
///
///      ⚠️ **Linear, not a cliff, and it delays the price impact rather than preventing it.** A cliff
///      concentrates the entire move into one transaction. `docs/tokenomics.md` measures a full 5%
///      allocation sold into a freshly graduated pool at roughly **-30.6%**, and no schedule changes
///      that number at the end of the window - only how fast it can arrive.
///
///      **Three structural properties, each verifiable from the bytecode rather than promised:**
///
///      1. **No function takes a recipient.** `claim` pays `grant.creator`, frozen at creation, and
///         that is the only transfer in this contract. Nothing here can pay the caller, the owner or
///         a chosen address, so `claim` is left permissionless - anyone may trigger a release, but it
///         can only ever land in one place. This is the same shape `LPLock.collect` uses.
///      2. **One launch can never reach another's tokens.** Every payout is
///         `IERC20(token).safeTransfer` on the grant's own key, so a grant for token A moves only
///         token A. Cross-launch drainage is not guarded against, it is unrepresentable.
///      3. **There is no owner, no sweep, no upgrade and no rescue.** The vesting duration is an owner
///         parameter on the FACTORY, frozen into each grant at creation, so retuning it can never
///         reach a grant that already exists.
///
///      Accounting is per grant and never reads `balanceOf`, so tokens donated to this contract are
///      inert: they inflate no schedule and are claimable by nobody. That mirrors
///      `GraduationManager` seeding the reserve constant rather than its live balance.
contract DevVesting is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The launchpad factory. The only address that can register a grant.
    address public immutable launchpad;

    /// @notice Source of each launch's graduation timestamp, i.e. of every schedule's start.
    /// @dev Immutable, and deliberately NOT a live read off the factory: the factory's own
    ///      `graduationManager` is immutable too, so a live read could never return anything else,
    ///      and this saves an external call on a view the UI polls.
    IGraduationView public immutable graduationManager;

    /// @notice token => the creator's grant.
    mapping(address => VestingGrant) internal _grants;

    event GrantRegistered(address indexed token, address indexed creator, uint256 amount, uint64 duration);
    event Claimed(address indexed token, address indexed creator, uint256 amount, uint256 remaining);

    error ZeroAddress();
    error NotLaunchpad();
    error AlreadyGranted();
    error InvalidGrant();
    error UnknownGrant();
    error NothingToClaim();

    constructor(address launchpad_, address graduationManager_) {
        if (launchpad_ == address(0) || graduationManager_ == address(0)) revert ZeroAddress();
        launchpad = launchpad_;
        graduationManager = IGraduationView(graduationManager_);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @notice The grant for `token`. An unregistered token reads as an all-zero grant.
    function grantOf(address token) external view returns (VestingGrant memory) {
        return _grants[token];
    }

    /// @notice When `token`'s schedule starts, or 0 if it has not graduated and so has not started.
    function vestingStart(address token) public view returns (uint64) {
        return graduationManager.graduatedAt(token);
    }

    /// @notice Total tokens released to date, claimed or not. Zero until the launch graduates.
    /// @dev Multiply-before-divide, so the schedule truncates exactly once and always downward. The
    ///      `elapsed >= duration` branch returns `total` exactly rather than letting that final
    ///      division decide, which is what guarantees a grant vests to the last wei instead of
    ///      stranding dust here forever.
    function vestedAmount(address token) public view returns (uint256) {
        VestingGrant storage g = _grants[token];
        if (g.total == 0) return 0;

        uint64 start = vestingStart(token);
        if (start == 0) return 0; // not graduated: nothing has vested, and nothing ever will until it does

        uint256 elapsed = block.timestamp - start; // `start` is always a past timestamp
        if (elapsed >= g.duration) return g.total;
        return (uint256(g.total) * elapsed) / g.duration;
    }

    /// @notice Tokens claimable right now: what has vested, less what has already been taken.
    function claimable(address token) public view returns (uint256) {
        return vestedAmount(token) - _grants[token].claimed;
    }

    // ---------------------------------------------------------------------------------------------
    // Registration
    // ---------------------------------------------------------------------------------------------

    /// @notice Record a creator's grant. Called by the factory inside `createLaunch`, in the same
    ///         transaction that transfers the tokens here.
    /// @dev Factory-only and single-shot per token. The factory checks nothing about this call's
    ///      arguments on its side, so every bound a grant depends on is enforced here, where it is
    ///      provable from this function alone.
    ///
    ///      The creator is stored rather than read live from `launchpad.creatorOf`. Both are immutable
    ///      per launch today, so the two can never disagree; storing it means a claim's destination is
    ///      fixed in this contract's own state, which is what makes property 1 above readable without
    ///      trusting a second contract.
    function registerGrant(address token, address creator, uint256 amount, uint64 duration) external {
        if (msg.sender != launchpad) revert NotLaunchpad();
        if (token == address(0) || creator == address(0)) revert ZeroAddress();
        // A zero duration would divide by zero in `vestedAmount`; a zero amount is not a grant. The
        // factory never sends either, and this is what makes that irrelevant.
        if (amount == 0 || amount > type(uint128).max || duration == 0) revert InvalidGrant();

        VestingGrant storage g = _grants[token];
        if (g.total != 0) revert AlreadyGranted();

        g.creator = creator;
        g.duration = duration;
        // Safe: the `amount > type(uint128).max` check three lines up is what makes it safe, and it is
        // in this same function precisely so the cast never depends on a caller's discipline.
        // forge-lint: disable-next-line(unsafe-typecast)
        g.total = uint128(amount);

        emit GrantRegistered(token, creator, amount, duration);
    }

    // ---------------------------------------------------------------------------------------------
    // Claiming
    // ---------------------------------------------------------------------------------------------

    /// @notice Release everything vested and unclaimed for `token` to that launch's creator.
    /// @dev Permissionless, because the destination is not a parameter - see property 1 on the
    ///      contract. Effects before interactions, and `nonReentrant` on top: `LaunchToken` is a plain
    ///      OpenZeppelin ERC-20 with no transfer hooks, but this contract holds every creator's
    ///      allocation across every launch, which is not a balance to defend with an argument about
    ///      what the token currently does.
    function claim(address token) external nonReentrant returns (uint256 amount) {
        VestingGrant storage g = _grants[token];
        if (g.total == 0) revert UnknownGrant();

        amount = claimable(token);
        if (amount == 0) revert NothingToClaim();

        // Safe: `amount` is `claimable` == `vested - claimed`, and `vestedAmount` returns at most
        // `g.total`, which is a uint128. So the sum is bounded by `g.total` and cannot truncate. The
        // `+=` stays checked, so a defect in that reasoning reverts rather than wrapping.
        // forge-lint: disable-next-line(unsafe-typecast)
        g.claimed += uint128(amount);
        address creator = g.creator;

        IERC20(token).safeTransfer(creator, amount);

        emit Claimed(token, creator, amount, g.total - g.claimed);
    }
}
