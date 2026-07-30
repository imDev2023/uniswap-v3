# Octopus frontend (Builds 09–10 / #20–#21)

The Octopus web app: **create a token**, **trade it on the bonding curve**, and **swap it
after graduation**. Built as a React + Vite SPA per the spec's frontend decision (#8) — not a fork of
`Uniswap/interface`.

- **Create** (`/create`) — name / symbol / metadata-URI form calling
  `LaunchpadFactory.createLaunch(name, symbol, metadataURI)`. The metadata URI is written to the token
  contract and is permanent; v1 is "bring your own URI" (uploading on the creator's behalf needs a
  pinning key that cannot live in a Vite bundle). The separate image field is a local-only preview.
- **Curve** (`/token/:address`) - a time-proportional stepped price chart + graduation progress from
  the subgraph, an on-chain-quoted buy/sell panel with pay/receive legs, a per-token live trade feed,
  and transparent creator + holder positions. Once the curve closes, the rail collapses to a single
  "Graduated" card carrying the pool facts and the route to the swap page (#29).
- **Swap** (`/swap/:address`) — trade a graduated TOKEN/WETH pool through the platform's own
  Uniswap V3 `SwapRouter` (#21), with pool facts (spot price, fee tier, locked liquidity) read
  straight from RPC so they survive an indexer outage (#29).
- **Board** (`/`) — the live-curve board (#28). Curves lead the page, sortable by New / Closest /
  Volume / Busiest; graduations run as a ticker above it and a cross-launch live trade feed sits
  alongside. The sort drives the subgraph query's `orderBy`, not just the rendered order, because
  the board is paged: ranking one page client-side would hide a nearly-graduated curve that happens
  to be older than the newest N. Every panel here is indexer-derived discovery and degrades to its
  own labelled notice; trading never depends on this page.

## Stack

- **wagmi + viem** — wallet (browser-injected connector only in v1) and contract reads/writes.
- **@tanstack/react-query** — data fetching + live polling (curve state refreshes every ~5s).
- **graphql-request** — reads the Build 08 subgraph (`../subgraph`), the canonical data layer.
- **lightweight-charts** (TradingView) - the curve price chart. Replaced recharts in #29: it is
  built for irregular financial time series, supplies the real time scale the chart was missing, and
  costs ~45 kB gzip less - recharts was 42% of the whole JS bundle for this one chart.

  ⚠️ Its time scale is **ordinal** (one equal-width slot per point), so raw events would still render
  evenly spaced however far apart they happened. `lib/priceSeries.ts` resamples onto a fixed time
  grid with carry-forward prices, which is what makes screen distance mean elapsed time.

Contract ABIs are minimal hand-written slices under `src/abi/` (the members the UI touches); the
full generated ABIs live in `../subgraph/abis/`.

## Configure

Copy `.env.example` to `.env.local` and fill in after the contracts + subgraph are deployed:

| Var | Meaning |
| --- | --- |
| `VITE_CHAIN_ID` | `4663` (mainnet) or `46630` (testnet, default) |
| `VITE_RPC_URL` | Preferred JSON-RPC endpoint. Optional; the chain's public RPC is always the last resort |
| `VITE_RPC_URL_2` | Optional independent SECOND provider, tried only when the first fails |
| `VITE_QUOTER_ADDRESS` | The platform's own `QuoterV2`. Optional; without it the swap page falls back to a labelled `slot0` estimate |
| `VITE_WETH9_ADDRESS` | Canonical WETH9. Optional; selected per `VITE_CHAIN_ID`, since mainnet and testnet WETH9 differ |
| `VITE_FACTORY_ADDRESS` | `LaunchpadFactory` address (see `docs/deploy.md`) |
| `VITE_GRADUATION_MANAGER_ADDRESS` | `GraduationManager` address |
| `VITE_SWAP_ROUTER_ADDRESS` | The platform's own Uniswap V3 `SwapRouter` (enables the swap page) |
| `VITE_SUBGRAPH_URL` | GraphQL endpoint of the self-hosted graph-node (see `../subgraph/README.md`) |

### RPC endpoints and failover

The two RPC vars are tried in strict order: `VITE_RPC_URL`, then `VITE_RPC_URL_2`, then the chain's
documented public endpoint, deduplicated.
They are wired into viem's `fallback` transport with ranking off, so a healthy first endpoint serves
every request and the others exist only for failure (`src/lib/wagmi.ts`).

Setting `VITE_RPC_URL_2` matters more than it looks.
The official endpoint is a pool of nodes with differing history retention, so a historical read can
miss on one provider and succeed on another - see `docs/rpc-capability.md`.
A single endpoint cannot recover from that, because the error it returns is not one viem retries.

> ⚠️ **Both RPC vars ship inside the browser bundle and cannot hold a secret.**
> Every `VITE_`-prefixed value is baked into the built JS and is public.
> Use a domain-allowlisted key or a proxy for anything metered.

Until `VITE_FACTORY_ADDRESS` is a real address the app runs in **preview mode**: a banner shows and
trading/creation are disabled instead of firing doomed calls.

## Develop

```bash
npm install
npm run dev        # vite dev server
npm test           # vitest — pure curve math, formatting, query shapes
npm run build      # tsc -b + vite build (typecheck + production bundle)
```

## v1 notes / follow-ups

- **Token images are stored per-browser** (`localStorage`), because `LaunchCreated` carries no image
  field. Global images need a metadata contract or an image URI in the event — a documented
  follow-up (see `src/lib/tokenMeta.ts`).
- **Running against the live testnet** is wired up: `.env.local` carries the 46630 addresses and the
  self-hosted subgraph endpoint (`subgraph/docker`), and the feeds, charts, holder tables and swap
  page all populate from it. See `docs/deployments-testnet.md`.
- The wallet layer uses the injected connector only (no WalletConnect project id in v1).
- **Swap pricing uses our own `QuoterV2`** (`contracts/script/DeployQuoter.s.sol`, address in
  `VITE_QUOTER_ADDRESS`): an exact output including the 1% pool fee and price impact, verified
  against real execution in `contracts/test/QuoterV2.t.sol`. It is called via `eth_call`
  (`useSimulateContract`) because `quoteExactInputSingle` is non-`view` — it swaps and reverts with
  the result. When `VITE_QUOTER_ADDRESS` is unset the page falls back to the older `slot0`
  spot-price estimate (`amountIn × spot`, ignoring fee and impact), clearly labelled as an estimate.
  Either way execution is protected on-chain by the slippage-derived `amountOutMinimum`. TOKEN→ETH
  swaps route through a `multicall([exactInputSingle → router, unwrapWETH9 → user])`; ETH→TOKEN
  sends native value to `exactInputSingle` (the router wraps).
- The "just graduated" feed and swap page are Build 10 (#21); create + curve-trade are Build 09
  (#20).
