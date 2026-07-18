// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

/// @notice Minimal subset of the Uniswap V3 factory interface used by the launchpad.
/// @dev Declared locally so our 0.8.x code never has to compile v3-core's 0.7.6 source.
interface IUniswapV3Factory {
    function owner() external view returns (address);

    function setOwner(address _owner) external;

    function feeAmountTickSpacing(uint24 fee) external view returns (int24);

    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool);

    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

/// @notice Minimal subset of the Uniswap V3 pool interface used by the launchpad.
interface IUniswapV3Pool {
    function initialize(uint160 sqrtPriceX96) external;

    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );

    function token0() external view returns (address);

    function token1() external view returns (address);

    function fee() external view returns (uint24);

    function setFeeProtocol(uint8 feeProtocol0, uint8 feeProtocol1) external;
}
