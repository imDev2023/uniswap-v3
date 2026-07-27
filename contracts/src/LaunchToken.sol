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

    /// @notice URI of this token's off-chain JSON metadata, in the NFT-standard shape
    ///         `{name, description, image, banner, links}` (build #24).
    /// @dev Deliberately a JSON document rather than a bare image URI, so richer fields can be
    ///      added later without deploying a new token contract.
    ///
    ///      **Write-once and permanent.** It is assigned in the constructor and there is NO setter —
    ///      not for the creator, not for the launchpad owner, nobody. That is the same fair-launch
    ///      guarantee the locked LP makes: what buyers saw at launch is what the token is forever,
    ///      and nobody can swap clean art for something else after people have bought.
    ///      (Solidity has no `immutable` for `string`; assign-in-constructor with no setter is the
    ///      enforcement, and it is verifiable from the bytecode.)
    ///
    ///      Two consequences follow from that permanence and are handled off-chain by design: an
    ///      unpinned or mistyped URI can never be corrected, so the UI must degrade to a fallback
    ///      avatar; and abusive imagery can never be removed on-chain, so moderation is a frontend
    ///      denylist rather than a contract capability.
    string public metadataURI;

    error ZeroRecipient();

    constructor(string memory name_, string memory symbol_, string memory metadataURI_, address recipient)
        ERC20(name_, symbol_)
    {
        if (recipient == address(0)) revert ZeroRecipient();
        metadataURI = metadataURI_;
        _mint(recipient, TOTAL_SUPPLY);
    }
}
