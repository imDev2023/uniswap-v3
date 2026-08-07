// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {HandlerBase} from "../../lib/evm-security-standards/templates/handlers/HandlerBase.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {DevVesting} from "../../src/periphery/DevVesting.sol";

/// @notice What the fuzzer is allowed to do to Octopus (#40).
///
/// @dev The property mixins in `OctopusInvariants.t.sol` say what must stay true. This says what may
///      happen. Without it Foundry calls the contracts with random calldata from random addresses,
///      almost every call reverts on input validation, and the campaign explores nothing.
///
///      ⚠️ **Two curves, deliberately, and they are not interchangeable.**
///
///      - `feeCurve` charges the default 1% trade fee. It carries the trading, the donations and the
///        conservation properties.
///      - `zeroFeeCurve` was created after `setCurveParams(..., tradeFeeBps = 0, ...)` and exists for
///        the rounding property alone. #35a proved why: mutating `_previewSell`'s `Math.ceilDiv` to a
///        floor - rounding in the seller's favour, the classic AMM money pump - does NOT fail a
///        round-trip test on a fee-charging curve, because a 1% fee on each leg dwarfs a one-wei
///        rounding error and the trip stays unprofitable anyway. With the fee at zero, rounding is
///        the only thing between a trader and free ETH, so the property has nothing to hide behind.
///        A rounding campaign run only against `feeCurve` would be green and empty.
///
///      ⚠️ **The anti-snipe window is lifted in `setUp`, before the campaign starts.** Left active,
///      the per-wallet cap rejects most buys, the campaign spends itself on `BuyCapExceeded` and the
///      reserves never move far enough for a rounding or conservation defect to express itself. The
///      cap has its own suite in `AntiSnipe.t.sol` and is not what this campaign is for.
///
///      ⚠️ **Buys are bounded small enough that `feeCurve` stays live.** A crossing buy graduates the
///      curve and every entry point reverts afterwards, which would leave most of the remaining
///      depth doing nothing. `Graduation.t.sol` owns that transition. The bound is stated against the
///      curve's own remaining need rather than a literal, because a literal buy size is exactly the
///      coupling to the calibration that broke nine tests in #34.
contract OctopusHandler is HandlerBase {
    BondingCurve public immutable feeCurve;
    BondingCurve public immutable zeroFeeCurve;
    IERC20 public immutable feeToken;
    IERC20 public immutable zeroFeeToken;

    DevVesting public immutable devVesting;
    /// @dev The graduated launch, and the only one whose vesting schedule is running.
    address public immutable vestedToken;

    /// @notice Total ETH actors have sent into either curve, and total they have received back.
    /// @dev Ghosts, because neither curve tracks a lifetime figure. `afterInvariant` uses them to
    ///      prove the campaign moved money rather than spinning on reverts.
    uint256 public ghostEthIn;
    uint256 public ghostEthOut;
    /// @notice ETH returned by `sell` specifically.
    /// @dev ⚠️ Separate from `ghostEthOut`, which `buy` also credits when a crossing buy refunds its
    ///      overflow. One counter cannot tell "the sell path ran" from "a buy handed change back", so
    ///      an assertion on `ghostEthOut` cannot say what it claims. The two paths are counted apart.
    uint256 public ghostSellProceeds;
    /// @notice Launch tokens force-donated into a curve, which conservation must tolerate.
    uint256 public ghostTokensDonated;
    /// @notice Wei force-fed into a curve past its own accounting.
    uint256 public ghostEthForced;

    /// @notice How many handler calls this sequence has made, successful or not.
    /// @dev ⚠️ Exists so `afterInvariant` can tell a real run from a shrunk replay. When an
    ///      `afterInvariant` assertion fails, Foundry replays a MINIMAL sequence and evaluates the
    ///      assertions against that, so every coverage check fails on the replay whatever the original
    ///      cause was - and only the first one is reported. Without this counter the report is always
    ///      "the fuzzer never reached some handler function: 1 < 5", which names the wrong assertion,
    ///      about a one-call sequence that was never the problem.
    uint256 public totalCalls;

    constructor(BondingCurve feeCurve_, BondingCurve zeroFeeCurve_, DevVesting devVesting_, address vestedToken_)
        HandlerBase(4)
    {
        feeCurve = feeCurve_;
        zeroFeeCurve = zeroFeeCurve_;
        feeToken = feeCurve_.token();
        zeroFeeToken = zeroFeeCurve_.token();
        devVesting = devVesting_;
        vestedToken = vestedToken_;
    }

    function _pick(uint256 seed) private view returns (BondingCurve curve, IERC20 tok) {
        if (seed % 2 == 0) return (feeCurve, feeToken);
        return (zeroFeeCurve, zeroFeeToken);
    }

    // ---------------------------------------------------------------------------------------------
    // Trading
    // ---------------------------------------------------------------------------------------------

    function buy(uint256 actorSeed, uint256 curveSeed, uint256 ethSeed) external useActor(actorSeed) {
        _count("buy");
        totalCalls += 1;
        (BondingCurve curve,) = _pick(curveSeed);
        if (curve.graduated()) return;

        // Derived from the curve, never a literal. `finalEthReserve - ethReserve` is exactly the net
        // ETH still needed to close it, so a tenth of that can never be the crossing buy however the
        // calibration is retuned. The floor is the dust level below which the curve rounds to zero
        // tokens out and reverts, which is a real branch but not one worth spending depth on.
        uint256 headroom = (curve.finalEthReserve() - curve.ethReserve()) / 10;
        if (headroom < 0.0001 ether) return;
        uint256 ethIn = bound(ethSeed, 0.0001 ether, headroom);

        vm.deal(_currentActor, _currentActor.balance + ethIn);
        uint256 before = _currentActor.balance;
        try curve.buy{value: ethIn}(0) {
            ghostEthIn += ethIn;
            // A crossing buy refunds the overflow, so what actually left the wallet is the delta, not
            // `ethIn`. Nothing here can cross, but reading the delta means that stays true if the
            // bound above is ever loosened.
            ghostEthOut += _currentActor.balance + ethIn - before;
        } catch {}
    }

    function sell(uint256 actorSeed, uint256 curveSeed, uint256 pctSeed) external useActor(actorSeed) {
        _count("sell");
        totalCalls += 1;
        (BondingCurve curve, IERC20 tok) = _pick(curveSeed);
        if (curve.graduated()) return;

        uint256 held = tok.balanceOf(_currentActor);
        if (held == 0) return;
        uint256 amount = bound(pctSeed, 1, held);

        tok.approve(address(curve), amount);
        uint256 before = _currentActor.balance;
        try curve.sell(amount, 0) {
            uint256 received = _currentActor.balance - before;
            ghostEthOut += received;
            ghostSellProceeds += received;
        } catch {}
    }

    // ---------------------------------------------------------------------------------------------
    // Donations
    // ---------------------------------------------------------------------------------------------

    /// @notice Transfer launch tokens straight into a curve, past its accounting.
    /// @dev ⚠️ This is why every backing ledger is `exact: false`. A donation is not a bug, and a
    ///      conservation check written as `==` on a balance anyone can top up is a false alarm waiting
    ///      for its first donor. Marking it exact and marking it inexact are BOTH mistakes, in
    ///      opposite directions, which is why the handler makes the donation actually happen rather
    ///      than leaving the question theoretical.
    function donateTokens(uint256 actorSeed, uint256 curveSeed, uint256 pctSeed) external useActor(actorSeed) {
        _count("donateTokens");
        totalCalls += 1;
        (BondingCurve curve, IERC20 tok) = _pick(curveSeed);

        uint256 held = tok.balanceOf(_currentActor);
        if (held == 0) return;
        // At most 1% of the holding, so a donation perturbs an actor's position rather than closing
        // it. Bounding this to the whole balance would let donations compete with `sell` for the same
        // tokens, which is not what this function is here to test.
        //
        // ⚠️ Recorded because the obvious story about this line is FALSE. It was introduced believing
        // it fixed a campaign where none of 681 sell calls ever executed; it did not. Reverting the
        // cap and re-running leaves both `test_handlerExercisesEveryPath` and the per-run sell-path
        // assertion behaving exactly as before. The real explanation is in `afterInvariant`: a single
        // run is about ten sell calls, each needs the chosen actor to already hold the chosen curve's
        // token, and a run where none line up is ordinary. The cap is a reasonable bound and nothing
        // more - it is not what makes the sell path reachable.
        uint256 amount = bound(pctSeed, 1, held / 100 + 1);

        // Return value checked rather than ignored: `deny = "warnings"` makes forge's
        // `erc20-unchecked-transfer` lint fail the build, and a donation that silently did not happen
        // would leave the conservation ledgers testing the case they were written to survive.
        require(tok.transfer(address(curve), amount), "donation transfer failed");
        ghostTokensDonated += amount;
    }

    /// @notice Force ETH into a curve past every entry point it has.
    /// @dev `BondingCurve` has no `receive` and no `fallback`, so a plain send cannot do this - which
    ///      is exactly why it is done with `vm.deal` instead. `selfdestruct` can reach any address
    ///      regardless, and this is what that looks like from the outside. The claim under test is the
    ///      one in `_graduate`'s comment: the seed uses the CALIBRATED raise, not the live balance, so
    ///      force-fed ETH cannot inflate it or break price continuity.
    function forceEth(uint256 curveSeed, uint256 amountSeed) external {
        _count("forceEth");
        totalCalls += 1;
        (BondingCurve curve,) = _pick(curveSeed);
        uint256 amount = bound(amountSeed, 1, 1 ether);
        vm.deal(address(curve), address(curve).balance + amount);
        ghostEthForced += amount;
    }

    // ---------------------------------------------------------------------------------------------
    // Time and vesting
    // ---------------------------------------------------------------------------------------------

    /// @notice Advance the clock.
    /// @dev Without this the campaign explores exactly one instant of the vesting schedule and every
    ///      solvency check evaluates the same fraction. That is the "green and empty" failure the
    ///      templates warn about: a schedule that never moves cannot over-release.
    function advanceTime(uint256 secondsSeed) external {
        _count("advanceTime");
        totalCalls += 1;
        vm.warp(block.timestamp + bound(secondsSeed, 1 hours, 10 days));
    }

    /// @notice Release whatever has vested on the graduated launch.
    /// @dev ⚠️ Called AS a random actor, who is never the beneficiary - the creators are not in the
    ///      actor set. `claim` is permissionless and pays `grant.creator`, a destination fixed at
    ///      creation, so a test whose caller is also the payee cannot see a payout misrouted to
    ///      `msg.sender`. Every #35 vesting test that claimed as the creator stayed green when `claim`
    ///      was mutated to pay the caller; only the one claiming from a stranger caught it.
    function claimVesting(uint256 actorSeed) external useActor(actorSeed) {
        _count("claimVesting");
        totalCalls += 1;
        try devVesting.claim(vestedToken) {} catch {}
    }
}
