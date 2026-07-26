# Octopus subgraph (Build 08 / #19)

Indexes the Octopus bonding-curve launchpad on **Robinhood Chain (eip155:4663)** into the entities the UI
needs: live **curve progress** per token, per-wallet **holders**, a **trade** history for charts, and
a **graduation feed** of tokens that reached the DEX. Data layer is a subgraph on **The Graph's
graph-node toolchain** (spec #11, decision #8).

## Why self-hosted

The Graph's hosted service and decentralized network **do not support chain 4663**. So this subgraph
runs on a **self-hosted `graph-node`** pointed at the Robinhood RPC. That is purely a
deploy/infra choice — the manifest, mappings, schema, and `matchstick` tests are all standard The
Graph tooling and would run unchanged on any graph-node. `network: robinhood` in `subgraph.yaml` is
just the label that graph-node's `ethereum:` config binds to the 4663 RPC.

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

## Deploy (self-hosted graph-node)

**Status:** `robinhood-testnet` in `networks.json` is **filled in** from the live 46630 deploy
(`LaunchpadFactory` `0xE98B99AD…2232`, `GraduationManager` `0xE44a178E…85a5`, `startBlock`
`93090715` — see `../docs/deployments-testnet.md`). `graph build --network robinhood-testnet`
compiles clean against it. `robinhood` (mainnet 4663) is still a placeholder pending that deploy.

**The indexer is up and synced.** `docker/docker-compose.yml` runs the stack and the subgraph is
deployed to it as `octopus/octopus`, indexing 46630 from `startBlock` 93090715. See
[Run the indexer](#run-the-indexer) below.

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

#### The stack survives host sleep, but falls far behind

Closing a laptop pauses the Docker VM. On resume, graph-node logs a burst of Postgres
`could not translate host name "postgres"` and RPC `failed to send request` errors, retries through
them, and recovers on its own — but at ~197k blocks/day the backlog is large (a 13-hour sleep left
it ~2,000 blocks behind even after partial catch-up). No intervention needed; just don't mistake the
post-resume error burst for a broken stack.

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
