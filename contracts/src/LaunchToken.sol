// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice A launched project token: fixed supply, immutable, no mint, no owner.
/// @dev Fair-launch guarantees (decision #5): the entire supply is minted once at
///      construction to `recipient` (the launch's bonding curve / factory), there is
///      NO mint function, and the contract has no owner or admin — nothing about the
///      token can change after deployment. Buyers can verify this on-chain.
contract LaunchToken is ERC20 {
    /// @notice Fixed total supply for every launched token: 1,000,000,000 (18 decimals).
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;

    constructor(string memory name_, string memory symbol_, address recipient)
        ERC20(name_, symbol_)
    {
        require(recipient != address(0), "LaunchToken: zero recipient");
        _mint(recipient, TOTAL_SUPPLY);
    }
}
