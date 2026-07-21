# uniswap-v3

A Uniswap-**V3**-based DEX + bonding-curve launchpad on **Robinhood Chain** (chainID 4663). New projects launch via a pump.fun-style bonding curve; on reaching a fixed-ETH threshold a token graduates atomically into a permanently-locked, full-range `TOKEN/WETH` V3 pool.

The architecture decisions driving the build are charted on the **wayfinder map** — GitHub issue [#1](https://github.com/imDev2023/uniswap-v3/issues/1) (label `wayfinder:map`); its closed child tickets record each locked decision.

## Agent skills

### Issue tracker

Issues are tracked in this repo's **GitHub Issues** via the `gh` CLI. External PRs are **not** a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical label vocabulary — `needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context layout: a `CONTEXT-MAP.md` at the root points to per-context `CONTEXT.md` files (created lazily by `/domain-modeling`). See `docs/agents/domain.md`.

## Build workflow (for the next session)

The contracts live in `contracts/` (Foundry). Toolchain is installed at `~/.foundry/bin` and OpenZeppelin + Uniswap V3 artifacts are in `contracts/node_modules` (both persist on disk).

```bash
export PATH="$HOME/.foundry/bin:$PATH"
cd contracts && forge test          # fork tests hit Robinhood Chain (rpc alias: robinhood = 4663)
```

Ticket rhythm (build tickets #12–#21, tracked as GitHub issues; the map is #1, spec is #11):
1. One ticket per branch: `build/<NN>-<slug>`, branched from `main`.
2. Implement + write tests at the fork-test seam; keep the full suite green.
3. Run `/code-review` (two axes) against `main`; apply worthwhile findings.
4. Comment status on the ticket; merge the branch to `main` before the next ticket.

**Current state:** #12–#21 done and merged to `main` — **the full build sequence is complete.** Contracts (#18) are feature-complete (52/52 tests green); the subgraph (#19) is in `subgraph/`; the frontend (#20/#21) is in `frontend/`. The only remaining work is the out-of-band **deploy** (real deployer keys: testnet 46630 → mainnet 4663 broadcast + Blockscout verification, then fill the subgraph/frontend addresses) — runbook is `docs/deploy.md`. Everything downstream of the deploy (subgraph indexing, frontend live e2e) is fully wired through config and validated in-session, gated only on those addresses.

**#20/#21 shape (Builds 09/10 — frontend):** Custom React + Vite + TS SPA in `frontend/` (spec decision #8 — **not** a `Uniswap/interface` fork). wagmi/viem (injected connector only), react-query with ~5s live polling, graphql-request against the #19 subgraph, recharts. **#20:** create-token form (`createLaunch`; image stored client-side as v1 has no on-chain image field), live curve view (chart + progress from subgraph, buy/sell quoted on-chain via `quoteBuy`/`quoteSell`, anti-snipe cap from cumulative `purchasedOf`), transparent creator/holder positions. **#21:** "just graduated" feed + live-curves browse, and a swap page (`/swap/:address`) trading graduated pools through the platform's **own v3-periphery `SwapRouter`** — ETH→TOKEN via payable `exactInputSingle`, TOKEN→ETH via `multicall([exactInputSingle → router, unwrapWETH9 → user])`; no Quoter deployed so output is a labelled spot-price estimate from `slot0` with on-chain `amountOutMinimum` protection (deploying a `QuoterV2` is the follow-up). **43 unit tests green** (`cd frontend && npm test`), `tsc -b` + `vite build` clean. Env-driven addresses (`VITE_FACTORY_ADDRESS` / `VITE_SWAP_ROUTER_ADDRESS` / `VITE_SUBGRAPH_URL`); runs in preview mode with a banner until set. Both reviews applied per ticket. Bundle is ~868 kB (wagmi pulls unused WalletConnect/MetaMask SDK — a `manualChunks`/trim follow-up); token images are per-browser (metadata-contract follow-up).

**#19 shape (Build 08 — subgraph):** The Graph subgraph in `subgraph/` (graph-node toolchain) indexing `eip155:4663`. Sources: `LaunchpadFactory.LaunchCreated` (fixed addr) → `Token` + spawns a **`BondingCurve` data-source template** per launch (curve addresses are runtime-discovered; token address passed via data-source context); `BondingCurve.Bought/Sold/Graduation` (template) → `Trade`/`Holder`/curve-progress; `GraduationManager.Graduated` (fixed addr) → the `Graduation` feed. Entities: `Factory` (rollups), `Token` (curve progress: reserves, tokensSold, priceX18, progressBps vs 800M), `Trade` (immutable buy/sell log), `Holder` (netted on-curve position), `Graduation` (just-graduated feed). All derived from events, **no eth_calls** (CURVE_SUPPLY is a constant) → deterministic + matchstick-testable. **8 matchstick tests green** (`cd subgraph && npm test`; needs `libpq` on macOS — see `subgraph/README.md`). Both reviews applied: fixed a `volumeEth` overcount on the graduation-crossing buy (was counting the refunded ETH). **Not deployed** — self-hosted graph-node (chain 4663 isn't on The Graph's hosted/decentralized nets); manifest carries placeholder addresses pending #18 deploy keys, filled via `networks.json` (`graph build --network robinhood`). v1 holders are curve-position-only; secondary ERC-20 transfers are a documented follow-up.

**#18 shape:** `LaunchpadFactory` is now `Ownable2Step` (two-step handoff to a Safe multisig — a mistyped owner can't brick control). Added guarded `setCurveParams` (virtualEthReserve / tradeFeeBps ≤10% / maxBuyPerWallet / antiSnipeThreshold ≤800M), future-only; `virtualTokenReserve` stays calibration-locked so graduation price continuity (#16) holds for any V_eth. Full deploy pipeline in `contracts/script/DeployLaunchpad.s.sol` + runbook `docs/deploy.md` (testnet 46630 → mainnet 4663, Blockscout verify). Real on-chain broadcast + Blockscout verification need deploy keys (not available in-session); delivered as production scripts + runbook, validated via fork dry-run + a fork test mirroring the ownership choreography.

**Optional low-severity test gaps left on #17** (flagged in review, non-blocking): negative-owner tests for `setProtocolFee`/`setPoolProtocolFee`; an explicit `NPM.burn` reverts assertion; a `ProtocolFeeSkipped`-path test.
