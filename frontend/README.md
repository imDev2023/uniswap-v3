# Launchpad frontend (Build 09 / #20)

The custom launchpad web app: **create a token** and **trade it on the bonding curve**. Built as a
React + Vite SPA per the spec's frontend decision (#8) — not a fork of `Uniswap/interface`.

- **Create** (`/create`) — name / symbol / image form calling `LaunchpadFactory.createLaunch`.
- **Curve** (`/token/:address`) — live price chart + graduation progress from the subgraph, an
  on-chain-quoted buy/sell panel, and transparent creator + holder positions.
- **Explore** (`/`) — live curves and protocol rollups from the subgraph.

## Stack

- **wagmi + viem** — wallet (browser-injected connector only in v1) and contract reads/writes.
- **@tanstack/react-query** — data fetching + live polling (curve state refreshes every ~5s).
- **graphql-request** — reads the Build 08 subgraph (`../subgraph`), the canonical data layer.
- **recharts** — the curve price chart.

Contract ABIs are minimal hand-written slices under `src/abi/` (the members the UI touches); the
full generated ABIs live in `../subgraph/abis/`.

## Configure

Copy `.env.example` to `.env.local` and fill in after the contracts + subgraph are deployed:

| Var | Meaning |
| --- | --- |
| `VITE_CHAIN_ID` | `4663` (mainnet) or `46630` (testnet, default) |
| `VITE_RPC_URL` | JSON-RPC endpoint (falls back to the chain's public RPC) |
| `VITE_FACTORY_ADDRESS` | `LaunchpadFactory` address (see `docs/deploy.md`) |
| `VITE_GRADUATION_MANAGER_ADDRESS` | `GraduationManager` address |
| `VITE_SUBGRAPH_URL` | GraphQL endpoint of the self-hosted graph-node (see `../subgraph/README.md`) |

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
- **End-to-end against the live testnet** requires the deployed contract addresses + a running
  subgraph. Those need the deploy keys that are an out-of-band human step (same gate as #18 — see
  `docs/deploy.md`). The app is wired entirely through config so it works the moment those are
  filled in; logic is validated here via the unit suite + a green production build.
- **Swap page for graduated pools**, the "just graduated" feed, and richer discovery are Build 10
  (#21). The curve view already links out to graduated-pool info and flags where the swap page lands.
- The wallet layer uses the injected connector only (no WalletConnect project id in v1).
