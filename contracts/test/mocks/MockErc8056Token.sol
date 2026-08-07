// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.24;

/// @notice A tokenized-equity token in the shape chain 4663 defines: an ERC-20 whose corporate
///         actions move an on-chain `uiMultiplier()` instead of minting, burning or rebasing.
///
/// @dev Exists so `Erc8056Exposure.t.sol` can move a real multiplier rather than reason about one.
///      Per the chain profile, `underlying shares = raw token amount * uiMultiplier / 1e18`, and the
///      multiplier is exactly `1e18` on every such token until its first corporate action - which is
///      why a suite that never moves it proves nothing.
///
///      `newUIMultiplier` and `effectiveAt` are here because the profile's rule 4 names them: they
///      expose a scheduled change before it lands, and any position settling across that instant has
///      to decide deterministically which value it uses. Octopus reads neither, and the point of the
///      exposure test is that it reads neither.
contract MockErc8056Token {
    string public constant name = "Mock Tokenized Equity";
    string public constant symbol = "MEQ";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    /// @notice Shares per token, 18-decimal fixed point. `1e18` at launch, always.
    uint256 public uiMultiplier = 1e18;
    /// @notice A scheduled multiplier, visible before it takes effect.
    uint256 public newUIMultiplier;
    uint64 public effectiveAt;

    event MultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier);

    /// @notice Stage a corporate action without applying it yet.
    function scheduleMultiplier(uint256 multiplier, uint64 when) external {
        newUIMultiplier = multiplier;
        effectiveAt = when;
    }

    /// @notice Apply a corporate action immediately.
    /// @dev Permissionless because this is a mock and the test IS the issuer. Nothing about the
    ///      access control of the real issuer contract is being asserted here.
    function setMultiplier(uint256 multiplier) external {
        emit MultiplierUpdated(uiMultiplier, multiplier);
        uiMultiplier = multiplier;
        newUIMultiplier = 0;
        effectiveAt = 0;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}
