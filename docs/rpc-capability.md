# RPC capability - measured

Stage 4 treats RPC as the stack's number one dependency.
The frontend calls it directly from users' browsers and the indexer calls it to build its entire state.
It is also the only component with no graceful degradation.

This document records what the Robinhood Chain public endpoints actually do, measured rather than assumed.

**Measured 2026-07-29 against mainnet 4663 for the first time.**
Everything here was previously unknown for mainnet.

## Re-running

```bash
node scripts/rpc-probe.mjs mainnet
node scripts/rpc-probe.mjs testnet
node scripts/rpc-probe.mjs https://candidate-provider.example/rpc --json out.json
```

The script has no dependencies and needs Node 18+.
It accepts any URL, so it doubles as the evaluation harness for candidate providers.
Re-run it before picking a provider and after any node upgrade.

## Headline result

**The "Postgres is a derived cache" assumption holds on mainnet.**

Mainnet 4663 serves `eth_getLogs` from block 0 with no pruning at any sampled depth.
That was the open question that could have killed the architecture: if mainnet pruned logs below the deploy block, re-indexing would be impossible and losing the indexer database would become permanent data loss rather than an availability incident.
It does not.
Losing the indexer DB stays an availability incident, recoverable by re-indexing from genesis.

## Mainnet 4663 vs testnet 46630

| | mainnet 4663 | testnet 46630 |
| --- | --- | --- |
| Client | Arbitrum Nitro `v3.11.3-rc.5-4130f4c` | same |
| Chain age | 89.4 days (block 1) | 172.5 days |
| Head block | ~22,128,000 | ~94,797,000 |
| Recent block time | **0.100 s** | 0.252 s |
| Lifetime average block time | 0.349 s | 0.157 s |
| Head timestamp vs wall clock | 0 s skew | 1 s skew |
| **Log retention** | **block 0, no pruning** | block 0, no pruning |
| `eth_getLogs` block-span cap | none found (full history in one call) | none found |
| `eth_getLogs` result cap | **10,000 logs**, hard error | 10,000 logs |
| State (archive) retention | **18,153,000 blocks = ~21.1 days** | 6,250 blocks = ~27 min |
| `eth_call` at `latest` | works | works |
| Multicall3 | present (3,808 B) | present (3,808 B) |
| WETH9 | present at `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | present at `0x7943e237c7F95DA44E0301572D358911207852Fa` |
| USDG | present (170 B) | no code |
| JSON-RPC batch | supported | supported |
| 30 concurrent requests | 30/30 in ~300 ms | 30/30 in ~300 ms |

## What each result means for the build

### Log retention: the architecture is safe

No pruning at any depth, and no block-span cap.
A full re-index from the deploy block is possible today and there is no retention cliff to race.

One caveat worth keeping: this is a property of the current public node, not a protocol guarantee.
A node operator can enable log pruning at any time without notice.
Re-run the probe periodically, and treat a change here as an architecture-level incident rather than an ops nuisance.

### The 10,000-log result cap shapes indexer chunking

`eth_getLogs` refuses any query matching more than 10,000 logs with `-32000 logs matched by query exceeds limit of 10000`.
There is no cap on the block span itself, only on the result count, so the safe chunk size depends entirely on log density rather than on a fixed block count.

Measured density on mainnet is high: unfiltered 1,000-block windows routinely return 24,000 to 47,000 logs.
Our own subgraph filters by specific contract addresses, so its queries will be far below the cap in normal operation.
The cap is still the thing to watch during initial sync and during any unfiltered scan.

### Mainnet blocks are 2.5x faster than testnet, and that hits the indexer

Mainnet produces blocks at **0.100 s**, against 0.252 s on testnet.
That is roughly **864,000 blocks per day**.

On testnet at 0.3 s blocks the **block ingestor**, not the log scan, is already the documented bottleneck, and stock graph-node settings never converge.
Mainnet is 2.5x to 3x worse.
Assume the tuned compose settings that hold ~40 s of lag on testnet will **not** be sufficient on mainnet, and budget indexer tuning as real work rather than a config copy.
This is the single most likely operational surprise in Stage 4.

### State retention is 21 days on mainnet, and it is a moving window

Mainnet serves historical state about 18.15 million blocks back, which is ~21.1 days.
Testnet serves only 6,250 blocks, ~27 minutes, which corroborates the ~5,600 figure already recorded in `CLAUDE.md`.

Consequences:

- Fork tests against mainnet get a comfortable window, but it is still a **moving** window.
  A hardcoded block number rots after ~21 days.
  Keep doing what `QuoterV2.t.sol` already does on testnet: read the head at runtime and fork a fixed offset back.
- Anything needing state older than ~21 days must be reconstructed from logs, not read with a historical `eth_call`.
  The subgraph already derives everything from events and makes no `eth_call` at all, so it is unaffected.

### `fromBlock: "earliest"` is rejected

Both chains reject the `earliest` keyword with `-32602 expected fromBlock to be a hex string starting with 0x`.
Any re-index tooling must pass an explicit hex block number.
This is a trap for hand-written recovery scripts, which commonly reach for `earliest`.

### Filter and trace methods are absent

`eth_newFilter`, `eth_getFilterChanges`, `debug_traceTransaction` and `trace_block` are all unavailable on both chains.
graph-node polls with `eth_getLogs` rather than using server-side filters, so this does not affect the indexer.
It does rule out trace-based tooling, and it rules out any provider evaluation that assumes debug namespace access.

`eth_syncing` is also absent, so node-side sync state cannot be queried.
That reinforces the Stage 2 decision to measure indexer lag from block timestamps.

### Head timestamps track wall clock exactly

Head block timestamps matched wall clock to within 0 s on mainnet and 1 s on testnet.
This confirms the Stage 2 lag measurement is sound: comparing `_meta.block.timestamp` against the RPC head timestamp is skew-free, and the 300 s threshold means what it is intended to mean.

### Contracts the frontend depends on are present

Multicall3 is at the canonical address on both chains with identical 3,808-byte code, so the two-round resolution in `useOnchainToken.ts` works on mainnet as it does on testnet.
Mainnet WETH9 and USDG both have code, and `Constants.WETH9` is confirmed correct for mainnet.
The reminder still stands that it has no code on 46630, so `WETH9=` must always be passed explicitly.

## Two measurement traps

Both of these produced confidently wrong readings before being caught.
They are recorded because any future probe, ours or a provider's own documentation, can fall into them.

### `eth_getBalance` reports success on pruned state

On Nitro, `eth_getBalance` against a pruned block returns `0x0` with **no error**, which is indistinguishable from a genuine zero balance.
Measuring archive depth with it reports "full archive" on a node that has pruned nearly everything.
The first version of this probe did exactly that and claimed both chains were full archives.

`eth_call` surfaces the truth as `missing trie node ... is not available`.
**Always measure archive depth with `eth_call`.**
The probe now runs both at each depth and reports the disagreement explicitly.

### Fixed-width log windows measure nothing on a busy chain

A fixed 5,000-block window blew the 10,000-log cap at every sampled depth on mainnet, so every row read `ERROR` and the retention question went unanswered while looking like it had been tested.
The probe now shrinks the window until the node answers and reports the width that worked.

A related hazard is the reverse: a node that returns `[]` instead of erroring for pruned ranges would look identical to a genuinely idle chain.
The probe queries unfiltered windows precisely so that an empty result is implausible rather than ambiguous, and warns loudly if one appears.

## Open Stage 4 items this does not answer

- **A second endpoint has not been sourced.**
  Stage 4 calls for two endpoints with failover, and only the official public URL has been measured.
  The client string alternated between `linux-arm64` and `linux-amd64` across calls, so the single URL is already a load-balanced pool of heterogeneous nodes, but that is one operator behind one DNS name and is not independent failover.
- **Rate limits were not characterised.**
  30 concurrent requests all succeeded, and a single HTTP 429 appeared during heavy probing, so a limit exists but its shape is unmeasured.
  Browser traffic scales with users, so this needs a real answer before launch.
- **Postgres `C` collation** for any managed provider is still unverified, and can only be set at cluster creation.
- Whether any managed subgraph host supports chain 4663 at all is still unasked.
