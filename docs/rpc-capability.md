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
It is strictly read-only and never signs or sends a transaction.
It accepts any URL, so it doubles as the evaluation harness for candidate providers.
Re-run it before picking a provider and after any node upgrade.

## Headline result

**The "Postgres is a derived cache" assumption holds on mainnet.**

Mainnet 4663 serves `eth_getLogs` from block 0.
Unfiltered windows at eleven depths, from the head down to block 0 itself, all returned real logs and none errored for a non-capacity reason.
That was the open question that could have killed the architecture: if mainnet pruned logs below the deploy block, re-indexing would be impossible and losing the indexer database would become permanent data loss rather than an availability incident.
It does not.
Losing the indexer DB stays an availability incident, recoverable by re-indexing from genesis.

Note the evidence is deliberately unfiltered.
An address-filtered query returning `[]` is ambiguous, because an idle contract and a pruned node look identical.
On a chain producing blocks continuously, an empty *unfiltered* window is implausible, so a non-empty result is real proof that logs survive at that depth.

## Mainnet 4663 vs testnet 46630

| | mainnet 4663 | testnet 46630 |
| --- | --- | --- |
| Client | Arbitrum Nitro `v3.11.3-rc.5-4130f4c` | same |
| Chain age | 89.5 days (from block 1) | 172.5 days |
| Head block | ~22,148,000 | ~94,803,000 |
| Recent block time | **0.100 s** | 0.296 s |
| Lifetime average block time | 0.349 s | 0.157 s |
| Head timestamp vs wall clock | +1 s | +1 s |
| **Log retention** | **block 0, no pruning** | block 0, no pruning |
| Log cap, span <= 1000 | **50,000 matched logs** | not demonstrable (too sparse to reach any cap) |
| Log cap, span >= 1001 | **10,000 matched logs** | 10,000 |
| Block-span cap | none; only the log caps bind | none |
| **Historical state, consistently served** | **5,000 blocks (~9 min)** | 5,000 blocks (~26 min) |
| Historical state, deeper | **INTERMITTENT at 4 of 9 depths** | never served beyond 5,000 |
| `eth_call` at `latest` | works | works |
| Multicall3 | present, `sha256:0fb6a9dbcc4e1709` | present, identical hash |
| WETH9 | `0x0Bd7D308…AD73`, `sha256:e980519ff078267d` | `0x7943e237…52Fa`, identical hash |
| USDG | present (170 B) | no code |
| JSON-RPC batch | supported | supported |
| 30 concurrent requests | 30/30 in ~300 ms | 30/30 in ~300 ms |
| `eth_syncing`, filters, `debug_*`, `trace_*` | absent | absent |

## What each result means for the build

### Log retention: the architecture is safe

No pruning at any depth, and no cap on the block span itself.
A full re-index from the deploy block is possible today and there is no retention cliff to race.

One caveat worth keeping: this is a property of the current public nodes, not a protocol guarantee.
An operator can enable log pruning at any time without notice.
Re-run the probe periodically, and treat a change here as an architecture-level incident rather than an ops nuisance.

### There are TWO log caps, and the block span selects which one applies

The refusal text reads `logs matched by query exceeds limit of 10000`, which sounds like one flat result cap.
It is not, and taking it at face value would size every indexer chunk wrongly.

- A query spanning **1000 blocks or fewer** is allowed **50,000** matched logs.
- A query spanning **1001 blocks or more** is allowed only **10,000**.

Measured directly: in a mainnet region with ~60 logs per block, a span-600 query returned 42,554 logs happily, span-700 was refused at the 50,000 ceiling, and span-1001 was refused at the 10,000 ceiling.
Neither limit constrains the block span itself, only the number of matched logs.

**Practical rule: chunk log scans at span <= 1000.**
That regime tolerates five times as many logs per request, so the same backfill costs far fewer round trips.
Crossing to 1001 blocks per request makes throughput worse, not better.

### Mainnet blocks are 3x faster than testnet, and that hits the indexer

Mainnet produces blocks at **0.100 s**, against 0.296 s on testnet.
That is roughly **864,000 blocks per day**.

On testnet at ~0.3 s blocks the **block ingestor**, not the log scan, is already the documented bottleneck, and stock graph-node settings never converge.
Mainnet is about 3x worse.
Assume the tuned compose settings that hold ~40 s of lag on testnet will **not** be sufficient on mainnet, and budget indexer tuning as real work rather than a config copy.
This is the single most likely operational surprise in Stage 4.

### Historical state on mainnet is unreliable, not merely shallow

This is the most surprising result, and it corrects an earlier reading of the same endpoint.

A single binary search suggested mainnet retained state ~21 days deep.
Repeating the search gave a completely different answer, and repeating individual queries explained why: **one URL fronts a pool of nodes that retain different depths.**
The client string alternates between `linux-arm64` and `linux-amd64` between calls, which is the same pool showing itself.

Repeating the identical `eth_call` four times at each depth:

| blocks back | served | verdict |
| --- | --- | --- |
| 1,000 | 4/4 | consistent |
| 5,000 | 4/4 | consistent |
| 10,000 | 3/4 | INTERMITTENT |
| 50,000 | 4/4 | consistent |
| 100,000 | 3/4 | INTERMITTENT |
| 1,000,000 | 4/4 | consistent |
| 5,000,000 | 2/4 | INTERMITTENT |
| 10,000,000 | 3/4 | INTERMITTENT |
| 20,000,000 | 0/4 | never served |

Availability is not monotonic in depth, so there is no boundary to find.
**Only 5,000 blocks back (~9 minutes) is consistently served.**
Deeper queries succeed or fail depending on which node answers.

Consequences:

- **Mainnet fork tests must stay within ~5,000 blocks of the head**, and must read the head at runtime.
  This is what `QuoterV2.t.sol` already does on testnet.
  A deeper fork block will pass locally and fail intermittently in CI, which is a genuinely nasty failure mode.
- Any product feature needing state older than a few minutes must derive it from logs rather than a historical `eth_call`.
  The subgraph already derives everything from events and makes no `eth_call` at all, so it is unaffected.
- A retry-on-another-connection strategy partially mitigates this, since a retry may land on a node that has the data.

Testnet 46630 behaves differently and more simply: consistently served to 5,000 blocks (~26 min), never served beyond.
That corroborates the ~5,600-block figure already recorded in `CLAUDE.md`, and shows no intermittency at all.

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

### Head timestamps track wall clock

Head block timestamps sat 1 second from local wall clock on both chains.
This supports the Stage 2 lag measurement: comparing `_meta.block.timestamp` against the RPC head timestamp is skew-free, and the 300 s threshold means what it is intended to mean.
The measurement is only as good as the local clock, which the probe states rather than assumes away.

### Contracts the frontend depends on are present

Multicall3 is at the canonical address on both chains, and the probe hashes the bytecode rather than only comparing lengths, so "identical" is a real claim: both return `sha256:0fb6a9dbcc4e1709`.
The two-round resolution in `useOnchainToken.ts` therefore works on mainnet as it does on testnet.

WETH9 hashes identically on both chains too (`sha256:e980519ff078267d`), which independently substantiates the "byte-identical proxy and implementation" note in `CLAUDE.md`.
Mainnet USDG has code; on testnet the mainnet USDG address has none.
`Constants.WETH9` is confirmed correct for mainnet, and the reminder still stands that it has no code on 46630, so `WETH9=` must always be passed explicitly.

### Rate limiting is real but generous

Bursts of 30 concurrent requests all succeeded in ~300 ms on both chains.
Sustained heavy log probing did trip HTTP 429 a handful of times per run.
The probe counts 429s explicitly rather than hiding them inside retries, so the number in the Summary section is trustworthy.
The limit's exact shape is still uncharacterised, which matters because browser traffic scales with users.

## Three measurement traps

All three produced confidently wrong readings before being caught.
They are recorded because any future probe, ours or a provider's own documentation, can fall into them.

### `eth_getBalance` reports success on pruned state

On Nitro, `eth_getBalance` against an unreadable block returns `0x0` with **no error**, indistinguishable from a genuine zero balance.
Measuring archive depth with it reports "full archive" on a node that has pruned nearly everything.
The first version of this probe did exactly that and claimed both chains were full archives.

`eth_call` surfaces the truth, as either `missing trie node ... is not available` or `metadata is not found, <block>`.
**Always measure archive depth with `eth_call`.**
The probe now runs both at each depth and reports the disagreement explicitly.

### A single sample cannot measure a load-balanced endpoint

Binary searching for a retention boundary assumes the answer is monotonic and stable.
Behind a pool of nodes it is neither, and two searches minutes apart disagreed by millions of blocks.
Any capability that varies per node has to be measured by repetition, and reported as a rate rather than a threshold.

### Fixed-width log windows measure nothing on a busy chain

A fixed 5,000-block window blew the log cap at every sampled depth on mainnet, so every row read `ERROR` and the retention question went unanswered while looking like it had been tested.
Worse, a cap refusal actually *proves* logs exist at that depth, so counting it as evidence of pruning inverts its meaning.
The probe now shrinks the window until the node answers, and classifies cap refusals separately from real failures.

## Open Stage 4 items this does not answer

- **A second endpoint has not been sourced.**
  Stage 4 calls for two endpoints with failover, and only the official public URL has been measured.
  It is already a load-balanced pool, but that is one operator behind one DNS name and is not independent failover.
  The state-availability variance above makes a second, more consistent provider more valuable than it first appeared.
- **Rate limits are not characterised.**
  429s were observed and counted, but the limit's shape (per second, per IP, burst allowance) is unmeasured.
- **Postgres `C` collation** for any managed provider is still unverified, and can only be set at cluster creation.
- Whether any managed subgraph host supports chain 4663 at all is still unasked.
