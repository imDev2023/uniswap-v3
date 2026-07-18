// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";

/// @notice Deploys the platform's OWN, unmodified Uniswap V3 (GPL) factory + periphery
///         from the official precompiled artifacts (via `vm.getCode`).
/// @dev This is a test/script helper. Deploying from prebuilt bytecode means we never
///      compile v3-core/periphery's Solidity 0.7.6 alongside our 0.8.x code — the
///      contracts that land on-chain are byte-for-byte the audited Uniswap release
///      (decision #4: own DEX on unmodified V3). Inherit this contract to reuse it.
contract V3Deployer {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    string internal constant FACTORY_ARTIFACT =
        "node_modules/@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json";
    string internal constant ROUTER_ARTIFACT =
        "node_modules/@uniswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json";
    string internal constant POSITION_MANAGER_ARTIFACT =
        "node_modules/@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json";

    function _create(bytes memory bytecode) private returns (address addr) {
        assembly {
            addr := create(0, add(bytecode, 0x20), mload(bytecode))
        }
        require(addr != address(0), "V3Deployer: create failed");
    }

    /// @notice Deploy our own UniswapV3Factory. The deployer (msg.sender) becomes its owner.
    function deployV3Factory() public returns (address factory) {
        factory = _create(vm.getCode(FACTORY_ARTIFACT));
    }

    /// @notice Deploy our own SwapRouter bound to `factory` and `weth9`.
    function deploySwapRouter(address factory, address weth9) public returns (address router) {
        bytes memory bytecode = abi.encodePacked(vm.getCode(ROUTER_ARTIFACT), abi.encode(factory, weth9));
        router = _create(bytecode);
    }

    /// @notice Deploy our own NonfungiblePositionManager.
    /// @param tokenDescriptor Only used for tokenURI metadata; a placeholder is fine for core flows.
    function deployPositionManager(address factory, address weth9, address tokenDescriptor)
        public
        returns (address positionManager)
    {
        bytes memory bytecode =
            abi.encodePacked(vm.getCode(POSITION_MANAGER_ARTIFACT), abi.encode(factory, weth9, tokenDescriptor));
        positionManager = _create(bytecode);
    }
}
