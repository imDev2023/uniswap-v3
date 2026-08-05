// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {V3Deployer} from "../src/periphery/V3Deployer.sol";
import {IUniswapV3Factory} from "../src/interfaces/IUniswapV3Minimal.sol";
import {Constants} from "../src/Constants.sol";

/// @notice Deploys the platform's OWN unmodified Uniswap V3 factory + periphery.
/// @dev Run against a fork to dry-run, or with --broadcast to deploy for real:
///        forge script script/DeployV3.s.sol --fork-url robinhood            (dry run)
///        forge script script/DeployV3.s.sol --rpc-url robinhood_testnet --broadcast
///      Ownership is finalized (multisig / timelock) in Build 07 (#18); pass OWNER to
///      hand the factory's fee switch to a chosen owner at deploy time.
contract DeployV3 is Script, V3Deployer {
    function run() external {
        address weth9 = vm.envOr("WETH9", Constants.WETH9);
        address tokenDescriptor = vm.envOr("TOKEN_DESCRIPTOR", address(0xDEAD));
        address finalOwner = vm.envOr("OWNER", address(0));

        vm.startBroadcast();
        address factory = deployV3Factory();
        address router = deploySwapRouter(factory, weth9);
        address positionManager = deployPositionManager(factory, weth9, tokenDescriptor);
        if (finalOwner != address(0)) {
            IUniswapV3Factory(factory).setOwner(finalOwner);
        }
        vm.stopBroadcast();

        console2.log("UniswapV3Factory:            ", factory);
        console2.log("SwapRouter:                  ", router);
        console2.log("NonfungiblePositionManager:  ", positionManager);
        console2.log("WETH9:                       ", weth9);
        console2.log("Factory owner:               ", IUniswapV3Factory(factory).owner());
    }
}
