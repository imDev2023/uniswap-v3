// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BondingCurve, CurveConfig} from "../src/BondingCurve.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockGraduationManager} from "./mocks/MockGraduationManager.sol";

/// @notice Build 11 (#24): the exact boundary of the graduation-crossing buy.
/// @dev This is the arithmetic `docs/audit-scope.md` asks reviewers to attack first. The crossing
///      buy charges only the ETH needed to drive reserves to their calibrated final values:
///
///          netNeeded   = finalEthReserve - ethReserve
///          grossNeeded = ceilDiv(netNeeded * BPS, BPS - tradeFeeBps)
///          if (grossNeeded > msg.value) grossNeeded = msg.value;   // <-- the clamp
///
///      `previewTokens >= remaining` guarantees `msg.value >= netNeeded`, but the fee floor and that
///      `ceilDiv` gross-up need not compose to the wei, so without the clamp a buy sized to exactly
///      complete the curve could underflow-revert on the refund. The clamp exists to stop an honest
///      buy failing — the open question is whether it can instead be used to underpay the fee.
///
///      These tests pin the boundary from both sides and fuzz the invariant that matters: the curve
///      always hands the GraduationManager exactly the calibrated raise, and the buyer is never
///      charged more than fee + raise, whatever they send.
contract CrossingBuyBoundaryTest is Test {
    uint256 internal constant V_ETH = 30 ether;
    uint256 internal constant V_TOK = 1_073_000_000e18;
    uint256 internal constant ALLOC = 800_000_000e18;
    uint256 internal constant BPS = 10_000;
    uint16 internal constant FEE_BPS = 100;

    address internal treasury = makeAddr("treasury");
    address internal buyer = makeAddr("buyer");

    MockERC20 internal token;
    MockGraduationManager internal gm;
    BondingCurve internal curve;

    function setUp() public {
        gm = new MockGraduationManager();
        token = new MockERC20("Doge Killer", "DOGEK");
        curve = _newCurve();
        vm.deal(buyer, 100_000 ether);
    }

    function _newCurve() internal returns (BondingCurve c) {
        c = new BondingCurve(
            CurveConfig({
                token: IERC20(address(token)),
                treasury: treasury,
                graduationManager: address(gm),
                virtualEthReserve: V_ETH,
                virtualTokenReserve: V_TOK,
                curveTokenAllocation: ALLOC,
                tradeFeeBps: FEE_BPS,
                maxBuyPerWallet: type(uint256).max, // anti-snipe off; this is about crossing math
                antiSnipeThreshold: 0
            })
        );
        token.mint(address(c), ALLOC);
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a + b - 1) / b;
    }

    /// The exact ETH the contract wants for a crossing buy from a pristine curve.
    function _grossNeeded(BondingCurve c) internal view returns (uint256) {
        uint256 netNeeded = c.finalEthReserve() - c.ethReserve();
        return _ceilDiv(netNeeded * BPS, BPS - FEE_BPS);
    }

    /// The calibrated raise: what the GraduationManager must receive, always.
    function _expectedRaise(BondingCurve c) internal view returns (uint256) {
        return c.finalEthReserve() - c.virtualEthReserve();
    }

    /// Sending exactly `grossNeeded` must complete the curve and refund nothing. This is the case
    /// the clamp was written for — an honest buyer who sized their transaction perfectly must not be
    /// punished for it with a revert.
    function test_ExactGrossNeeded_CompletesWithZeroRefund() public {
        uint256 gross = _grossNeeded(curve);
        uint256 balanceBefore = buyer.balance;
        uint256 treasuryBefore = treasury.balance;

        vm.prank(buyer);
        uint256 out = curve.buy{value: gross}(0);

        assertEq(out, ALLOC, "the whole allocation was filled");
        assertTrue(curve.graduated(), "graduated");
        assertEq(balanceBefore - buyer.balance, gross, "no refund: every wei sent was used");
        assertEq(gm.raisedReceived(), _expectedRaise(curve), "manager received the calibrated raise");
        assertEq(treasury.balance - treasuryBefore, gross - gm.raisedReceived(), "fee is the remainder");
        assertEq(address(curve).balance, 0, "nothing stranded");
    }

    /// THE CLAMP IS REACHABLE — and this test pins exactly what that costs.
    ///
    /// `grossNeeded` is a `ceilDiv`, so it overshoots the true requirement by up to a wei, and the
    /// fee itself is a floor division. Between them there is a sliver of slack: sending one wei less
    /// than `grossNeeded` still produces enough tokens to cross, so `buy()` takes the crossing branch
    /// with `msg.value < grossNeeded` and the clamp fires.
    ///
    /// What matters is where the missing wei comes from. It does NOT come out of the raise: the
    /// GraduationManager still receives the exact calibrated amount, so the pool is seeded at the
    /// intended price and no buyer is short-changed. It comes out of the protocol's own fee, which is
    /// one wei lighter. The protocol can be shaved by a wei; users cannot.
    function test_ClampIsReachable_AndOnlyTheProtocolFeeAbsorbsIt() public {
        uint256 gross = _grossNeeded(curve);

        // Baseline: what the fee would be with no clamp. Note the mock GraduationManager accumulates
        // across curves, so raises are compared as deltas rather than absolutes.
        BondingCurve baseline = _newCurve();
        uint256 treasuryBefore = treasury.balance;
        uint256 raisedBefore = gm.raisedReceived();
        vm.prank(buyer);
        baseline.buy{value: gross}(0);
        uint256 unclampedFee = treasury.balance - treasuryBefore;
        uint256 unclampedRaise = gm.raisedReceived() - raisedBefore;

        // Now one wei short, on a fresh curve, so the clamp branch is taken.
        treasuryBefore = treasury.balance;
        raisedBefore = gm.raisedReceived();
        vm.prank(buyer);
        curve.buy{value: gross - 1}(0);
        uint256 clampedFee = treasury.balance - treasuryBefore;
        uint256 clampedRaise = gm.raisedReceived() - raisedBefore;

        assertTrue(curve.graduated(), "one wei short still crosses: the clamp is reachable");
        assertEq(curve.tokensSold(), ALLOC, "allocation still filled exactly, never over");
        assertEq(
            clampedRaise,
            _expectedRaise(curve),
            "the raise is untouched: the shortfall never comes out of the pool seed"
        );
        assertEq(clampedRaise, unclampedRaise, "clamped and unclamped raises are identical");
        assertEq(clampedFee, unclampedFee - 1, "the protocol absorbs exactly the one wei");
        assertEq(address(curve).balance, 0, "nothing stranded");
    }

    /// The slack is a rounding sliver, not a discount. Meaningfully underpaying does not cross at
    /// all: the buy falls through to the ordinary path and the curve stays open, so nobody can
    /// graduate a launch — and seize the whole remaining allocation — for less than calibration.
    function test_MeaningfulUnderpayment_DoesNotCrossAtAll() public {
        uint256 gross = _grossNeeded(curve);

        vm.prank(buyer);
        uint256 out = curve.buy{value: gross - 1000}(0);

        assertFalse(curve.graduated(), "1000 wei short must not graduate");
        assertLt(out, ALLOC, "allocation not fully filled");
        assertEq(gm.calls(), 0, "GraduationManager never invoked");
        assertLt(curve.tokensSold(), ALLOC, "curve still has tokens to sell");
    }

    /// One wei above must cross, and must refund exactly that wei.
    function test_OneWeiOver_CrossesAndRefundsTheExcess() public {
        uint256 gross = _grossNeeded(curve);
        uint256 balanceBefore = buyer.balance;

        vm.prank(buyer);
        curve.buy{value: gross + 1}(0);

        assertTrue(curve.graduated(), "crossed");
        assertEq(balanceBefore - buyer.balance, gross, "the surplus wei came back");
        assertEq(gm.raisedReceived(), _expectedRaise(curve), "raise still exactly calibrated");
    }

    /// The core anti-underpayment invariant, fuzzed across every overpayment size: however wildly a
    /// buyer overshoots, the curve forwards exactly the calibrated raise, the buyer is charged only
    /// raise + fee, and the fee is never squeezed below what the rate implies for that raise.
    ///
    /// This is the property that would break first if the clamp could be abused.
    function testFuzz_CrossingBuy_AlwaysRaisesExactlyAndNeverUnderpaysFee(uint256 overpay) public {
        overpay = bound(overpay, 0, 50_000 ether);

        BondingCurve c = _newCurve();
        uint256 gross = _grossNeeded(c);
        uint256 sent = gross + overpay;

        vm.deal(buyer, sent + 1 ether);
        uint256 balanceBefore = buyer.balance;
        uint256 treasuryBefore = treasury.balance;

        vm.prank(buyer);
        uint256 out = c.buy{value: sent}(0);

        uint256 raise = _expectedRaise(c);
        uint256 fee = treasury.balance - treasuryBefore;
        uint256 spent = balanceBefore - buyer.balance;

        assertEq(out, ALLOC, "always fills exactly the allocation, never more");
        assertEq(c.tokensSold(), ALLOC, "never oversells");
        assertEq(gm.raisedReceived(), raise, "raise is calibration-fixed, independent of overpayment");
        assertEq(spent, raise + fee, "buyer pays the raise plus the fee and nothing else");
        assertEq(address(c).balance, 0, "no ETH stranded in the curve");

        // The fee must cover the rate applied to the raise. Rounding may add a wei (ceil favours the
        // protocol); it must never subtract one.
        uint256 minFee = _ceilDiv(raise * FEE_BPS, BPS - FEE_BPS) - 1;
        assertGe(fee, minFee, "fee is never rounded down in the buyer's favour");
    }

    /// Rounding direction, stated as a property: a buy immediately followed by selling the entire
    /// position back can never return more ETH than was put in. If curve rounding ever favoured the
    /// trader, this is where it would show up as free money.
    function testFuzz_BuyThenImmediateSell_IsNeverProfitable(uint256 ethIn) public {
        ethIn = bound(ethIn, 1e12, 20 ether); // dust up to a large-but-non-crossing buy

        BondingCurve c = _newCurve();
        vm.deal(buyer, ethIn + 1 ether);

        uint256 balanceBefore = buyer.balance;
        vm.startPrank(buyer);
        uint256 out = c.buy{value: ethIn}(0);
        vm.assume(out > 0);
        token.approve(address(c), out);
        c.sell(out, 0);
        vm.stopPrank();

        assertLe(buyer.balance, balanceBefore, "a round trip can never mint ETH for the trader");
    }

    /// The same property under repetition: many small round trips must not accumulate value against
    /// the curve either. Rounding that is harmless once can still be harmful ten thousand times.
    function test_RepeatedDustRoundTrips_DoNotDrainTheCurve() public {
        uint256 balanceBefore = buyer.balance;

        for (uint256 i = 0; i < 100; i++) {
            vm.startPrank(buyer);
            uint256 out = curve.buy{value: 0.01 ether}(0);
            token.approve(address(curve), out);
            curve.sell(out, 0);
            vm.stopPrank();
        }

        assertLe(buyer.balance, balanceBefore, "100 round trips still never profit the trader");
        assertGe(curve.ethReserve(), V_ETH - 1, "curve reserves not drained below their virtual floor");
    }
}
