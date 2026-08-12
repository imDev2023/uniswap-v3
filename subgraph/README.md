# Octopus subgraph (Build 08 / #19)

Indexes the Octopus bonding-curve launchpad on **Robinhood Chain (eip155:4663)** into the entities the UI
needs: live **curve progress** per token, per-wallet **holders**, a **trade** history for charts, and
a **graduation feed** of tokens that reached the DEX. Data layer is a subgraph on **The Graph's
graph-node toolchain** (spec #11, decision #8).

## Why not The Graph

The Graph's hosted service and decentralized network **do not support chain 4663**, so this subgraph
cannot be deployed there. Everything else is standard: the manifest, mappings, schema and
`matchstick` tests are ordinary The Graph tooling and run unchanged on any graph-node.
`network: robinhood` in `subgraph.yaml` is just the label that graph-node's `ethereum:` config binds
to the 4663 RPC.

Where it actually runs is a deploy/infra choice, and since #45 there are two answers - see
[Two deployments, on purpose](#two-deployments-on-purpose).

## What it indexes

| Source | Event | Produces |
| --- | --- | --- |
| `LaunchpadFactory` (fixed addr) | `LaunchCreated` | `Token` (+ spawns a `BondingCurve` template per curve) |
| `BondingCurve` (template, per launch) | `Bought` / `Sold` | `Trade`, updates `Token` curve state, `Holder` positions |
| `BondingCurve` (template) | `Graduation` | idempotent graduation confirmation on `Token` |
| `GraduationManager` (fixed addr) | `Graduated` | `Graduation` feed entity, flags `Token` graduated |

Curve addresses aren't known ahead of time — they're deployed per launch by the factory — so
`BondingCurve` is a **data-source template** instantiated from the `LaunchCreated` handler, with the
token address passed through the template's data-source context.

### Entities (`schema.graphql`)

- **`Token`** — curve progress: reserves, `tokensSold`, `priceX18`, `progressBps` (toward the 800M
  graduation allocation), trade/holder aggregates, and the graduation link.
- **`Trade`** — immutable buy/sell log with resulting price + reserves (chart/history source).
- **`Holder`** — an address's netted on-curve position (`bought - sold`) per token.
- **`Graduation`** — the "just graduated" feed: pool, locked NFT id, seeded amounts, raised ETH.
- **`Factory`** — global rollups (launch/graduation/trade counts, volume, raised ETH).

Holder positions are derived from the curve's own `Bought`/`Sold` events (deterministic, no eth_calls).
Secondary wallet-to-wallet ERC-20 transfers and post-graduation pool holdings are out of scope for v1
(would need a `LaunchToken` `Transfer` template) and are a documented follow-up.

## Develop

```bash
cd subgraph
npm install
npm run codegen     # generate AssemblyScript types from schema + ABIs -> generated/
npm run build       # compile mappings to wasm -> build/
npm test            # matchstick unit tests (tests/*.test.ts)
```

`npm test` downloads the `matchstick` binary on first run. On macOS it dynamically links Postgres'
`libpq`; if it fails with `Library not loaded: ...libpq.5.dylib`, install it and expose it on the
loader path:

```bash
brew install libpq
ln -sf "$(brew --prefix libpq)/lib/libpq.5.dylib" /usr/local/lib/libpq.5.dylib
```

(Or run the tests in Docker: `graph test -d`.)

The ABIs in `abis/` are the launchpad contracts' event ABIs, extracted from the Foundry build:

```bash
cd ../contracts
for c in LaunchpadFactory BondingCurve GraduationManager; do
  forge inspect $c abi --json > "../subgraph/abis/$c.json"
done
```

Re-extract and re-run `codegen` whenever a contract's events change.

## Two deployments, on purpose

Since #45 (2026-08-11) this subgraph runs in two places, from the same manifest and mappings:

| | Where | Serves |
| --- | --- | --- |
| **Managed** | Goldsky `octopus/1.0.0` - `https://api.goldsky.com/api/public/project_cmsaqlax74bi401vn1h6bc1uh/subgraphs/octopus/1.0.0/gn` | the **deployed site** at `octopus-68a.pages.dev` |
| **Self-hosted** | `docker/docker-compose.yml`, `http://localhost:8100/subgraphs/name/octopus/octopus` | **local development**, and the stop-the-indexer degradation test |

[ADR-0004](../docs/adr/0004-managed-subgraph-hosting-on-goldsky.md) is the reasoning for the managed path.
Self-hosting was kept in #38 because stopping graph-node is the easiest way to exercise the app's
degradation behaviour, and that is still true, so both stay.

⚠️ **The recovery levers documented below are SELF-HOSTED ONLY.**
The reorg-deadlock procedure works by purging graph-node's block cache in Postgres and rewinding the
deployment. Neither is available on managed infrastructure, so the same failure on Goldsky is a
support ticket rather than a runbook. Goldsky's behaviour under a large reorg on this chain is
**unmeasured** and cannot be induced on demand.

⚠️ **`scripts/indexer-health.mjs` does NOT work against Goldsky.**
It is built on graph-node's index-node status API (`indexingStatusesForSubgraphName`), and the
Goldsky endpoint has no such field - the query returns ``Type `Query` has no field
`indexingStatusesForSubgraphName` ``. Measured 2026-08-11. Monitoring the managed deployment means
comparing `_meta.block.timestamp` against the chain head over RPC, which is what
`frontend/src/hooks/useIndexerStatus.ts` already does. The script still works against the local
stack.

### Deploy to Goldsky

```bash
cd subgraph
npx graph codegen
npx graph build --network robinhood-testnet   # stamps addresses from networks.json
goldsky subgraph deploy octopus/1.0.0 --path .
git checkout -- subgraph.yaml                 # AFTER deploying, never before
```

⚠️ **`npx graph build --network` rewrites `subgraph.yaml` IN PLACE**, stamping the addresses from
`networks.json` into the tracked manifest.
`--path` is the subgraph PROJECT directory (`goldsky subgraph deploy --help`: "Path to subgraph"),
so the CLI reads that stamped manifest when it runs.
That is the whole reason for the ordering: stamp, deploy, and only then restore the file with
`git checkout`.
Restoring it first deploys the unstamped manifest, and restoring it never leaves a modified
`subgraph.yaml` in the working tree that looks like somebody's edit.

Measured 2026-08-11: ~2M blocks backfilled in **11.5 minutes** (690 s), settling at a 28-block /
5-second lag against the chain head.
[ADR-0004](../docs/adr/0004-managed-subgraph-hosting-on-goldsky.md)'s 1.93M-in-425 s figure is the
same order but **1.6x optimistic**; budget from the measurement.

⚠️ **A backfilling subgraph answers differently from a synced one.**
`_meta.block.timestamp` is `null` during backfill and a **real timestamp** once caught up, and
`_meta.block.number` advances in large discrete batches - flat for two minutes, then +975,447 blocks
at once. Neither a null timestamp nor a flat block number means anything is wrong until it has
caught up, and `goldsky subgraph list` disagrees with `_meta` by ~160,000 blocks while it runs.
`_meta` is what the app sees, so it is the only one that settles a question about the app.

## Deploy (self-hosted graph-node)

**Status:** `robinhood-testnet` in `networks.json` carries **all four** addresses from the #38 deploy
(`LaunchpadFactory` `0xF1A9c1e7…c6F5`, `GraduationManager` `0x4C0429f0…48C3`, `LPLock`
`0x3589e6aA…A8CE`, `DevVesting` `0x7727aC11…36c0`), all at `startBlock` **97379693** - the factory's
constructor creates the other three, so they share one block. See `../docs/deployments-testnet.md`.
`robinhood` (mainnet 4663) is still a placeholder pending that deploy.

🔴 **All four entries must be non-zero.** `DevVesting` sat at `0x0` from #36 until #38 because the
contract had never been deployed, and a zero-address data source does **not** error - it indexes
nothing, so the vesting panel reads empty and looks exactly like "this launch has no carve".

> ⚠️ `graph build --network <net>` **rewrites `subgraph.yaml` in place** — it stamps the addresses
> and network name from `networks.json` into the tracked manifest and strips its comments. Treat
> `networks.json` as the source of truth and `git checkout -- subgraph.yaml` after building, or
> build from a scratch copy. The deployable artifact is `build/subgraph.yaml`, not the source.

### Run the indexer

Chain 46630 is not on The Graph's hosted or decentralized networks, so indexing requires running the
stack yourself. [`docker/docker-compose.yml`](./docker/docker-compose.yml) does that — three services:

| Service | Purpose | Notes |
| --- | --- | --- |
| `graph-node` | the indexer | `graphprotocol/graph-node:v0.40.2` |
| Postgres | entity store | `postgres:14`, `initdb` locale `C`; graph-node owns the schema |
| IPFS | manifest + mapping storage | `ipfs/kubo:v0.34.1`; `graph deploy` uploads the wasm here |

**Host ports are remapped into the 81xx range.** graph-node's conventional 8000 and 8080 are commonly
already taken locally (supabase-kong, open-webui), so the compose file publishes 8000→**8100**,
8001→8101, 8020→**8120**, 8030→**8130**, 8040→8140, Postgres→5434. Container-internal ports are
unchanged, so upstream graph-node docs still apply verbatim — only the host side shifts.

Full first-run sequence:

```bash
cd subgraph/docker && docker compose up -d && cd ..

npm run codegen
npx graph build --network robinhood-testnet   # stamps addresses from networks.json
git checkout -- subgraph.yaml                 # ...by REWRITING the tracked manifest — restore it
                                              # (do this AFTER deploy: the deploy reads this file)

npx graph create --node http://localhost:8120/ octopus/octopus
npx graph deploy --node http://localhost:8120/ --ipfs http://localhost:5001 \
  --version-label v0.1.0 octopus/octopus
```

> ⚠️ Order matters: `graph deploy` re-reads the **root** `subgraph.yaml`, so restoring it before
> deploying would ship the placeholder zero-addresses. Build → deploy → `git checkout`.

Query endpoint: **`http://localhost:8100/subgraphs/name/octopus/octopus`** — note *both* path
segments; a single `octopus` 404s. Indexing health:

```bash
curl -s -X POST http://localhost:8130/graphql -H 'content-type: application/json' \
  -d '{"query":"{indexingStatusForCurrentVersion(subgraphName:\"octopus/octopus\"){synced health fatalError{message handler} chains{chainHeadBlock{number} latestBlock{number}}}}"}'
```

Backfill from `startBlock` to head (~83k blocks) takes about **90 seconds**.

#### Keeping pace with a 0.3s-block chain — measured

The log scan is not the bottleneck; **the block ingestor is**. At stock settings graph-node ingests
~4.5 blocks/s against this RPC (round-trip-bound), while the chain produces ~3.3–4.5 blocks/s. That
is break-even, so the subgraph settles **~330–640 blocks (≈2 min) behind head and oscillates there
without converging**. The compose file therefore sets:

```
GRAPH_ETHEREUM_BLOCK_BATCH_SIZE=100
ETHEREUM_BLOCK_INGESTOR_MAX_CONCURRENT_JSON_RPC_CALLS_FOR_TXN_RECEIPTS=1000
ETHEREUM_REORG_THRESHOLD=50      # Orbit finality is fast; 250 is needless ancestor ingestion
```

Measured over 2 minutes, before → after:

| | Lag behind true chain head |
| --- | --- |
| Stock ingestor settings | 330–640 blocks (~2 min), drifting up |
| Tuned (above) | **90–160 blocks (~40 s), stable** |

Trading is unaffected either way — the frontend quotes buys/sells **on-chain**, so only the feed,
chart and holder table carry this lag.

> ⚠️ **`synced: true` does not mean "caught up with the chain."** The status API's `chainHeadBlock`
> is graph-node's *own ingested* head, not the RPC's. While the ingestor lagged, the API reported
> `synced: true` with `latestBlock == chainHeadBlock == 93347390` while the chain was really at
> 93348111 — 721 blocks ahead. To monitor real lag, compare `latestBlock` against `eth_blockNumber`
> from the RPC directly, as the table above does.
>
> ⚠️ **It is worse than that: `synced` is not a comparison at all.** Confirmed against Postgres
> during #31 - it is the stored column `synced_at is not null`, set once when the deployment first
> reached chain head and never re-evaluated afterwards. It cannot go false, whatever happens next.
> A deployment 518,918 blocks behind still reports `synced: true`, `health: healthy`,
> `fatalError: null`. See *Recovering from a reorg deadlock* below, and use
> `node scripts/indexer-health.mjs` rather than reading these fields.

#### The stack survives host sleep, but falls far behind

Closing a laptop pauses the Docker VM. On resume, graph-node logs a burst of Postgres
`could not translate host name "postgres"` and RPC `failed to send request` errors, retries through
them, and recovers on its own — but at ~197k blocks/day the backlog is large (a 13-hour sleep left
it ~2,000 blocks behind even after partial catch-up). No intervention needed; just don't mistake the
post-resume error burst for a broken stack.

#### Recovering from a reorg deadlock

**This is the failure mode that produced a silently frozen subgraph on 2026-07-31, and it will recur.**
The deployment stops advancing and never resumes, while graph-node reports perfect health.
It is not a hang and it is not ingestor lag; it is a crash-restart loop, and it cannot fix itself.

**Symptom.**
`latestBlock` is frozen at some height while the block ingestor keeps pace with the chain head.
`synced: true`, `health: healthy`, `fatalError: null`.
The logs carry a repeating pair, one every ~35 s:

```
WARN Trying again after load block 0x91bc…eadb failed (attempt #10) with result
     Err(Ethereum node did not find block 0x91bc…eadb), component: BlockStream
ERRO Subgraph instance failed to run: Ethereum node did not find block 0x91bc…eadb,
     component: SubgraphInstanceManager
```

**Cause.**
The chain reorged past the deployment's stored head, leaving that head on an orphaned branch.
Measured on 46630 during build #31: the divergence spanned roughly **134,300 blocks**
(bounded to `(95175342, 95176342]` at the low end, ending at `95309661`), which is about
11 hours at 0.3 s blocks.
That is a testnet rollback, not an ordinary few-block reorg.

graph-node **cannot** recover from this on its own, structurally.
Reverting a reorg means walking back through the orphaned blocks via `parent_ptr`, which requires
fetching them *by hash* - and no node serves non-canonical blocks.
The recovery path depends on the exact thing that is unavailable, so it crash-loops forever.

**Why nothing alerts.**
All three health fields are read straight out of Postgres and none of them is a live comparison:

| field | what it actually is |
| --- | --- |
| `synced` | a **sticky column** (`synced_at is not null`), set once when the deployment first reached chain head and never re-evaluated. It cannot go false. |
| `health` | only reflects errors raised by the mappings. A block-stream crash loop never touches it. |
| `fatalError` | only set for **deterministic** errors. A missing block is non-deterministic, so it is retried forever and this stays null. |

Detect it with the probe, which checks the one thing that actually distinguishes a permanent
deadlock from ordinary lag - whether the stored head hash is the hash the chain has at that height:

```bash
node scripts/indexer-health.mjs           # exit 0 only if every deployment is ok
```

**Recovery.**
Three steps, in this order. Substitute your own fork bounds; the commands below are the ones that
were actually run.

1. **Find the last canonical cached block.**
   Compare graph-node's block cache against the chain and walk back until they agree.
   The cache is sparse (roughly one block per 1000 outside the indexed range), so this bounds the
   fork start rather than pinpointing it, which is fine - any canonical block below it works.

   ```bash
   RPC=https://rpc.testnet.chain.robinhood.com
   LO=95000000; HI=95400000     # widen until you see both MATCH and DIVERGE rows

   docker exec launchpad-graph-postgres psql -U graph-node -d graph-node -t -A -F',' \
     -c "select number, encode(hash,'hex') from chain1.blocks where number between $LO and $HI order by number;" \
   | while IFS=, read -r n h; do
       k=$(curl -s -X POST "$RPC" -H 'content-type: application/json' \
             -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBlockByNumber\",\"params\":[\"$(printf '0x%x' "$n")\",false]}" \
           | python3 -c 'import sys,json; print((json.load(sys.stdin).get("result") or {}).get("hash",""))')
       [ "0x$h" = "$k" ] && echo "$n MATCH" || echo "$n DIVERGE"
     done | tee /tmp/forkscan.txt

   # the rewind target is the last MATCH before the first DIVERGE
   grep -m1 DIVERGE /tmp/forkscan.txt
   grep -B1 -m1 DIVERGE /tmp/forkscan.txt | head -1
   ```

   The cache is sparse outside the indexed range (roughly one block per 1000), so this bounds the
   fork start rather than pinpointing it, which is fine - any canonical block below it works as the
   rewind target. Sample a few hundred rows, not the whole range; each row is one RPC call.

2. **Purge the divergent cache range.**
   This step is **mandatory, not optional**.
   graph-node reads block metadata from its own cache, so a rewind that re-indexes through a
   poisoned range would silently re-index the *wrong chain* out of local storage.

   ```bash
   docker exec launchpad-graph-postgres psql -U graph-node -d graph-node \
     -c "delete from chain1.blocks where number > 95175342 and number <= 95309661;"
   ```

   ⚠️ **`graphman chain check-blocks` does not do this job.** Its stated purpose is to compare
   cached blocks with fresh ones and clear the cache when they differ, but its repair path assumes
   it can re-fetch the block by hash. On an orphaned block there is nothing to fetch, so it aborts
   with `Error: JRPC provider found no block with hash 0x…` instead of deleting the row. Verified
   during #31.

3. **Rewind both deployments to a pre-fork canonical block, then let them re-index.**

   ```bash
   docker cp subgraph/docker/graphman.toml launchpad-graph-node:/tmp/graphman.toml
   docker exec launchpad-graph-node graphman --config /tmp/graphman.toml rewind \
     --block-number 95175342 \
     --block-hash 0x3f9deb4a73b812e0ffae4ea2d2c89a1c7e5accdd772ea48c4aa5c3ade24d21d9 \
     sgd1 sgd2
   ```

   `rewind` pauses and resumes the deployments itself. `--force` is only needed when the target
   block is *not* in the local cache; picking a target that is cached and canonical avoids it.
   The config is committed at `subgraph/docker/graphman.toml` - graphman will not start without
   `--config`, even for read-only subcommands. Deployment ids (`sgd1`, `sgd2`) come from
   `graphman --config /tmp/graphman.toml info --all`.

**Cost.** Re-indexing ~650,000 blocks took about **10 minutes** (the scan runs ~1000 blocks/s over
1000-block ranges). Reconcile afterwards against the chain rather than eyeballing it:

```bash
# chain side
cast call 0xF1A9c1e70b6aEB48b85eE77518557c057283c6F5 "launchCount()(uint256)" \
  --rpc-url https://rpc.testnet.chain.robinhood.com

# subgraph side - these two numbers must be equal
curl -s -X POST http://localhost:8100/subgraphs/name/octopus/octopus \
  -H 'content-type: application/json' \
  -d '{"query":"{ factory(id:\"launchpad\"){ launchCount graduationCount } }"}'
```

After the #31 recovery both read **14** launches / **2** graduations.
Then confirm the deployment is genuinely healthy rather than merely claiming to be:

```bash
node scripts/indexer-health.mjs      # exit 0, VERDICT: OK, and the head hash matches the chain
```

⚠️ **Do not use "the head number stopped advancing" as your stall signal.**
During a catch-up scan over ranges with no matching logs, graph-node legitimately leaves the stored
head pointer untouched for long stretches - measured during this recovery, it read `95175342` while
the scanner was already past `95212453`.
A non-advancing head is normal during a large re-index, so alerting on it fires loudest exactly when
an operator is already mid-recovery.
Canonicity is the signal.

#### The stack needs ~1 GB of Docker VM headroom — starve it and IPFS dies, not graph-node

Symptom seen in practice: `graph-node` logs `Waiting for IPFS (ipfs:5001)` forever, the status API
answers `{"indexingStatuses":[]}` or `Store error: database unavailable`, and `docker compose ps`
shows `ipfs  Restarting (137)`. It looks like a broken subgraph deployment. It is not — the
deployment rows (`subgraphs.subgraph_version`, `subgraphs.deployment`, the `sgd1` schema) are all
still intact, and re-deploying fixes nothing.

**Exit 137 with `OOMKilled=false` is the giveaway.** Docker Desktop only sets the `OOMKilled` flag
for *cgroup* limits; when the whole Linux VM runs out of memory the kernel OOM killer fires with
`constraint=CONSTRAINT_NONE ... global_oom` and the container just reports SIGKILL. Confirm it:

```bash
docker inspect launchpad-graph-ipfs --format 'OOMKilled={{.State.OOMKilled}} Exit={{.State.ExitCode}}'
docker run --rm --privileged alpine sh -c "head -3 /proc/meminfo; dmesg | grep -i 'killed process'"
```

On a machine also running other local stacks (supabase, langfuse, open-webui, qdrant, …) an 8 GB
Docker VM is not enough: 29 containers left ~165 MB free and the kernel killed IPFS repeatedly
(along with unrelated victims like `clickhouse-server`). Raising the VM to **16 GB** cleared it and
IPFS came up `healthy` immediately. Docker Desktop stores the setting in
`~/Library/Group Containers/group.com.docker/settings-store.json` as `MemoryMiB` (absent = default);
set it and `docker desktop restart`.

Postgres separately logs `database system was not properly shut down; automatic recovery in
progress` after a host sleep or hard stop — that one **is** self-healing and needs no action.

#### graph-node declares `archive` capability — it is lying, and that is fine *only* while there are no eth_calls

Startup logs `Creating transport, capabilities: archive, traces`. That is graph-node's unconditional
default for an `ethereum:` URL with no capability prefix; the Robinhood RPC is **not** an archive node
(state is pruned after ~28 min — see the table above). Nothing requests those capabilities today
because the mappings make zero `eth_call`s, so the mislabel is inert. It becomes a live trap the
moment someone adds one: the subgraph would fail on backfill, not at the near-head test.

### RPC capability — measured against `rpc.testnet.chain.robinhood.com` (2026-07-25)

Node is `nitro/v3.11.3-rc.4`. **Verdict: the public RPC is sufficient for this subgraph** — but only
because the mappings make **zero `eth_call`s**. That is now a load-bearing infra constraint, not just
a testability nicety (see "Why no eth_calls" below).

| Property | Measured | Consequence |
| --- | --- | --- |
| `eth_getLogs` block-range limit | **none** — genesis→head (93.2M blocks) succeeds | wide backfill windows are fine |
| `eth_getLogs` result limit | **10,000 logs**, then `-32000 "logs matched by query exceeds limit of 10000"` | the real ceiling; see sizing below |
| Chain-wide log density | ~1.72 logs/block (1,720 in 1,000 blocks near head) | unfiltered queries cap at ~5,800 blocks |
| Our filtered backfill (`LaunchpadFactory`, deploy→head) | **8 logs over 80,907 blocks** | ~3 orders of magnitude below the cap |
| Block time | **0.305 s** | ~197k blocks/day |
| Historical **logs / blocks / receipts** | ✅ retained at the deploy block (~81k blocks / 6.9 h back) | backfill from `startBlock` works |
| Historical **state** (`eth_call`, `eth_getBalance`) | ❌ **pruned after ~5,600 blocks (~28 min)** — `missing trie node … not available` | **this is not an archive node** |
| `eth_getLogs` by `blockHash` (EIP-1898) | ✅ supported | the `no_eip1898` binding below is more conservative than required |
| `eth_getBlockReceipts` | ✅ supported | |
| Head consistency | ✅ monotonic; 15-block spread over 20 consecutive calls, never regressed | no load-balancer skew to design around |

#### Why "no eth_calls" is now an infra requirement

State is pruned after **~28 minutes** of chain time. Any mapping that calls a contract would fail
during backfill for every block older than that — and backfill starts ~7 hours back. The #19 design
derives everything from event payloads (`CURVE_SUPPLY` is a constant), so it never touches historical
state and indexes fine on a pruned node.

**Do not add an `eth_call` to a mapping without first moving to an archive endpoint.** The failure is
not subtle but it only appears on backfill, so it can pass a near-head test and then break on reindex.

#### Sizing graph-node against the 10,000-log cap

Defaults request up to 2,000 blocks per `eth_getLogs`. To hit the cap in one window, *our* contracts
would need >5 logs/block sustained for ~10 minutes (~10k trade events). Unlikely, but a viral launch
is exactly when it would bite — and Nitro's error string is non-standard, so graph-node will probably
not recognise it as a "reduce your range" signal and may retry-loop instead of adapting.

Cheap insurance — halve the window, doubling headroom:

```
GRAPH_ETHEREUM_MAX_BLOCK_RANGE_SIZE=1000          # default 2000
GRAPH_ETHEREUM_TARGET_TRIGGERS_PER_BLOCK_RANGE=100
```

Mainnet (4663) has **not** been measured — re-run these probes before committing to infra there, as
density and retention will differ.

### Pointing the stack at mainnet 4663

The compose file binds the **testnet** network name and RPC. To index mainnet instead:

1. Fill the `robinhood` key in **`networks.json`** with the mainnet `LaunchpadFactory` /
   `GraduationManager` addresses and their deploy block. (Still placeholder zeros — mainnet is
   undeployed.)
2. Change graph-node's `ethereum:` binding in `docker/docker-compose.yml` to
   `robinhood:https://rpc.mainnet.chain.robinhood.com`, and re-measure the RPC probes above first —
   density and retention will differ, and the 10,000-log sizing is derived from testnet numbers.
3. `npx graph build --network robinhood`, then create/deploy as above.

The `no_eip1898` binding suffix that earlier drafts of this doc suggested is **not** needed: the
testnet RPC answers `eth_getLogs` by `blockHash` correctly (measured above).

### Testnet data available to index

The 46630 smoke test (`../docs/deployments-testnet.md`) already wrote real events for every handler,
so a fresh index has non-trivial data to chew on immediately:

- 3 `LaunchCreated` — `SMOKE` (production-calibrated curve), `GRAD` (test-calibrated), `ONEETH`
  (created to verify the 1-ETH calibration; never traded)
- `Bought` ×2, `Sold` ×1 on the curve templates
- 1 `Graduation` + 1 `Graduated` (pool `0x4eB4cA42…9cF7`, locked NFT id 1)

**Verified ✅** — a full index from `startBlock` 93090715 reproduces exactly that, and every figure
reconciles against the on-chain record in `../docs/deployments-testnet.md`:

| Entity | Indexed | Matches |
| --- | --- | --- |
| `Factory` | 3 launches / 1 graduation / 3 trades (2 buys, 1 sell) | the smoke-test log |
| `Token` SMOKE | `tokensSold` 5,688,183.79 | 7,688,183.78 bought − 2M sold ✅ |
| `Trade` SMOKE buy | 0.22 ETH gross, 0.0022 fee, 7,688,183.78 out | the `quoteBuy` figure ✅ |
| `Trade` SMOKE sell | 0.056392 ETH out, 0.00057 fee | ✅ |
| `Trade` GRAD buy | 1.5 ETH gross, **`ethToCurve` exactly 0.9 ETH** | the 0.6 ETH graduation refund is correctly excluded from volume — the #19 review fix holding on real data ✅ |
| `Graduation` | pool `0x4eB4cA42…9cF7`, NFT id 1, 200M + 0.9 ETH seeded | ✅ |
| `Holder` | SMOKE bought 7.688M / sold 2M / balance 5.688M | ✅ |

#### Known gap: a launched-but-untraded token reads price 0

`ONEETH` indexes with `ethReserve`, `priceX18` and `tokenReserve` all **0**, because `Token` curve
state is only written by the `Bought`/`Sold` handlers. `LaunchCreated(token, curve, creator, name,
symbol)` carries no reserves, so the initial `virtualEthReserve` and opening price can't be derived
from the event — and reading them would need an `eth_call`, which the pruned RPC forbids on backfill.

The UI therefore shows "Price 0 ETH" on a brand-new launch until its first trade. `progressBps` 0 is
genuinely correct; the price is not. Fixing it properly means emitting the frozen curve params in
`LaunchCreated` (a contract change), not adding a mapping call.
