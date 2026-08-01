// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BondingCurve, CurveConfig} from "../src/BondingCurve.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockGraduationManager} from "./mocks/MockGraduationManager.sol";
import {ForkConfig} from "./ForkConfig.sol";

/// @notice Build 03 (#14): bonding-curve buy/sell. The curve is deployed directly with the
///         anti-snipe cap DISABLED (threshold 0) so these tests isolate pure curve math;
///         the anti-snipe cap itself is covered in AntiSnipe.t.sol (#15). Graduation is stubbed
///         with a mock manager here; the real V3 seeding path is in Graduation.t.sol (#16).
contract BondingCurveTest is Test {
    uint256 internal constant V_ETH = 30 ether;
    uint256 internal constant V_TOK = 1_073_000_000e18;
    uint256 internal constant ALLOC = 800_000_000e18;
    uint256 internal constant K = V_ETH * V_TOK;

    address internal treasury = makeAddr("treasury");
    address internal buyer = makeAddr("buyer");

    MockERC20 internal token;
    MockGraduationManager internal gm;
    BondingCurve internal curve;

    function _newCurve(MockERC20 t) internal returns (BondingCurve c) {
        c = new BondingCurve(
            CurveConfig({
                token: IERC20(address(t)),
                treasury: treasury,
                graduationManager: address(gm),
                virtualEthReserve: V_ETH,
                virtualTokenReserve: V_TOK,
                curveTokenAllocation: ALLOC,
                tradeFeeBps: 100,
                maxBuyPerWallet: type(uint256).max,
                antiSnipeThreshold: 0
            })
        );
        t.mint(address(c), ALLOC);
    }

    function setUp() public {
        gm = new MockGraduationManager();
        token = new MockERC20("Doge Killer", "DOGEK");
        curve = _newCurve(token);
        vm.deal(buyer, 1000 ether);
    }

    function test_InitialReservesAreVirtual() public view {
        assertEq(curve.ethReserve(), V_ETH);
        assertEq(curve.tokenReserve(), V_TOK);
        assertEq(curve.tokensSold(), 0);
        assertEq(curve.k(), K);
        assertEq(token.balanceOf(address(curve)), ALLOC, "curve holds the allocation");
    }

    function _ceilDiv(uint256 a, uint256 b) private pure returns (uint256) {
        return (a + b - 1) / b;
    }

    function test_Buy_FollowsConstantProductFormula() public {
        uint256 ethIn = 1 ether;
        uint256 fee = ethIn / 100;
        uint256 newEth = V_ETH + (ethIn - fee);
        // Curve rounds against the trader: new token reserve is ceil(k / newEth).
        uint256 expectedOut = V_TOK - _ceilDiv(K, newEth);

        vm.prank(buyer);
        uint256 tokensOut = curve.buy{value: ethIn}(0);

        assertEq(tokensOut, expectedOut, "constant-product tokensOut");
        assertEq(curve.ethReserve(), newEth, "eth reserve");
        assertEq(curve.tokenReserve(), _ceilDiv(K, newEth), "token reserve");
        assertEq(curve.tokensSold(), tokensOut);
        assertEq(token.balanceOf(buyer), tokensOut, "buyer received tokens");
    }

    function test_Buy_ChargesOnePercentFeeToTreasury() public {
        uint256 before = treasury.balance;
        vm.prank(buyer);
        curve.buy{value: 5 ether}(0);
        assertEq(treasury.balance - before, 0.05 ether, "1% buy fee to treasury");
    }

    function test_Buy_RaisesPrice() public {
        uint256 p0 = curve.priceX18();
        vm.prank(buyer);
        curve.buy{value: 2 ether}(0);
        assertGt(curve.priceX18(), p0, "price rises as tokens are bought");
    }

    function test_QuoteBuy_MatchesActual() public {
        (uint256 quoted,) = curve.quoteBuy(3 ether);
        vm.prank(buyer);
        uint256 actual = curve.buy{value: 3 ether}(0);
        assertEq(actual, quoted, "quote matches buy");
    }

    function test_BuyThenSell_RoundTrip_ReservesRestored() public {
        vm.startPrank(buyer);
        uint256 bought = curve.buy{value: 1 ether}(0);

        uint256 treasuryBefore = treasury.balance;
        uint256 ethBefore = buyer.balance;
        token.approve(address(curve), bought);
        uint256 ethOut = curve.sell(bought, 0);
        vm.stopPrank();

        // Selling the exact amount bought restores the virtual reserves precisely.
        assertEq(curve.tokensSold(), 0, "tokensSold back to 0");
        assertEq(curve.ethReserve(), V_ETH, "eth reserve restored");
        assertEq(curve.tokenReserve(), V_TOK, "token reserve restored");

        // Gross out = the 0.99 ETH that entered the curve; minus 1% sell fee => 0.9801.
        assertEq(ethOut, 0.9801 ether, "net eth out after both fees");
        assertEq(buyer.balance - ethBefore, 0.9801 ether);
        assertEq(treasury.balance - treasuryBefore, 0.0099 ether, "1% sell fee to treasury");
    }

    function test_Buy_CrossingAllocation_CapsRefundsAndGraduates() public {
        // A buy large enough to exhaust the 800M allocation is the graduation trigger: it is
        // capped at the remaining allocation, overflow is refunded, and the curve disables itself.
        uint256 ethBefore = buyer.balance;
        uint256 treasuryBefore = treasury.balance;
        vm.prank(buyer);
        uint256 out = curve.buy{value: 1000 ether}(0);

        assertEq(out, ALLOC, "crossing buy capped at the remaining allocation");
        assertEq(curve.tokensSold(), ALLOC, "curve sold out exactly");
        assertEq(token.balanceOf(buyer), ALLOC, "buyer received the capped amount");
        assertTrue(curve.graduated(), "curve graduated");
        assertEq(gm.calls(), 1, "graduation manager invoked once");
        assertEq(gm.lastToken(), address(token), "graduated the right token");
        // 100% of the raised ETH (curve's whole balance) was handed to the manager; nothing left.
        assertEq(gm.raisedReceived(), curve.finalEthReserve() - V_ETH, "raised ETH forwarded");
        assertEq(address(curve).balance, 0, "no leftover ETH in the curve");
        // Overflow refunded: the buyer's net spend is only fee + raised ETH, far below 1000 ether.
        uint256 fee = treasury.balance - treasuryBefore;
        assertEq(ethBefore - buyer.balance, fee + gm.raisedReceived(), "buyer only paid to complete the curve");
        assertLt(ethBefore - buyer.balance, 100 ether, "overflow refunded");
    }

    function test_Buy_RevertsAfterGraduation() public {
        vm.prank(buyer);
        curve.buy{value: 1000 ether}(0); // graduates
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        vm.expectRevert(BondingCurve.AlreadyGraduated.selector);
        curve.buy{value: 1 ether}(0);
    }

    function test_Sell_RevertsAfterGraduation() public {
        vm.prank(buyer);
        curve.buy{value: 1000 ether}(0); // graduates; buyer now holds the whole allocation
        vm.startPrank(buyer);
        token.approve(address(curve), ALLOC);
        vm.expectRevert(BondingCurve.AlreadyGraduated.selector);
        curve.sell(1e18, 0);
        vm.stopPrank();
    }

    function test_Buy_SlippageReverts() public {
        (uint256 quoted,) = curve.quoteBuy(1 ether);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(BondingCurve.SlippageBuy.selector, quoted, quoted + 1));
        curve.buy{value: 1 ether}(quoted + 1);
    }

    function test_Sell_SlippageReverts() public {
        vm.startPrank(buyer);
        uint256 bought = curve.buy{value: 1 ether}(0);
        (uint256 quotedEth,) = curve.quoteSell(bought);
        token.approve(address(curve), bought);
        vm.expectRevert(abi.encodeWithSelector(BondingCurve.SlippageSell.selector, quotedEth, quotedEth + 1));
        curve.sell(bought, quotedEth + 1);
        vm.stopPrank();
    }

    function test_Buy_ZeroReverts() public {
        vm.prank(buyer);
        vm.expectRevert(BondingCurve.ZeroAmount.selector);
        curve.buy{value: 0}(0);
    }

    function test_CurveSolvency_HoldsRealEth() public {
        vm.prank(buyer);
        curve.buy{value: 10 ether}(0);
        // Real ETH held = effective reserve minus the virtual portion.
        assertEq(address(curve).balance, curve.ethReserve() - V_ETH, "curve holds exactly the real ETH");
    }

    /// @notice AC "Fork tests assert pricing math, fee accounting, reserve updates" — on 4663.
    function test_BuySell_OnRobinhoodFork() public {
        vm.createSelectFork(ForkConfig.MAINNET, ForkConfig.MAINNET_BLOCK);
        assertEq(block.chainid, 4663);

        gm = new MockGraduationManager(); // fresh fork state
        MockERC20 tok = new MockERC20("Fork Coin", "FORK");
        BondingCurve c = _newCurve(tok);

        address forkBuyer = makeAddr("forkBuyer");
        vm.deal(forkBuyer, 10 ether);
        uint256 treasuryBefore = treasury.balance;

        uint256 ethIn = 1 ether;
        uint256 fee = ethIn / 100;
        uint256 newEth = V_ETH + (ethIn - fee);
        uint256 expectedOut = V_TOK - _ceilDiv(K, newEth);

        vm.prank(forkBuyer);
        uint256 out = c.buy{value: ethIn}(0);

        assertEq(out, expectedOut, "fork: pricing math"); // pricing math
        assertEq(treasury.balance - treasuryBefore, fee, "fork: fee accounting"); // fee accounting
        assertEq(c.ethReserve(), newEth, "fork: reserve update"); // reserve updates
        assertEq(tok.balanceOf(forkBuyer), out);
    }
}
