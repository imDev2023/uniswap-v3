// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {LaunchToken} from "./LaunchToken.sol";

/// @notice Entry point for creating a token launch.
/// @dev Build 02 (#13): deploys a fixed-supply immutable LaunchToken and collects the
///      creation fee. The full 1B supply is minted to this factory as custodian — no
///      pre-mine to the creator (fair launch, decision #5). Later tickets (#14) route
///      the 800M curve allocation to a bonding curve and reserve 200M for graduation.
///      Fee/treasury are owner-adjustable and apply only to FUTURE launches (decision #9);
///      ownership is transferred to a multisig in Build 07 (#18).
contract LaunchpadFactory is Ownable {
    /// @notice Address that receives creation fees (and, later, protocol fees).
    address public treasury;

    /// @notice Flat fee to create a launch (default 0.01 ETH, decision #5).
    uint256 public creationFee;

    /// @notice Every token this factory has launched, in creation order.
    address[] public launches;

    /// @notice token => creator who launched it.
    mapping(address => address) public creatorOf;

    event LaunchCreated(address indexed token, address indexed creator, string name, string symbol);
    event CreationFeeUpdated(uint256 oldFee, uint256 newFee);
    event TreasuryUpdated(address oldTreasury, address newTreasury);

    error IncorrectCreationFee(uint256 sent, uint256 required);
    error ZeroTreasury();
    error FeeTransferFailed();
    error RefundFailed();

    constructor(address initialOwner, address treasury_, uint256 creationFee_) Ownable(initialOwner) {
        if (treasury_ == address(0)) revert ZeroTreasury();
        treasury = treasury_;
        creationFee = creationFee_;
    }

    /// @notice Number of launches created so far.
    function launchCount() external view returns (uint256) {
        return launches.length;
    }

    /// @notice Create a new token launch. The caller pays at least `creationFee`; any
    ///         excess is refunded. The full fixed supply is minted to this factory.
    /// @return token The newly deployed LaunchToken.
    function createLaunch(string calldata name, string calldata symbol)
        external
        payable
        returns (address token)
    {
        uint256 fee = creationFee;
        if (msg.value < fee) revert IncorrectCreationFee(msg.value, fee);

        token = address(new LaunchToken(name, symbol, address(this)));

        launches.push(token);
        creatorOf[token] = msg.sender;
        emit LaunchCreated(token, msg.sender, name, symbol);

        // Interactions last.
        if (fee > 0) {
            (bool ok,) = treasury.call{value: fee}("");
            if (!ok) revert FeeTransferFailed();
        }
        uint256 refund = msg.value - fee;
        if (refund > 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            if (!ok) revert RefundFailed();
        }
    }

    /// @notice Update the creation fee (applies to future launches only).
    function setCreationFee(uint256 newFee) external onlyOwner {
        emit CreationFeeUpdated(creationFee, newFee);
        creationFee = newFee;
    }

    /// @notice Update the treasury address (applies to future fees only).
    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroTreasury();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }
}
