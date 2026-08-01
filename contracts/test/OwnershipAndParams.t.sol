// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {V3Deployer} from "../src/periphery/V3Deployer.sol";
import {LaunchpadFactory} from "../src/LaunchpadFactory.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {Constants} from "../src/Constants.sol";
import {IUniswapV3Factory} from "../src/interfaces/IUniswapV3Minimal.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ForkConfig} from "./ForkConfig.sol";

/// @notice Build 07 (#18): the launchpad goes under Safe-multisig control via a two-step ownership
///         handoff, and the curve defaults become owner-tunable guarded params that bind only FUTURE
///         launches. Non-fork cases exercise the access-control + param logic directly; the fork case
///         mirrors the deploy script's ownership choreography against real Robinhood Chain state.
contract OwnershipAndParamsTest is Test, V3Deployer {
    LaunchpadFactory internal factory;

    address internal owner = makeAddr("owner");
    address internal safe = makeAddr("safe"); // stands in for the Gnosis Safe multisig
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");
    address internal stranger = makeAddr("stranger");
    // Placeholder V3 addresses; these cases never graduate.
    address internal positionManager = makeAddr("positionManager");
    address internal v3Factory = makeAddr("v3Factory");
    address internal weth9 = makeAddr("weth9");

    event CurveParamsUpdated(
        uint256 virtualEthReserve, uint16 tradeFeeBps, uint256 maxBuyPerWallet, uint256 antiSnipeThreshold
    );
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);

    function setUp() public {
        factory = new LaunchpadFactory(owner, treasury, 0, positionManager, v3Factory, weth9);
        vm.deal(creator, 10 ether);
    }

    function _create() internal returns (BondingCurve) {
        vm.prank(creator);
        address token = factory.createLaunch("Tok", "TOK", "ipfs://QmTestMetadata");
        return BondingCurve(factory.curveOf(token));
    }

    // --- Two-step ownership → multisig -------------------------------------------------------

    function test_TransferOwnership_IsTwoStep_AndBindsOnAccept() public {
        // Owner starts the handoff. Ownership does NOT move yet; the old owner still controls the
        // launchpad and the Safe is merely pending.
        vm.expectEmit(true, true, false, false);
        emit OwnershipTransferStarted(owner, safe);
        vm.prank(owner);
        factory.transferOwnership(safe);
        assertEq(factory.owner(), owner, "owner unchanged until accept");
        assertEq(factory.pendingOwner(), safe, "safe is pending");

        // Old owner can still act; the pending Safe cannot yet.
        vm.prank(owner);
        factory.setCreationFee(1 ether);
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, safe));
        factory.setCreationFee(2 ether);

        // Safe accepts → ownership binds, pending clears, old owner loses control.
        vm.prank(safe);
        factory.acceptOwnership();
        assertEq(factory.owner(), safe, "safe now owns");
        assertEq(factory.pendingOwner(), address(0), "pending cleared");
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        factory.setCreationFee(3 ether);
        vm.prank(safe);
        factory.setTreasury(safe); // Safe now governs
    }

    function test_TransferOwnership_OnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        factory.transferOwnership(safe);
    }

    function test_AcceptOwnership_OnlyPending() public {
        vm.prank(owner);
        factory.transferOwnership(safe);
        // A mistyped/hostile address cannot hijack the pending handoff.
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        factory.acceptOwnership();
    }

    // --- Guarded curve params, future-only --------------------------------------------------

    function test_SetCurveParams_OnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        factory.setCurveParams(40 ether, 200, 4_000_000e18, 60_000_000e18);
    }

    function test_SetCurveParams_Validates() public {
        // Read getters up front: doing so inside an `expectRevert`-armed line would consume the
        // expectation on the view call instead of on setCurveParams.
        uint16 tooHighFee = factory.MAX_TRADE_FEE_BPS() + 1;
        uint256 tooHighThreshold = factory.CURVE_SUPPLY() + 1;

        vm.startPrank(owner);
        // virtualEthReserve == 0
        vm.expectRevert(LaunchpadFactory.InvalidCurveParams.selector);
        factory.setCurveParams(0, 100, 8_000_000e18, 120_000_000e18);
        // tradeFeeBps > MAX_TRADE_FEE_BPS (10%)
        vm.expectRevert(LaunchpadFactory.InvalidCurveParams.selector);
        factory.setCurveParams(30 ether, tooHighFee, 8_000_000e18, 120_000_000e18);
        // maxBuyPerWallet == 0
        vm.expectRevert(LaunchpadFactory.InvalidCurveParams.selector);
        factory.setCurveParams(30 ether, 100, 0, 120_000_000e18);
        // antiSnipeThreshold > CURVE_SUPPLY
        vm.expectRevert(LaunchpadFactory.InvalidCurveParams.selector);
        factory.setCurveParams(30 ether, 100, 8_000_000e18, tooHighThreshold);
        vm.stopPrank();
    }

    function test_SetCurveParams_EmitsAndStores() public {
        vm.expectEmit(false, false, false, true);
        emit CurveParamsUpdated(50 ether, 250, 5_000_000e18, 90_000_000e18);
        vm.prank(owner);
        factory.setCurveParams(50 ether, 250, 5_000_000e18, 90_000_000e18);
        assertEq(factory.virtualEthReserve(), 50 ether);
        assertEq(factory.tradeFeeBps(), 250);
        assertEq(factory.maxBuyPerWallet(), 5_000_000e18);
        assertEq(factory.antiSnipeThreshold(), 90_000_000e18);
    }

    /// @notice The headline invariant of #18: a param change binds only FUTURE launches. A launch
    ///         created before the change keeps its frozen curve immutables; one created after picks up
    ///         the new values. Nothing can reach an in-flight curve.
    function test_CurveParams_BindFutureLaunchesOnly() public {
        BondingCurve before = _create();
        // Defaults, frozen into `before`.
        assertEq(before.virtualEthReserve(), factory.DEFAULT_VIRTUAL_ETH_RESERVE());
        assertEq(before.tradeFeeBps(), factory.DEFAULT_TRADE_FEE_BPS());
        assertEq(before.maxBuyPerWallet(), factory.DEFAULT_MAX_BUY_PER_WALLET());
        assertEq(before.antiSnipeThreshold(), factory.DEFAULT_ANTI_SNIPE_THRESHOLD());

        vm.prank(owner);
        factory.setCurveParams(50 ether, 250, 5_000_000e18, 90_000_000e18);

        BondingCurve afterCurve = _create();
        // New launch reflects the new params...
        assertEq(afterCurve.virtualEthReserve(), 50 ether);
        assertEq(afterCurve.tradeFeeBps(), 250);
        assertEq(afterCurve.maxBuyPerWallet(), 5_000_000e18);
        assertEq(afterCurve.antiSnipeThreshold(), 90_000_000e18);
        // ...while the in-flight curve is completely untouched.
        assertEq(before.virtualEthReserve(), factory.DEFAULT_VIRTUAL_ETH_RESERVE());
        assertEq(before.tradeFeeBps(), factory.DEFAULT_TRADE_FEE_BPS());
        assertEq(before.maxBuyPerWallet(), factory.DEFAULT_MAX_BUY_PER_WALLET());
        assertEq(before.antiSnipeThreshold(), factory.DEFAULT_ANTI_SNIPE_THRESHOLD());
        // V_token stays calibration-locked regardless (price continuity, #16).
        assertEq(afterCurve.virtualTokenReserve(), factory.DEFAULT_VIRTUAL_TOKEN_RESERVE());
        assertEq(before.virtualTokenReserve(), factory.DEFAULT_VIRTUAL_TOKEN_RESERVE());
    }

    // --- Fork: the deploy script's ownership choreography on real chain state ----------------

    /// @notice Mirrors DeployLaunchpad: deploy our own V3, wire the launchpad to it, hand the V3 fee
    ///         switch to the launchpad, then two-step the launchpad to the Safe — all on a 4663 fork.
    function test_DeployChoreography_OnRobinhoodFork() public {
        vm.createSelectFork(ForkConfig.MAINNET, ForkConfig.MAINNET_BLOCK);
        assertEq(block.chainid, Constants.CHAIN_ID_MAINNET);

        address realV3Factory = deployV3Factory(); // deployer (this test) owns it
        address pm = deployPositionManager(realV3Factory, Constants.WETH9, address(0xDEAD));
        LaunchpadFactory lp = new LaunchpadFactory(address(this), treasury, 0, pm, realV3Factory, weth9);

        // Hand the V3 protocol-fee switch to the launchpad (single-step, Uniswap's own Ownable).
        IUniswapV3Factory(realV3Factory).setOwner(address(lp));
        assertEq(IUniswapV3Factory(realV3Factory).owner(), address(lp), "launchpad owns the V3 factory");

        // Two-step the launchpad to the Safe.
        lp.transferOwnership(safe);
        assertEq(lp.owner(), address(this), "not moved until accept");
        assertEq(lp.pendingOwner(), safe);
        vm.prank(safe);
        lp.acceptOwnership();
        assertEq(lp.owner(), safe, "Safe controls the launchpad");
        assertEq(lp.pendingOwner(), address(0));
    }
}
