// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.24;

/// @notice A faithful WETH9, so a test can stand up the whole graduation path without a fork.
///
/// @dev ⚠️ **This exists because a fork-based invariant CAMPAIGN is not viable on this project, and
///      that was measured rather than assumed.** The first version of `OctopusInvariants.t.sol` forked
///      mainnet like every other suite here. It never completed a single run: Foundry gives each
///      `invariant_` function its own campaign, each campaign re-runs `setUp` against the fork, and
///      every address the fuzzer touches that is not already in the local cache becomes an RPC call.
///      The archive endpoint returned HTTP 429 and all five campaigns died in the setup phase with
///      `runs: 0`. `CLAUDE.md` already warned that repeated back-to-back fork runs trip the limiter;
///      a campaign is that, thousands of times over, inside one command.
///
///      ⚠️ It is deliberately NOT a general replacement for the fork. `ForkConfig`'s rule stands for
///      every example-based suite: those read real deployed state, they run a fixed number of calls,
///      and forking is what makes them reproducible. This is the one shape where forking costs more
///      than it buys - the campaign reads no mainnet state at all. The only thing it needed the fork
///      for was a contract at `Constants.WETH9`, and that is the whole of what this replaces. The V3
///      factory, the position manager and the pools are still the real audited Uniswap bytecode,
///      deployed from the official artifacts by `V3Deployer` exactly as they are on a fork.
///
///      Faithful to the canonical WETH9 in the three behaviours anything here depends on: `deposit`
///      credits `msg.value`, `transferFrom` treats an infinite allowance as unlimited and never
///      decrements it, and a bare `receive` deposits. The `withdraw` path is included because leaving
///      out an entry point makes a mock a different contract, not a smaller one.
contract MockWETH9 {
    string public constant name = "Wrapped Ether";
    string public constant symbol = "WETH";
    uint8 public constant decimals = 18;

    event Approval(address indexed src, address indexed guy, uint256 wad);
    event Transfer(address indexed src, address indexed dst, uint256 wad);
    event Deposit(address indexed dst, uint256 wad);
    event Withdrawal(address indexed src, uint256 wad);

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        balanceOf[msg.sender] += msg.value;
        emit Deposit(msg.sender, msg.value);
    }

    function withdraw(uint256 wad) public {
        require(balanceOf[msg.sender] >= wad, "WETH: insufficient balance");
        balanceOf[msg.sender] -= wad;
        (bool ok,) = msg.sender.call{value: wad}("");
        require(ok, "WETH: ETH transfer failed");
        emit Withdrawal(msg.sender, wad);
    }

    /// @dev ⚠️ The real WETH9 reports `address(this).balance`, not a stored total. Reproduced rather
    ///      than replaced with a counter, because a mock that is more consistent than the thing it
    ///      stands in for is a mock that hides a bug the real contract would have surfaced.
    function totalSupply() public view returns (uint256) {
        return address(this).balance;
    }

    function approve(address guy, uint256 wad) public returns (bool) {
        allowance[msg.sender][guy] = wad;
        emit Approval(msg.sender, guy, wad);
        return true;
    }

    function transfer(address dst, uint256 wad) public returns (bool) {
        return transferFrom(msg.sender, dst, wad);
    }

    function transferFrom(address src, address dst, uint256 wad) public returns (bool) {
        require(balanceOf[src] >= wad, "WETH: insufficient balance");

        // ⚠️ Both halves of the canonical behaviour, and both matter to the position manager: a
        // sender moving their own balance needs no allowance, and an infinite allowance is never
        // decremented. `forceApprove` in `GraduationManager` sets a finite one, so the decrementing
        // branch is the live one here - but omitting the other would make this a subtly different
        // token from the one that is actually deployed.
        if (src != msg.sender && allowance[src][msg.sender] != type(uint256).max) {
            require(allowance[src][msg.sender] >= wad, "WETH: insufficient allowance");
            allowance[src][msg.sender] -= wad;
        }

        balanceOf[src] -= wad;
        balanceOf[dst] += wad;
        emit Transfer(src, dst, wad);
        return true;
    }
}
