# Launchpad subgraph (Build 08 / #19)

Indexes the bonding-curve launchpad on **Robinhood Chain (eip155:4663)** into the entities the UI
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

The contract addresses in `subgraph.yaml` / `networks.json` are **placeholders** until the contracts
are broadcast (that needs deploy keys — see `../docs/deploy.md`, #18). After deploy:

1. Put the deployed `LaunchpadFactory` and `GraduationManager` addresses and their deploy block
   (`startBlock`) into **`networks.json`** under `robinhood` (and `robinhood-testnet`).
2. Stand up a `graph-node` with an `ethereum` network named `robinhood` pointed at the RPC:

   ```
   ethereum: 'robinhood:no_eip1898:https://rpc.mainnet.chain.robinhood.com'
   # testnet: 'robinhood-testnet:no_eip1898:https://rpc.testnet.chain.robinhood.com'
   ```

   (graph-node also needs a Postgres and an IPFS node — the standard graph-node compose stack.)
3. Build against the chosen network (rewrites addresses from `networks.json`) and deploy:

   ```bash
   npm run codegen
   graph build --network robinhood
   graph create --node http://localhost:8020/ launchpad/launchpad
   graph deploy --node http://localhost:8020/ --ipfs http://localhost:5001 launchpad/launchpad
   ```

Point `--network robinhood-testnet` at the testnet stack first (mirrors the contracts' testnet →
mainnet pipeline in `../docs/deploy.md`).
