// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

/// @notice The one place that says WHICH endpoint and WHICH block every fork test forks from.
///
/// @dev Two rules, and both of them are the same rule seen from different ends.
///
///      **Every fork block is pinned.** A fork test that forks at `latest`, or at `head - N` read at
///      run time, is not a test of our code - it is a test of our code against whatever the chain
///      happened to contain when the suite ran. It cannot be re-run to reproduce a failure, and it
///      fails for reasons that have nothing to do with the diff. Pinned, `forge` caches the fetched
///      state under `~/.foundry/cache/rpc/<chain>/<block>/`, so after the first run the suite reads
///      from disk and does not touch the network at all.
///
///      **Every fork uses an ARCHIVE endpoint.** That is what pinning costs: the public endpoints
///      prune state after roughly 5,000 blocks (~26 min on testnet, ~9 min on mainnet), so a pinned
///      block is unservable by them within the hour. Measured 2026-08-01: an `eth_call` against a
///      live pool at testnet block 95,062,912 returns `-32000 missing trie node` from the public
///      endpoint and answers normally from the archive endpoint. So archive access is not a nicety
///      here - it is the precondition for a fork test being reproducible at all.
///
///      Set `RPC_MAINNET_ARCHIVE_URL` / `RPC_TESTNET_ARCHIVE_URL` in `contracts/.env` (forge loads
///      it automatically); `contracts/.env.example` says how. Without them `forge test` fails on the
///      fork tests with a missing-environment-variable error, which is the intended behaviour: a
///      fork test silently falling back to a pruning endpoint is how the flakiness got in.
library ForkConfig {
    /// @dev `foundry.toml` `[rpc_endpoints]` aliases. Deliberately NOT the plain `robinhood` /
    ///      `robinhood_testnet` aliases - those are the pruning public endpoints, kept for
    ///      broadcasting and head reads.
    string internal constant MAINNET = "robinhood_archive";
    string internal constant TESTNET = "robinhood_testnet_archive";

    /// @dev Mainnet 4663. Chosen because `Graduation.t.sol` and `LpLock.t.sol` already pinned it, so
    ///      every mainnet fork test now shares one warm cache entry instead of one per suite.
    uint256 internal constant MAINNET_BLOCK = 14_068_850;

    /// @dev Testnet 46630. Comfortably after the deployments the fork tests read (the current
    ///      launchpad's `startBlock` is 94,091,260) and a round number so it is obvious it was
    ///      chosen rather than captured. Only move it when a test needs state that did not exist
    ///      yet - moving it costs a fresh archive fetch and a new cache entry.
    uint256 internal constant TESTNET_BLOCK = 95_000_000;
}
