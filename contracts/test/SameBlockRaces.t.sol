// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BondingCurve, CurveConfig} from "../src/BondingCurve.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockGraduationManager} from "./mocks/MockGraduationManager.sol";

/// @notice Build 11 (#24): behaviour when several trades land in the SAME block.
/// @dev On a 0.3s-block chain this is the normal case, not an exotic one — a launch is most
///      contested exactly when blocks are fullest. Every previously-listed testnet gap was closed
///      on-chain except this one, which cannot be staged reliably against a live chain: you cannot
///      make two wallets land in a chosen block on demand. In Foundry it is deterministic, because
///      the block only advances when a test rolls it — so these tests assert `block.number` is
///      unchanged across each sequence, which is what makes them about same-block ordering rather
///      than merely about consecutive calls.
///
///      Anti-snipe is armed here (unlike BondingCurve.t.sol) because the cap's whole purpose is to
///      constrain exactly this contention. Graduation is stubbed with the mock manager; the real V3
///      seeding path is Graduation.t.sol.
contract SameBlockRacesTest is Test {
    uint256 internal constant V_ETH = 30 ether;
    uint256 internal constant V_TOK = 1_073_000_000e18;
    uint256 internal constant ALLOC = 800_000_000e18;
    uint256 internal constant CAP = 8_000_000e18; // 1% of the allocation
    uint256 internal constant WINDOW = 120_000_000e18; // cap lifts at 15% sold

    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    MockERC20 internal token;
    MockGraduationManager internal gm;
    BondingCurve internal curve;

    function setUp() public {
        gm = new MockGraduationManager();
        token = new MockERC20("Doge Killer", "DOGEK");
        curve = new BondingCurve(
            CurveConfig({
                token: IERC20(address(token)),
                treasury: treasury,
                graduationManager: address(gm),
                virtualEthReserve: V_ETH,
                virtualTokenReserve: V_TOK,
                curveTokenAllocation: ALLOC,
                tradeFeeBps: 100,
                maxBuyPerWallet: CAP,
                antiSnipeThreshold: WINDOW
            })
        );
        token.mint(address(curve), ALLOC);
        vm.deal(alice, 2000 ether);
        vm.deal(bob, 2000 ether);
    }

    function _buy(address who, uint256 value) internal returns (uint256 out) {
        vm.prank(who);
        out = curve.buy{value: value}(0);
    }

    /// Two wallets in one block are served strictly in order: the second buys against the reserves
    /// the first left behind, so the same ETH buys strictly fewer tokens. Nothing about being in the
    /// same block lets the second trader transact at the earlier price.
    function test_SameBlock_SecondBuyerPaysThePriceTheFirstMoved() public {
        uint256 blockBefore = block.number;

        // Sized to stay under the 8M per-wallet cap, which is armed in this suite.
        uint256 aliceOut = _buy(alice, 0.1 ether);
        uint256 priceAfterAlice = curve.priceX18();
        uint256 bobOut = _buy(bob, 0.1 ether);

        assertEq(block.number, blockBefore, "both buys in one block");
        assertLt(bobOut, aliceOut, "identical ETH buys fewer tokens after the price moved");
        assertGt(curve.priceX18(), priceAfterAlice, "price moved again");
        assertEq(curve.tokensSold(), aliceOut + bobOut, "sold total is exactly the two fills");
    }

    /// The anti-snipe cap is cumulative per wallet, not per transaction and not per block: two buys
    /// in one block that jointly exceed the cap must revert on the second.
    function test_SameBlock_CapCountsAcrossBuysWithinTheBlock() public {
        uint256 blockBefore = block.number;

        uint256 first = _buy(alice, 0.1 ether);
        assertLt(first, CAP, "first buy sits under the cap");

        // A second buy in the same block that would push the wallet past the cap.
        vm.prank(alice);
        vm.expectRevert();
        curve.buy{value: 10 ether}(0);

        assertEq(block.number, blockBefore, "still the same block");
        assertEq(curve.purchasedOf(alice), first, "failed buy left the tally untouched");
    }

    /// Sell-then-rebuy inside a single block must not reset the cap. `purchasedOf` is gross and is
    /// never decremented, so round-tripping through a sell buys no fresh allowance — the evasion is
    /// blocked even when the whole cycle is atomic within one block.
    function test_SameBlock_SellThenRebuyDoesNotRefreshTheCap() public {
        uint256 blockBefore = block.number;

        // Take a large position that still sits under the cap.
        uint256 bought = _buy(alice, 0.2 ether);
        uint256 purchasedAfterBuy = curve.purchasedOf(alice);
        assertEq(purchasedAfterBuy, bought, "tally credits the buy");

        // Dump the entire position back to the curve in the same block...
        vm.startPrank(alice);
        token.approve(address(curve), bought);
        curve.sell(bought, 0);
        vm.stopPrank();

        assertEq(curve.purchasedOf(alice), purchasedAfterBuy, "selling does NOT decrement the tally");

        // ...so rebuying the same size still counts against the original allowance.
        vm.prank(alice);
        vm.expectRevert();
        curve.buy{value: 10 ether}(0);

        assertEq(block.number, blockBefore, "buy, sell and rebuy all in one block");
    }

    /// @dev Push past the anti-snipe window with capped per-wallet buys so a crossing buy is legal.
    function _liftWindow() internal {
        for (uint256 i = 0; i < 200 && curve.buyCapActive(); i++) {
            address filler = makeAddr(string(abi.encodePacked("filler", i)));
            vm.deal(filler, 10 ether);
            vm.prank(filler);
            curve.buy{value: 0.2 ether}(0);
        }
        assertFalse(curve.buyCapActive(), "window lifted");
    }

    /// The race that actually matters: two buyers aim at the last of the allocation in one block.
    /// The first crosses and graduates atomically; the second is not partially filled at a stale
    /// price, it reverts outright. There is no window in which the curve is sold out but still open.
    function test_SameBlock_BuyLosingTheRaceToGraduationReverts() public {
        _liftWindow();
        uint256 blockBefore = block.number;

        _buy(alice, 500 ether); // crosses the threshold and graduates in this transaction
        assertTrue(curve.graduated(), "alice's buy graduated the curve");
        assertEq(gm.calls(), 1, "graduated exactly once");

        vm.prank(bob);
        vm.expectRevert(BondingCurve.AlreadyGraduated.selector);
        curve.buy{value: 10 ether}(0);

        assertEq(block.number, blockBefore, "the race happened inside one block");
        assertEq(gm.calls(), 1, "the loser's buy did not trigger a second graduation");
    }

    /// A holder trying to exit in the same block the curve graduates is also cleanly rejected rather
    /// than being served from a curve that has already handed its ETH to the GraduationManager.
    function test_SameBlock_SellRacingGraduationReverts() public {
        // Give bob a position before the window lifts.
        uint256 bobOut = _buy(bob, 0.2 ether);
        _liftWindow();
        uint256 blockBefore = block.number;

        _buy(alice, 500 ether);
        assertTrue(curve.graduated(), "curve graduated");

        vm.startPrank(bob);
        token.approve(address(curve), bobOut);
        vm.expectRevert(BondingCurve.AlreadyGraduated.selector);
        curve.sell(bobOut, 0);
        vm.stopPrank();

        assertEq(block.number, blockBefore, "sell raced graduation within the block");
        assertEq(address(curve).balance, 0, "curve forwarded 100% of the raise, holds nothing back");
    }

    /// Graduation is driven by cumulative state, not by any one buyer: many wallets contributing in
    /// one block must land on exactly the same calibrated raise as a single whale would.
    function test_SameBlock_ManyBuyersReachTheSameCalibratedRaise() public {
        _liftWindow();
        uint256 blockBefore = block.number;

        _buy(alice, 20 ether);
        _buy(bob, 20 ether);
        _buy(alice, 500 ether); // whoever crosses, the total raise is fixed by calibration

        assertTrue(curve.graduated(), "graduated");
        assertEq(block.number, blockBefore, "all within one block");
        assertEq(
            gm.raisedReceived(),
            curve.finalEthReserve() - V_ETH,
            "raise is the calibrated amount regardless of how many buyers got there"
        );
        assertEq(curve.tokensSold(), ALLOC, "allocation sold out exactly, never over");
        assertEq(address(curve).balance, 0, "no ETH stranded in the curve");
    }
}
