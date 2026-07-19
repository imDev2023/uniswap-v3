// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LaunchpadFactory} from "../src/LaunchpadFactory.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Build 03 (#14): bonding-curve buy/sell.
contract BondingCurveTest is Test {
    uint256 internal constant FEE = 0.01 ether;

    // Mirror the factory defaults so tests encode the intended formula independently.
    uint256 internal constant V_ETH = 30 ether;
    uint256 internal constant V_TOK = 1_073_000_000e18;
    uint256 internal constant K = V_ETH * V_TOK;

    LaunchpadFactory internal factory;
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");
    address internal buyer = makeAddr("buyer");

    IERC20 internal token;
    BondingCurve internal curve;

    function setUp() public {
        factory = new LaunchpadFactory(address(this), treasury, FEE);
        vm.deal(creator, 1 ether);
        vm.prank(creator);
        address tok = factory.createLaunch{value: FEE}("Doge Killer", "DOGEK");
        token = IERC20(tok);
        curve = BondingCurve(factory.curveOf(tok));
        vm.deal(buyer, 1000 ether);
    }

    function test_InitialReservesAreVirtual() public view {
        assertEq(curve.ethReserve(), V_ETH);
        assertEq(curve.tokenReserve(), V_TOK);
        assertEq(curve.tokensSold(), 0);
        assertEq(curve.k(), K);
        assertEq(token.balanceOf(address(curve)), factory.CURVE_SUPPLY(), "curve holds 800M");
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

    function test_Buy_RevertsWhenExceedingAllocation() public {
        vm.prank(buyer);
        vm.expectRevert(BondingCurve.CurveSoldOut.selector);
        curve.buy{value: 1000 ether}(0); // would pull far more than the 800M allocation
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
        vm.createSelectFork("robinhood");
        assertEq(block.chainid, 4663);

        LaunchpadFactory f = new LaunchpadFactory(address(this), treasury, FEE);
        vm.deal(creator, 1 ether);
        vm.prank(creator);
        address tok = f.createLaunch{value: FEE}("Fork Coin", "FORK");
        BondingCurve c = BondingCurve(f.curveOf(tok));

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
        assertEq(IERC20(tok).balanceOf(forkBuyer), out);
    }
}
