// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LaunchpadFactory} from "../src/LaunchpadFactory.sol";
import {BondingCurve, CurveConfig} from "../src/BondingCurve.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockGraduationManager} from "./mocks/MockGraduationManager.sol";

/// @notice Build 04 (#15): anti-snipe per-wallet cap over a progress-based window.
contract AntiSnipeTest is Test {
    uint256 internal constant V_ETH = 30 ether;
    uint256 internal constant V_TOK = 1_073_000_000e18;
    uint256 internal constant ALLOC = 800_000_000e18;
    uint256 internal constant CAP = 8_000_000e18; // 1% of 800M

    // Placeholder V3 position manager for factory construction; anti-snipe tests never graduate.
    address internal positionManager = makeAddr("positionManager");

    address internal treasury = makeAddr("treasury");
    address internal buyerA = makeAddr("buyerA");
    address internal buyerB = makeAddr("buyerB");

    MockGraduationManager internal gm = new MockGraduationManager();

    function _deploy(uint256 cap, uint256 threshold) internal returns (BondingCurve c, MockERC20 t) {
        t = new MockERC20("Test", "TST");
        c = new BondingCurve(
            CurveConfig({
                token: IERC20(address(t)),
                treasury: treasury,
                graduationManager: address(gm),
                virtualEthReserve: V_ETH,
                virtualTokenReserve: V_TOK,
                curveTokenAllocation: ALLOC,
                tradeFeeBps: 100,
                maxBuyPerWallet: cap,
                antiSnipeThreshold: threshold
            })
        );
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

    /// @notice Regression (Standards review #1): a single buy that would cross the window threshold
    ///         in one shot must STILL be capped — a buyer can't dodge the cap by pushing tokensSold
    ///         past the threshold within the same transaction.
    function test_Cap_CrossingWindowInOneBuyStillCapped() public {
        (BondingCurve c,) = _deploy(CAP, 120_000_000e18); // cap 8M, window until 120M sold
        vm.deal(buyerA, 100 ether);
        (uint256 quoted,) = c.quoteBuy(4 ether); // ~125M tokens: crosses the 120M window AND blows the 8M cap
        assertGt(quoted, 120_000_000e18, "single buy would cross the window threshold");
        vm.prank(buyerA);
        vm.expectRevert(abi.encodeWithSelector(BondingCurve.BuyCapExceeded.selector, quoted, CAP));
        c.buy{value: 4 ether}(0);
    }

    function test_Factory_WiresAntiSnipeDefaults() public {
        LaunchpadFactory f = new LaunchpadFactory(address(this), treasury, 0, positionManager);
        address tok = f.createLaunch("X", "X");
        BondingCurve c = BondingCurve(f.curveOf(tok));
        assertEq(c.maxBuyPerWallet(), 8_000_000e18, "1% of 800M");
        assertEq(c.antiSnipeThreshold(), 120_000_000e18, "15% of 800M");
        assertTrue(c.buyCapActive());
    }

    /// @notice Deferred #15 item (b): the cap holds on the real create-then-first-buy path, i.e.
    ///         the very first buyer on a factory-created curve can't grab more than the cap.
    function test_Factory_FirstBuyRespectsCap() public {
        LaunchpadFactory f = new LaunchpadFactory(address(this), treasury, 0, positionManager);
        BondingCurve c = BondingCurve(f.curveOf(f.createLaunch("X", "X")));

        vm.deal(buyerA, 100 ether);
        // A 1 ETH first buy would pull well over the 8M-token cap while the window is active.
        (uint256 quoted,) = c.quoteBuy(1 ether);
        assertGt(quoted, c.maxBuyPerWallet(), "first buy would exceed the cap");
        vm.prank(buyerA);
        vm.expectRevert(abi.encodeWithSelector(BondingCurve.BuyCapExceeded.selector, quoted, c.maxBuyPerWallet()));
        c.buy{value: 1 ether}(0);

        // A buy under the cap succeeds and is tracked.
        (uint256 small,) = c.quoteBuy(0.1 ether);
        assertLt(small, c.maxBuyPerWallet(), "small first buy under cap");
        vm.prank(buyerA);
        c.buy{value: 0.1 ether}(0);
        assertEq(c.purchasedOf(buyerA), small, "first-buy purchase tracked");
    }
}
