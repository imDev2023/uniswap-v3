// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LaunchpadFactory} from "../src/LaunchpadFactory.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @notice Build 04 (#15): anti-snipe per-wallet cap over a progress-based window.
contract AntiSnipeTest is Test {
    uint256 internal constant V_ETH = 30 ether;
    uint256 internal constant V_TOK = 1_073_000_000e18;
    uint256 internal constant ALLOC = 800_000_000e18;
    uint256 internal constant CAP = 8_000_000e18; // 1% of 800M

    address internal treasury = makeAddr("treasury");
    address internal buyerA = makeAddr("buyerA");
    address internal buyerB = makeAddr("buyerB");

    function _deploy(uint256 cap, uint256 threshold) internal returns (BondingCurve c, MockERC20 t) {
        t = new MockERC20("Test", "TST");
        c = new BondingCurve(IERC20(address(t)), treasury, V_ETH, V_TOK, ALLOC, 100, cap, threshold);
        t.mint(address(c), ALLOC);
    }

    function test_Cap_RevertsOverCapDuringWindow() public {
        (BondingCurve c,) = _deploy(CAP, ALLOC); // window covers the whole curve
        vm.deal(buyerA, 100 ether);
        (uint256 quoted,) = c.quoteBuy(1 ether); // ~34M tokens, over the 8M cap
        vm.prank(buyerA);
        vm.expectRevert(abi.encodeWithSelector(BondingCurve.BuyCapExceeded.selector, quoted, CAP));
        c.buy{value: 1 ether}(0);
    }

    function test_Cap_AllowsUpToCap() public {
        (BondingCurve c, MockERC20 t) = _deploy(CAP, ALLOC);
        vm.deal(buyerA, 100 ether);
        (uint256 quoted,) = c.quoteBuy(0.1 ether);
        assertLt(quoted, CAP, "small buy under cap");
        vm.prank(buyerA);
        c.buy{value: 0.1 ether}(0);
        assertEq(t.balanceOf(buyerA), quoted);
        assertEq(c.purchasedOf(buyerA), quoted, "window purchases tracked");
    }

    function test_Cap_CumulativeAcrossBuys() public {
        (BondingCurve c,) = _deploy(CAP, ALLOC);
        vm.deal(buyerA, 100 ether);
        vm.prank(buyerA);
        c.buy{value: 0.1 ether}(0);
        (uint256 q2,) = c.quoteBuy(1 ether);
        uint256 attempted = c.purchasedOf(buyerA) + q2;
        vm.prank(buyerA);
        vm.expectRevert(abi.encodeWithSelector(BondingCurve.BuyCapExceeded.selector, attempted, CAP));
        c.buy{value: 1 ether}(0);
    }

    function test_Cap_PerWalletIndependent() public {
        (BondingCurve c, MockERC20 t) = _deploy(CAP, ALLOC);
        vm.deal(buyerA, 100 ether);
        vm.deal(buyerB, 100 ether);

        vm.prank(buyerA);
        uint256 aOut = c.buy{value: 0.2 ether}(0);
        vm.prank(buyerB);
        uint256 bOut = c.buy{value: 0.2 ether}(0);

        // Each stays under its OWN cap, even though the two together exceed a single cap —
        // proving the cap is per-wallet, not a global curve limit.
        assertLt(aOut, CAP);
        assertLt(bOut, CAP);
        assertGt(aOut + bOut, CAP, "combined exceeds one cap");
        assertEq(t.balanceOf(buyerA), aOut);
        assertEq(t.balanceOf(buyerB), bOut);
    }

    function test_Cap_CreatorHasNoExemption() public {
        // The creator is just another buyer address; the cap applies identically.
        address creator = makeAddr("creator");
        (BondingCurve c,) = _deploy(CAP, ALLOC);
        vm.deal(creator, 100 ether);
        (uint256 quoted,) = c.quoteBuy(1 ether);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(BondingCurve.BuyCapExceeded.selector, quoted, CAP));
        c.buy{value: 1 ether}(0);
    }

    function test_Cap_LiftsAfterWindowThreshold() public {
        // Cap 50M, window until 20M sold. One 1-ETH buy (~34M) crosses the window.
        (BondingCurve c, MockERC20 t) = _deploy(50_000_000e18, 20_000_000e18);
        vm.deal(buyerA, 100 ether);
        vm.deal(buyerB, 100 ether);

        assertTrue(c.buyCapActive(), "cap active at start");
        vm.prank(buyerA);
        c.buy{value: 1 ether}(0);
        assertFalse(c.buyCapActive(), "window lifted after threshold crossed");

        // buyerB can now take an amount that WOULD exceed the cap, uncapped.
        (uint256 big,) = c.quoteBuy(3 ether);
        assertGt(big, 50_000_000e18, "would exceed cap if still active");
        vm.prank(buyerB);
        c.buy{value: 3 ether}(0);
        assertEq(t.balanceOf(buyerB), big, "post-window buy uncapped");
    }

    function test_Factory_WiresAntiSnipeDefaults() public {
        LaunchpadFactory f = new LaunchpadFactory(address(this), treasury, 0);
        address tok = f.createLaunch("X", "X");
        BondingCurve c = BondingCurve(f.curveOf(tok));
        assertEq(c.maxBuyPerWallet(), 8_000_000e18, "1% of 800M");
        assertEq(c.antiSnipeThreshold(), 120_000_000e18, "15% of 800M");
        assertTrue(c.buyCapActive());
    }
}
