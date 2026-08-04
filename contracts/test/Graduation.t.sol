// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CurveDriver} from "./CurveDriver.sol";
import {Vm} from "forge-std/Vm.sol";
import {V3Deployer} from "../src/periphery/V3Deployer.sol";
import {LaunchpadFactory, LaunchParams} from "../src/LaunchpadFactory.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {GraduationManager} from "../src/periphery/GraduationManager.sol";
import {Constants} from "../src/Constants.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ForkConfig} from "./ForkConfig.sol";

/// @notice Build 05 (#16): the headline behaviour. Drives the whole journey through the public ABI
///         against a real Robinhood Chain (4663) fork with our OWN unmodified V3 deployment:
///         create → fill the curve (respecting the anti-snipe cap) → the threshold-crossing buy
///         atomically graduates into a seeded, full-range TOKEN/WETH pool — all in one transaction.
contract GraduationTest is Test, V3Deployer, CurveDriver {
    LaunchpadFactory internal factory;
    GraduationManager internal gm;
    address internal positionManager;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal whale = makeAddr("whale");

    function setUp() public {
        vm.createSelectFork(ForkConfig.MAINNET, ForkConfig.MAINNET_BLOCK);
        address v3Factory = deployV3Factory();
        positionManager = deployPositionManager(v3Factory, Constants.WETH9, address(0xDEAD));
        factory = new LaunchpadFactory(owner, treasury, 0, positionManager, v3Factory, Constants.WETH9);
        gm = factory.graduationManager();
    }

    function test_FullLifecycle_AtomicGraduation() public {
        address token = factory.createLaunch(LaunchParams("Graduate Me", "GRAD", "ipfs://QmTestMetadata", false, 0));
        BondingCurve curve = BondingCurve(factory.curveOf(token));

        // Anti-snipe holds on the real create-then-buy path: a whale can't seize > cap in the window.
        vm.deal(whale, 500 ether);
        (uint256 big,) = curve.quoteBuy(1 ether);
        vm.prank(whale);
        vm.expectRevert(abi.encodeWithSelector(BondingCurve.BuyCapExceeded.selector, big, curve.maxBuyPerWallet()));
        curve.buy{value: 1 ether}(0);

        _liftAntiSnipe(curve, "grad");

        // The crossing buy: whale overpays wildly; graduation must fire in THIS transaction.
        uint256 whaleBefore = whale.balance;
        vm.recordLogs();
        vm.prank(whale);
        curve.buy{value: 300 ether}(0);
        uint256 whaleSpent = whaleBefore - whale.balance; // capture before we re-deal whale below

        // --- Curve disabled, sold out exactly, no leftover ETH ---
        assertTrue(curve.graduated(), "curve graduated");
        assertEq(curve.tokensSold(), curve.curveTokenAllocation(), "800M sold out exactly");
        assertEq(address(curve).balance, 0, "no leftover ETH in the curve");

        vm.deal(whale, 1 ether);
        vm.prank(whale);
        vm.expectRevert(BondingCurve.AlreadyGraduated.selector);
        curve.buy{value: 1 ether}(0);

        // --- Pool created + initialized + seeded ---
        address pool = gm.poolOf(token);
        assertTrue(pool != address(0) && pool.code.length > 0, "TOKEN/WETH pool created");

        uint256 poolToken = IERC20(token).balanceOf(pool);
        uint256 poolWeth = IERC20(Constants.WETH9).balanceOf(pool);
        // 200M reserve + 100% of the 10 ETH raised seed the pool (no graduation fee in v1).
        // 10 ETH, not 90: #34 re-calibrated `DEFAULT_VIRTUAL_ETH_RESERVE` to `uint256(10 ether) / 3`
        // per settled decision 8. `Calibration.t.sol` pins the target exactly; this is the end-to-end
        // check that what the curve raised is what actually landed in the pool.
        assertApproxEqRel(poolToken, factory.GRADUATION_RESERVE(), 1e15, "~200M tokens seeded");
        assertApproxEqRel(poolWeth, 10 ether, 1e15, "~10 WETH seeded (100% of raised)");

        // --- Price continuity: the pool seeds at the curve's final marginal price ---
        uint256 curveFinalPrice = curve.priceX18(); // finalEthReserve/finalTokenReserve, 1e18-scaled
        uint256 poolPrice = (poolWeth * 1e18) / poolToken; // ETH per token, from actual pool reserves
        assertApproxEqRel(poolPrice, curveFinalPrice, 1e15, "pool price == curve final price");

        // --- Full-range position NFT minted straight into the permanent lock (#17) ---
        assertEq(IERC721(positionManager).balanceOf(address(factory.lpLock())), 1, "lock holds the position NFT");
        assertEq(IERC721(positionManager).balanceOf(address(gm)), 0, "manager keeps no NFT");

        // --- No leftover reserves anywhere (token, native ETH, AND wrapped WETH must all be dust) ---
        assertLt(IERC20(token).balanceOf(address(gm)), 1e12, "GM token dust is negligible");
        assertLt(IERC20(Constants.WETH9).balanceOf(address(gm)), 1e12, "GM WETH dust negligible: ~100% raised seeded");
        assertEq(address(gm).balance, 0, "GM holds no native ETH");

        // --- Overflow refunded to the crossing buyer (paid only to complete the curve) ---
        assertLt(whaleSpent, 100 ether, "ETH above the threshold refunded");
        assertGt(whaleSpent, 0, "crossing buyer paid the remaining raise");

        // --- Graduation emits an event with the pool address + seeded amounts ---
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("Graduated(address,address,uint256,uint256,uint256,uint160)");
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(gm) && logs[i].topics[0] == sig) {
                found = true;
                assertEq(address(uint160(uint256(logs[i].topics[1]))), token, "event token");
                assertEq(address(uint160(uint256(logs[i].topics[2]))), pool, "event pool");
            }
        }
        assertTrue(found, "GraduationManager emitted Graduated");
    }
}
