// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {V3Deployer} from "../src/periphery/V3Deployer.sol";
import {IUniswapV3Factory, IUniswapV3Pool} from "../src/interfaces/IUniswapV3Minimal.sol";
import {Constants} from "../src/Constants.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @notice Build 01 harness (#12): proves we can, against a real Robinhood Chain fork,
///         deploy our OWN unmodified Uniswap V3 factory + periphery and create a bare pool.
contract V3HarnessTest is Test, V3Deployer {
    uint160 internal constant SQRT_PRICE_1_1 = uint160(2 ** 96); // price = 1.0

    IUniswapV3Factory internal factory;
    address internal router;
    address internal positionManager;

    function setUp() public {
        vm.createSelectFork("robinhood");
        address f = deployV3Factory();
        factory = IUniswapV3Factory(f);
        router = deploySwapRouter(f, Constants.WETH9);
        positionManager = deployPositionManager(f, Constants.WETH9, address(0xDEAD));
    }

    function test_ForkIsRobinhoodChainMainnet() public view {
        assertEq(block.chainid, Constants.CHAIN_ID_MAINNET, "fork should be chain 4663");
    }

    function test_CanonicalWeth9HasCodeOnChain() public view {
        assertGt(Constants.WETH9.code.length, 0, "canonical WETH9 must have code on the fork");
    }

    function test_OwnFactoryDeployed_AndWeOwnIt() public view {
        assertGt(address(factory).code.length, 0, "factory should be deployed");
        // Our own factory: the deployer (this test contract) is its owner => we control the fee switch.
        assertEq(factory.owner(), address(this), "we must own our factory");
    }

    function test_PeripheryDeployed() public view {
        assertGt(router.code.length, 0, "SwapRouter should be deployed");
        assertGt(positionManager.code.length, 0, "NonfungiblePositionManager should be deployed");
    }

    function test_OnePercentFeeTierEnabledByDefault() public view {
        // The 1% tier (graduated-pool fee, decision #6) ships enabled in the V3 factory.
        assertEq(factory.feeAmountTickSpacing(Constants.POOL_FEE_TIER), int24(200), "1% tier tickSpacing");
    }

    function test_CreateAndInitializeBarePool() public {
        MockERC20 a = new MockERC20("Token A", "AAA");
        MockERC20 b = new MockERC20("Token B", "BBB");

        address pool = factory.createPool(address(a), address(b), Constants.POOL_FEE_TIER);
        assertTrue(pool != address(0), "pool should be created");
        assertEq(factory.getPool(address(a), address(b), Constants.POOL_FEE_TIER), pool, "registry mismatch");

        IUniswapV3Pool(pool).initialize(SQRT_PRICE_1_1);
        (uint160 sqrtPriceX96,,,,,,) = IUniswapV3Pool(pool).slot0();
        assertEq(sqrtPriceX96, SQRT_PRICE_1_1, "pool should be initialized at price 1");
        assertEq(IUniswapV3Pool(pool).fee(), Constants.POOL_FEE_TIER, "pool fee tier");
    }
}
