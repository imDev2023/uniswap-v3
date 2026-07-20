// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

/// @notice Test double for the GraduationManager: records the hand-off from a BondingCurve's
///         crossing buy without touching Uniswap V3. Used by the pure-curve unit tests so they can
///         exercise the crossing/refund/disable mechanics off-fork. The real seeding path is
///         covered by Graduation.t.sol against a live V3 deployment.
contract MockGraduationManager {
    uint256 public calls;
    address public lastToken;
    uint256 public raisedReceived;

    function graduate(address token) external payable returns (address pool) {
        calls++;
        lastToken = token;
        raisedReceived += msg.value;
        return address(uint160(uint256(keccak256(abi.encode("mock-pool", token)))));
    }
}
