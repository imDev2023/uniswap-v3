// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {INonfungiblePositionManager} from "../interfaces/IUniswapV3Minimal.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

interface ILaunchpadTreasury {
    function treasury() external view returns (address);
}

/// @notice Permanent, trustless custodian for graduated LP positions (decision #6, ticket #17).
/// @dev Every graduated `TOKEN/WETH` position NFT is minted directly to this contract. The lock is
///      structural, not policy: this contract holds NO function that transfers, burns, approves, or
///      calls `decreaseLiquidity` on a position — so the principal liquidity can NEVER be withdrawn
///      or the NFT moved, by anyone, forever. Anyone can verify this by reading the (immutable)
///      bytecode. Only `collect()` is exposed, which sweeps accrued trading fees to the protocol
///      treasury (v1: 100% to treasury, decision #6 Q4b); it never touches principal.
///
///      The treasury is read live from the launchpad factory, so a future treasury change (an
///      owner-only, forward-looking param per decision #9) routes subsequent fee collections to the
///      new address without any power over the locked principal.
contract LPLock is IERC721Receiver {
    /// @notice The V3 NonfungiblePositionManager holding the actual position state.
    INonfungiblePositionManager public immutable positionManager;

    /// @notice The launchpad factory; source of the current treasury address.
    address public immutable launchpad;

    event FeesCollected(uint256 indexed tokenId, address indexed treasury, uint256 amount0, uint256 amount1);

    error ZeroAddress();

    constructor(address positionManager_, address launchpad_) {
        if (positionManager_ == address(0) || launchpad_ == address(0)) revert ZeroAddress();
        positionManager = INonfungiblePositionManager(positionManager_);
        launchpad = launchpad_;
    }

    /// @notice Collect a locked position's accrued trading fees and route them to the treasury.
    ///         Permissionless — anyone can trigger a collection, but the funds can only ever go to
    ///         the treasury, never to the caller. Principal liquidity is untouched.
    /// @return amount0 amount1 The fees collected in the pool's token0 / token1.
    function collect(uint256 tokenId) external returns (uint256 amount0, uint256 amount1) {
        address treasury = ILaunchpadTreasury(launchpad).treasury();
        (amount0, amount1) = positionManager.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId,
                recipient: treasury,
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
        emit FeesCollected(tokenId, treasury, amount0, amount1);
    }

    /// @notice Accept position NFTs (via safe transfer or mint). Holding is the whole point; there is
    ///         deliberately no way back out.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}
