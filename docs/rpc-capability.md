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
node scripts/rpc-probe.mjs https://throttled-candidate.example/rpc --min-interval 10000
node scripts/rpc-probe.mjs --self-test

# The Alchemy endpoints, which live in contracts/.env (never commit them):
set -a && . ./contracts/.env && set +a
node scripts/rpc-probe.mjs "$RPC_TESTNET_ARCHIVE_URL"
node scripts/rpc-probe.mjs "$RPC_MAINNET_ARCHIVE_URL"
```

⚠️ The Alchemy URLs embed the API key, and the probe prints the endpoint it was given.
Mask it before pasting output anywhere: `| sed -E 's#(/v2/)[A-Za-z0-9_-]+#\1<key>#g'`.

`--self-test` runs offline with no network and no endpoint. It covers **two** classifiers, in separate case tables:
how a reply is classified (throttle / not-a-JSON-RPC-endpoint / real data), and whether a failure is the node refusing an over-large query.
Both have been wrong in production, in both directions, and both fail *silently* while inverting a conclusion - so run it after touching either.

The script has no dependencies and needs Node 18+.
Pacing self-tunes: each throttle response raises a floor on the gap between calls, so a hard rate-limited candidate is measured slowly instead of being written off as broken.
`--min-interval` sets that floor up front when the provider's published limit is already known.
A full run is ~150 calls, so a 10 s floor means roughly 25 minutes.
All output is emitted at the end, so a run killed early prints nothing.

⚠️ **Repeated back-to-back runs trip the official endpoint's own limiter**, after which the adaptive floor ratchets toward its 20 s ceiling and a run that normally takes two minutes takes closer to an hour, silently.
That is the pacing working as intended, but it means a burst of consecutive runs measures a degraded endpoint.
Space runs out, and treat timing-derived figures from a self-throttled run as not comparable.
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

## Four measurement traps

All four produced confidently wrong readings before being caught.
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

### A throttle looks exactly like an incapability

This one was found by pointing the probe at its first real candidate rather than at the official endpoint.

The probe's `Identity` section used to issue its four calls concurrently.
Against a candidate allowing **one request every ten seconds**, three of the four were refused, and the probe reported `FATAL endpoint unusable`.
The endpoint was fine.
We were talking too fast, and the probe had blamed the endpoint for our own traffic.

That is the same shape as the three traps above, and more dangerous now that this script is the provider-evaluation harness: taken at face value it would reject every aggressively rate-limited candidate, which describes most free tiers.

The refusal is also easy to misparse.
The same endpoint replies in at least three different ways depending on load: a JSON-RPC result, an HTTP 429 with a JSON body whose `error` is a bare **string** rather than a JSON-RPC error object, and - under sustained load - an **HTML Cloudflare interstitial under HTTP 200**.
A strict parser calls the last two "non-JSON response" and a status-only check calls the third one success.

The probe now:

- issues identity calls **sequentially**, since there was never anything to gain by racing four cheap calls,
- reports `THROTTLED` distinctly from `FATAL`, and prints the provider's own words,
- detects throttling from the body as well as the status, including HTML interstitials and string-valued `error` fields,
- **raises a global pacing floor on every throttle and keeps going** at the slower rate, rather than concluding the endpoint is broken (`--min-interval` sets that floor up front),
- and **skips the concurrency burst entirely when pacing is active**, because a paced burst measures the probe's own pacer.
  Reporting that number as the endpoint's concurrency would be a confident statement about the wrong thing.

The inverse error is just as easy, and the first fix walked straight into it: treating *any* HTML body as throttling.
A typo'd URL then reports as `THROTTLED` and advises slowing down, after burning the whole retry ladder to get there.
An HTML body now counts as throttling only when it says so or arrives under a status that means so (403/429/503), and is otherwise reported as "not a JSON-RPC endpoint".
For the same reason the rate-limit pattern is deliberately narrow: an earlier version matched a bare `429`, so a reply whose *result* contained those characters - a block number like `0x429ab1` - was read as a refusal.

**Corollary for reading provider documentation: measure it, do not trust it.**
On the one candidate measured here the published page was wrong in both directions - the stated rate limit was 20x more generous than reality, and heavy methods documented as key-gated were served without a key.

## Second endpoint: candidate survey

**Measured 2026-07-30.**
Stage 4 wants two endpoints with failover.
Every candidate below was checked directly rather than taken from a listicle.

| candidate | chain 4663 | keyless | verdict |
| --- | --- | --- | --- |
| `rpc.mainnet.chain.robinhood.com` (official) | yes | yes | the current primary; a load-balanced pool, so not independent failover |
| **NodeFlare** `rpc.nodeflare.app/robinhood/public` | yes | yes | functional but **1 req / 10 s per IP** - unusable for browser traffic |
| **dRPC** `robinhood-mainnet.drpc.org` | yes | no | `chain is not available on free plan` - paid only |
| **thirdweb** `4663.rpc.thirdweb.com` | **no** | - | `Invalid chain` |
| **Ankr** `rpc.ankr.com/robinhood` | no | - | key required and chain not permitted |
| `sequencer.mainnet.chain.robinhood.com` | n/a | yes | reachable but tx-submission only (`eth_blockNumber does not exist`) |
| **Alchemy** (Robinhood's recommendation), QuickNode, Blockdaemon, Validation Cloud | yes | no | account required; not yet measured |

Two things follow.

**There is no usable keyless second endpoint.**
Sourcing real redundancy requires an account, which is a decision with a billing tail rather than a task to execute.
Robinhood's own docs recommend Alchemy and it is the only provider documented with both mainnet and testnet URLs plus archive support.

**NodeFlare's paid-free tier is the cheapest plausible secondary.**
Its keyless tier already served `eth_getLogs` and `eth_call` correctly, so the capability is there; a free API key is advertised at 10 req/s.
That is far too slow to be a primary but adequate as a failover target, which is the role that matters.

Note that both `VITE_RPC_URL` and `VITE_RPC_URL_2` ship inside the browser bundle and therefore cannot hold a secret.
Any metered key needs domain allowlisting or a proxy.

### Alchemy - measured 2026-08-01, and the account now exists

An Alchemy key is present in `contracts/.env` as `ALCHEMY_API_KEY` / `ENDPOINT_URL`.
**One key serves both chains**, confirmed by `eth_chainId`: the URL in `.env` is the `robinhood-testnet` subdomain and returns `0xb626` (46630); swapping the subdomain to `robinhood-mainnet` returns `0x1237` (4663).

**It is a genuine archive node, and that is a large capability gain over the public endpoint.**
`launchCount()` on the live testnet factory, same call, same block heights:

| depth below head | Alchemy | public endpoint |
| --- | --- | --- |
| 5,000 | `14` | `14` |
| 50,000 | `14` | `missing trie node … not available` |
| 500,000 | `12` | `missing trie node … not available` |
| 1,000,000 | `1` | not attempted |
| 1,800,000 | `1` | not attempted |

The returned values are real history (14 now, 12 at -500k, 1 before the seeding), not a constant, so this is genuine state and not a cached answer.
Mainnet 4663 behaves the same: WETH9 `totalSupply()` returns sane, monotonically-different values at **20,000,000 blocks** below head.

⚠️ **But the account is on the FREE tier, and that tier caps `eth_getLogs` at a 10-block range.**
The refusal is explicit on both chains: *"Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range."*
A span of 10 already fails, because the range is inclusive.
graph-node scans in 1000-block ranges, so **Alchemy's free tier cannot back the indexer at all** - it would be ~100x more requests for the same ground, before any rate limit.

**The two endpoints are therefore complementary rather than interchangeable, and that settles the "which key where" question empirically:**

| workload | needs | use |
| --- | --- | --- |
| **Indexer** (graph-node) | wide `eth_getLogs`; **zero** `eth_call` by design | **public endpoint** - Alchemy free tier is unusable here |
| **Frontend** (browser) | `eth_call` / Multicall3; almost no `getLogs` | **Alchemy** primary, public as fallback |
| **Fork tests** (forge) | archive state at a pinned block | **Alchemy** - this removes the ~5,000-block ceiling |

✅ **Both halves of that split are now WIRED (build #32).**
The frontend's `VITE_RPC_URL` points at the Alchemy testnet URL in `frontend/.env.local`, with the public endpoint arriving automatically as the last resort; every fork test is pinned and forks from `robinhood_archive` / `robinhood_testnet_archive` (`contracts/foundry.toml`, `contracts/test/ForkConfig.sol`).
The indexer is untouched and stays on the public endpoint, for the reason in the table.

✅ **Consequence for fork tests, applied in #32.** The standing rule "read the head at runtime and fork ~300 blocks back, because state is pruned after ~5,000" existed only because of the public endpoint's pruning. Against an archive endpoint a **pinned historical block number works**, so all six fork suites are now pinned - four of them (`BondingCurve`, `V3Harness`, `LaunchpadFactory`, `OwnershipAndParams`) had been forking at `latest` and re-fetching live state on every run, which is the most likely source of the 8-failure flake seen on 2026-07-31. Pinning also makes the fetched state cache to disk under `~/.foundry/cache/rpc/<chain>/<block>/`, so the whole 84-test suite runs in ~1.2s offline after the first fetch.

### Alchemy, full probe - measured 2026-08-01 (build #32)

`node scripts/rpc-probe.mjs "$RPC_TESTNET_ARCHIVE_URL"`, and the same for mainnet. Both endpoints, 139-141 calls each, **zero 429s and zero timeouts**.

| | Alchemy testnet 46630 | Alchemy mainnet 4663 | public endpoints |
| --- | --- | --- | --- |
| `eth_getLogs` retention | **no pruning, logs at block 0** | same | no pruning |
| `eth_getLogs` max span | **10 blocks** (free tier) | **10 blocks** (free tier) | no span cap; 50,000 / 10,000 matched-log caps |
| archive `eth_call` | **4/4 consistent at every sampled depth to 20,000,000 back** | same, to 20,000,000 back | intermittent past ~5,000, non-monotonic |
| `eth_call` at `latest` | works | works | works over bare RPC |
| JSON-RPC batch | **supported** | supported | - |
| 30 concurrent | 30/30 in 537 ms | 30/30 in 195 ms | 30/30 |
| `debug_traceTransaction`, `trace_block`, `eth_newFilter` | **available** | available | **absent** |
| measured block time | 0.215 s | **0.100 s** | matches |

Two things here are new rather than confirmations.
**The archive depth is not a window with an edge**: every sampled depth answered 4/4, including 20,000,000 blocks back, so there is no intermittency to design around and a pinned block is safe.
And **trace and filter methods exist**, which the public endpoints do not offer at all - not needed today, but it is the only endpoint on which a trace-based debugging session is possible.

⚠️ **Still unmeasured:** the free tier's request-rate ceiling (nothing throttled across ~280 calls, so the ceiling is above that but its shape is unknown), and whether a paid tier lifts the 10-block log range enough to serve the indexer.

### ⚠️ The probe misread the free-tier cap as pruning, which is trap #3 in a new costume

Worth recording because the probe is the instrument the rest of this document is built on, and it produced a **confidently inverted** reading the first time it was pointed at a metered provider.

`isQueryTooBig` recognised only *result-count* refusals (`exceeds limit of 10000`). Alchemy refuses on *block range* (`up to a 10 block range`, JSON-RPC `-32600`), which did not match - so the span-shrinking loop never ran, all eleven depths were recorded as hard errors, and the verdict read **`11 depth(s) failed for a NON-CAP reason - inspect the table`**. Read literally, that says the endpoint may be pruning logs. It is the exact inversion trap #3 warns about: a cap refusal *proves* logs exist at that depth.

Fixed in #32: `isQueryTooBig` matches both cap styles, and `parseRangeCap` honours the span the node names instead of blindly dividing down. The verdict on the same endpoint is now **`NO PRUNING - logs served and non-empty down to the genesis region`**.

⚠️ A second, quieter failure rode along with it. The first fix landed on span 2 rather than 9 (an inclusive-range off-by-one), and at span 2 two of the eleven windows came back **empty** - firing the "a node that prunes logs silently looks exactly like this" warning. The windows were not empty because anything was missing; they were too narrow to contain a log. **A sampling window that is too small manufactures the appearance of absence**, which is trap #4 in the making: with the span corrected to 9, all eleven windows are non-empty.

The probe's `--self-test` now covers this classifier as its own case table (28 cases, up from 18), because getting it wrong is silent and flips a conclusion. Mutation-checked: dropping `block range` from the pattern fails 3 cases, narrowing the range parser fails 2.

### ⚠️ The probe also printed guidance that contradicted its own measurement

Under a table showing every depth answering 4/4, it printed *"It is a MOVING window, so read the head at runtime rather than hardcoding a block number."*
That advice was hardcoded from the public endpoint this probe was first written against, and against an archive node it tells an operator to **undo** the pinning that makes fork tests reproducible.
It is now conditional on what was measured: when no sampled depth is unreliable, the probe says to pin.

**The generalisable point:** a measurement tool that carries fixed advice will eventually give the wrong advice with the authority of a measurement. Advice has to be derived from the reading, not printed alongside it.

**QuickNode credentials also exist** in `contracts/.env` (`QUICKNODE_API_KEY`, `QUICKNODE_TOKEN`), but **no QuickNode endpoint URL is recorded**, and a QuickNode URL embeds a per-endpoint hostname that cannot be derived from the token. Unmeasured for that reason.

## How the frontend consumes two endpoints

`frontend/src/lib/wagmi.ts` wires the resolved endpoint list into viem's `fallback` transport.
`frontend/src/lib/rpcEndpoints.ts` owns the ordering as a pure function: `VITE_RPC_URL`, then `VITE_RPC_URL_2`, then the chain's documented public endpoint, deduplicated.

The public endpoint is always appended as a last resort.
It is rate limited and Robinhood states it is unsuitable for production, but RPC is the one dependency with no degraded mode, and a throttled app beats a dead one.

Three decisions worth recording, because each depends on viem's actual behaviour rather than on what the API suggests.
All three are pinned by tests in `frontend/src/lib/rpcFailover.test.ts`, which assert viem's semantics deliberately - a viem upgrade that changed them would otherwise turn this redundancy into either dead weight or a correctness bug.

**`rank: false`, i.e. strict preference rather than latency-ranked.**
Ranking would periodically measure each endpoint and reorder by score.
That is wrong here: the last entry is always the rate-limited public endpoint, and a latency probe can make it look attractive at exactly the moment the dedicated primary is busy.

**A single-URL `fallback` is not redundancy.**
viem forces `retryCount: 0` on the inner transports and retries from the first one, so one URL wrapped in `fallback` behaves exactly like a bare `http()`.
Failover only begins to exist at two distinct endpoints, which is why `VITE_RPC_URL_2` is the setting that matters rather than the transport change itself.

**The deep-state miss fails over, and a revert does not.**
This is the property that makes a second provider worth having, and it is a narrow one:

- The pruned-state errors measured above (`missing trie node`, `metadata is not found`) come back as **`-32000`**.
  That code is **not** in viem's retry set, so no amount of retrying a single endpoint recovers it - the intermittency documented above cannot be retried away against one URL.
  It also does not match `fallback`'s `shouldThrow`, so `fallback` **advances to the next provider**.
  A genuinely independent second endpoint is therefore what converts that failure into a served request.
- A genuine `execution reverted` **does** match `shouldThrow`, so a reverting call fails fast on the first endpoint instead of being replayed against every provider.
  Without that, every failed quote would multiply load and latency across the whole list.

Note viem decides the second case on the **message**, not the code: `ExecutionRevertedError.code` (3) is not in `shouldThrow`'s code list at all, only its message regex.
That matters on Nitro, which reports many conditions under `-32000` - including reverts.

## Open Stage 4 items this does not answer

- ✅ **A second endpoint is sourced and wired (#32).** The frontend now runs Alchemy primary with the public endpoint as the automatic last resort, which is genuinely two independent providers.
  **Failover was verified live**, not just in unit tests: with all traffic to `robinhood-testnet.g.alchemy.com` aborted at the network layer, the production build fell straight through to `rpc.testnet.chain.robinhood.com` (HTTP 200s) and the token page rendered complete - gate, metadata, chart, trade panel.
  `VITE_RPC_URL_2` remains free for a third provider.
- ⚠️ **The Alchemy URL ships inside the browser bundle and cannot hold a secret.**
  Confirmed by grepping the built asset: the key appears verbatim in `dist/assets/index-*.js`.
  That is fine for local dev - `frontend/.env.local` is gitignored and `dist` is too - but **before any public deploy the key needs domain allowlisting (Alchemy supports it) or a proxy in front.**
  This is the one blocking item between the current config and shipping it.
- **Rate limits are not characterised.**
  429s were observed and counted on the public endpoints, but the limit's shape (per second, per IP, burst allowance) is unmeasured.
  Alchemy's free tier did not throttle at all across ~280 probe calls plus a browser session, so its ceiling is above that and otherwise unknown.
- **Postgres `C` collation** for any managed provider is still unverified, and can only be set at cluster creation.
- Whether any managed subgraph host supports chain 4663 at all is still unasked.
