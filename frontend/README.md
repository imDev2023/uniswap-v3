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
| `RPC_UPSTREAM_URL` | ⚠️ **No `VITE_` prefix, deliberately.** The keyed endpoint. Read only by `vite.config.ts`, never inlined into the bundle |
| `VITE_RPC_PROXY_PATH` | Same-origin path the app sends RPC to, e.g. `/rpc`. Vite serves it in `dev` and `preview`; in production the HOST serves it |
| `VITE_RPC_URL` | Preferred DIRECT endpoint. Optional; the chain's public RPC is always the last resort. **Public by construction - never put a key here** |
| `VITE_RPC_URL_2` | Optional independent SECOND direct provider, tried only when the first fails. Public, exactly like `VITE_RPC_URL` |
| `VITE_QUOTER_ADDRESS` | The platform's own `QuoterV2`. Optional; without it the swap page falls back to a labelled `slot0` estimate |
| `VITE_WETH9_ADDRESS` | Canonical WETH9. Optional; selected per `VITE_CHAIN_ID`, since mainnet and testnet WETH9 differ |
| `VITE_FACTORY_ADDRESS` | `LaunchpadFactory` address (see `docs/deploy.md`) |
| `VITE_GRADUATION_MANAGER_ADDRESS` | `GraduationManager` address |
| `VITE_SWAP_ROUTER_ADDRESS` | The platform's own Uniswap V3 `SwapRouter` (enables the swap page) |
| `VITE_SUBGRAPH_URL` | GraphQL endpoint of the self-hosted graph-node (see `../subgraph/README.md`) |

### RPC endpoints and failover

Endpoints are tried in strict preference order: the proxy, then `VITE_RPC_URL`, then
`VITE_RPC_URL_2`, then the chain's documented public endpoint, deduplicated.
They are wired into viem's `fallback` transport with ranking off, so a healthy first endpoint serves
every request and the others exist only for failure (`src/lib/wagmi.ts`).

Setting a second endpoint matters more than it looks.
The official endpoint is a pool of nodes with differing history retention, so a historical read can
miss on one provider and succeed on another - see `docs/rpc-capability.md`.
A single endpoint cannot recover from that, because the error it returns is not one viem retries.

### Keeping the key out of the bundle

> ⚠️ **Every `VITE_`-prefixed value is baked into the built JS and is public.**
> `VITE_RPC_URL` and `VITE_RPC_URL_2` are publication, not configuration, and cannot hold a secret.

Put the keyed endpoint in `RPC_UPSTREAM_URL` and set `VITE_RPC_PROXY_PATH=/rpc`.
The browser then talks to `/rpc` on its own origin, and the server attaches the key on the way out.
`vite.config.ts` serves that path in `dev` and in `preview`; **a deployed static host does not**, so
production needs the host to serve it.
Here that is `functions/rpc.ts`, a Cloudflare Pages Function - see [Deploy](#deploy-cloudflare-pages).

⚠️ **The two variables belong in different places, and this is the thing most easily got wrong.**
`VITE_RPC_PROXY_PATH` is inlined at **build** time, so it belongs in the build environment.
`RPC_UPSTREAM_URL` is read at **run** time by whatever answers the path, so in production it is a
secret on the Function and **must not be a build variable**.
Nothing needs it to be: Vite reads it only to run its own dev proxy, and a production build has no
dev proxy to run.

Both servers get "where does this request actually go" from one place, `src/lib/rpcUpstream.ts`.
The rule is that the incoming request path contributes **nothing** to the outgoing URL: the key is a
path segment at every managed provider, so a proxy that *joins* paths turns
`https://host/v2/<key>` plus `/rpc` into `/v2/<key>/rpc`, which they all answer with a 404.

`npm run build` **fails** if a credential-shaped URL reaches the output
(`build/bundleCredentialGuard.ts`).
If a key is domain-allowlisted at the provider and shipping it is a deliberate decision, set
`ALLOW_BUNDLED_RPC_CREDENTIAL=1`, which downgrades the failure to a warning and never silences it.

Two things this does **not** buy, worth stating plainly:
a proxy protects the key from theft and not the quota from use; and a domain allowlist is
Referer-based, which a non-browser client can forge.

⚠️ On the quota, one half of it *is* now closed and it is worth being exact about which. Absent CORS
stops another site READING the answer, not the request ARRIVING and being billed - a CORS-simple
`content-type: text/plain` POST is never preflighted, and against the deployed edge one carrying
`Origin: https://evil.example` returned 200 with a real `eth_chainId`. `functions/rpc.ts` now refuses
cross-site callers with 403, branching on `Sec-Fetch-Site` because page JavaScript cannot forge it. A
**missing** header is allowed on purpose, so curl, wallets and servers still work; anyone willing to
run a server can still spend the quota and gains nothing by routing through us. The real cap is still
a platform rule, and is still not written.

The wallet is a separate audience and is never offered any of this.
`chain.rpcUrls.default` carries the public endpoint only, because wagmi hands its first entry to
`wallet_addEthereumChain`, and MetaMask *stores* what it receives as the user's own endpoint for the
network - see `src/config/chain.ts`.

Until `VITE_FACTORY_ADDRESS` is a real address the app runs in **preview mode**: a banner shows and
trading/creation are disabled instead of firing doomed calls.

## Develop

```bash
npm install
npm run dev        # vite dev server
npm test           # vitest — pure curve math, formatting, query shapes
npm run build      # tsc -b + vite build (typecheck + production bundle)
```

## Deploy (Cloudflare Pages)

Chosen 2026-08-10 over Netlify and Vercel on proxy request economics, and over a pure static host
because one cannot serve `/rpc` at all.
The app polls chain state continuously, so free-tier **request** limits bind long before bandwidth
or build minutes do.

Limits verified 2026-08-11 - re-check them, they move:

| | Free tier |
| --- | --- |
| Pages Functions requests | **100,000/day**, shared with Workers |
| Static asset requests | free and unlimited (they do not count) |
| CPU per request | 10 ms (a pass-through proxy uses almost none) |
| Subrequests per request | 50 (this Function makes 1) |
| Builds | 500/month, 1 concurrent |
| Files / max size | 20,000 / 25 MiB |

⚠️ **That daily cap is the real constraint and it is not generous.** Only `/rpc` counts, and it is
one HTTP request per read: `src/lib/wagmi.ts` builds transports with a bare `http(url)` and no
batching. Summing the app's RPC polls - 8 s (`PoolFacts`, `SwapPanel`), 10 s (`useOnchainToken`),
15 s x2 (`useLaunchTerms`), 20 s (`useIndexerStatus`), 30 s (`useClaimableFees`), 60 s
(`useReclaimStatus`) - a single open token page is roughly **27 requests/min**, so 100,000/day is
about **60 tab-hours**. Ample for testnet, tight for a public launchpad.
Enabling viem's request batching or a Cloudflare rate-limiting rule are the two levers, in that
order; neither is done.

> The often-quoted "the app polls every ~5 s" is `LIVE_REFETCH_MS` in `src/hooks/useSubgraph.ts`,
> which is the **subgraph** poll. It goes to `VITE_SUBGRAPH_URL` and never touches `/rpc`.

### Layout

```
frontend/
  functions/rpc.ts     -> served at /rpc. Pages routes by FILE NAME.
  wrangler.jsonc       -> project name, output dir, PINNED compatibility_date
  dist/                -> build output; dist/_headers is GENERATED, not committed
```

`functions/` must sit at the project root, **never** inside `dist/`, which Pages serves verbatim.

### Deploying

```bash
export CLOUDFLARE_ACCOUNT_ID=<your account id>        # not committed; see wrangler.jsonc
cd frontend

VITE_RPC_PROXY_PATH=/rpc npm run build                # build-time half
npx wrangler pages secret put RPC_UPSTREAM_URL        # run-time half, prompts; never echoed
npx wrangler pages deploy dist
```

Direct upload, deliberately: it needs no connected Git repository, so hosting does not force a
decision about pushing this repo. Automatic deploy-on-push is what that trades away.

⚠️ `wrangler pages deploy` does **not** upload `.env` or `.env.local`; secrets travel only via
`pages secret put` or an explicit `--secrets-file`. `wrangler pages dev` *does* read `.env.local`
automatically, which is why local runs need no extra flag once the key is in `RPC_UPSTREAM_URL`.

### Running the deployed shape locally

⚠️ **The dev proxy and the Function are not equivalent, and the dev one is the weaker.**
They agree on the only thing that must not diverge - where the request goes, via
`src/lib/rpcUpstream.ts` - and on nothing else.
`functions/rpc.ts` additionally refuses non-POST, caps the body at 1 MB, rebuilds the request
headers from nothing rather than forwarding the caller's, and redacts upstream error bodies;
`vite.config.ts`'s `rpcProxy` does none of that, because it is http-proxy bound to localhost and
reachable only by whoever is running the dev server.
So a request shape that works in `dev` can be refused in production.

`npm run preview` is Vite, not Cloudflare, so it exercises the dev proxy rather than the Function.
To run what actually ships:

```bash
npm run build
npx wrangler pages dev --port 5274 \
  --binding RPC_UPSTREAM_URL=https://rpc.testnet.chain.robinhood.com
```

Pointing the binding at the **public** endpoint exercises the whole path without putting a key
anywhere. Verify with `curl -X POST localhost:5274/rpc -d
'{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'` - `0xb626` is 46630, which proves the
request reached the intended chain rather than merely returning something.

### Security headers

`dist/_headers` is **generated at build time** by `build/securityHeaders.ts`, from the policy in
`src/lib/securityHeaders.ts`.
It is not committed, because `connect-src` has to name every origin the app may talk to and those
come from the build environment - a hand-written list would be right on the day it was written and
silently wrong the first time `VITE_SUBGRAPH_URL` or `VITE_CHAIN_ID` moved.
A blocked `fetch` renders as an empty panel, not as an error.

⚠️ **`_headers` does not reach the Function.** Measured: the app shell came back carrying all eight
headers and `/rpc` came back with none, because `_headers` is applied by Pages' static-asset layer.
`functions/rpc.ts` therefore sets its own (`apiSecurityHeaders`).

⚠️ **`style-src` is `'self'` with no `'unsafe-inline'`, and that is load-bearing on one chart
option.** `lightweight-charts` renders the TradingView attribution logo by injecting a `<style>`
element, which this policy blocks - verified in the running app. `CurveChart.tsx` sets
`attributionLogo: false`, so the path never runs, and a test pins it.

**SRI is deliberately not implemented.** Vite emits two external assets, both same-origin,
content-hashed and served by the same host as the HTML that references them. An attacker able to
alter `/assets/index-*.js` can alter `index.html` and its `integrity` attributes in the same breath,
so there is no split in trust for SRI to protect - while a stale or edge-transformed hash blanks the
whole app. Recorded in `docs/security-checklist.md`.

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
