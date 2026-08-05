// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.24;

/// @notice Robinhood Chain canonical addresses and identifiers.
/// @dev Addresses are from the official Robinhood Chain docs (docs.robinhood.com/chain/contracts/).
///      Tests assert on-chain that WETH9 actually has code on the fork.
library Constants {
    uint256 internal constant CHAIN_ID_MAINNET = 4663;
    uint256 internal constant CHAIN_ID_TESTNET = 46630;

    /// @dev Canonical wrapped-native (WETH9-equivalent) on Robinhood Chain mainnet.
    address internal constant WETH9 = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;

    /// @dev Canonical stablecoin (Global Dollar / USDG) on Robinhood Chain mainnet.
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    /// @dev Uniswap V3 fee tier used by graduated pools (1.00%).
    uint24 internal constant POOL_FEE_TIER = 10000;
}
