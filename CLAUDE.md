# Octopus

**Octopus** is a DEX + bonding-curve launchpad on **Robinhood Chain** (chainID 4663). New projects launch via a pump.fun-style bonding curve; on reaching a fixed-ETH threshold a token graduates atomically into a permanently-locked, full-range `TOKEN/WETH` pool.

> **Naming.** "Octopus" is the product brand (working name). The AMM underneath is **unmodified Uniswap V3**, deployed byte-for-byte from the audited artifacts via `vm.getCode` (decision #4) — we run our own instance and own the factory, but we did not write an AMM.
>
> Keep the two separate when editing: **rebrand product surfaces** (UI copy, package names, subgraph deploy name, docs) — but **never rename or strip** technical/legal references to upstream: `@uniswap/v3-core`/`v3-periphery` deps, `IUniswapV3Factory`/`IUniswapV3Pool` interfaces, artifact paths in `V3Deployer.sol`, or the `GPL-2.0-or-later` SPDX headers. Those name real upstream software and carry licence obligations. The repo directory and git remote are still `uniswap-v3`; renaming those is cosmetic and deferred.
>
> Also unchanged: **deployed Solidity contract names** (`LaunchpadFactory`, `GraduationManager`, `LPLock`). Renaming them means redeploying and re-verifying the whole testnet stack and re-cutting the subgraph ABIs — not worth it pre-mainnet. The `Factory` entity id in the subgraph is likewise still the literal string `"launchpad"`.

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

**Testnet curve calibration:** the live 46630 factory graduates a new launch for **exactly 0.1 ETH** (`virtualEthReserve = 1/30 ETH = 33333333333333333`; ETH-to-graduate is always `3 × V_eth`), anti-snipe off. Verified on-chain via launch `P1ETH`. `setCurveParams` is future-only, so older launches keep their frozen calibration. Solidity constants are untouched — a **mainnet deploy still lands on production calibration (90 ETH)**. Restore/re-scale commands in `docs/deployments-testnet.md`.

**Current state:** #12–#21 done and merged to `main` — **the full build sequence is complete**, and the stack is **deployed and smoke-tested on testnet 46630**. Addresses, tx hashes and the full end-to-end smoke test are in **`docs/deployments-testnet.md`**; `subgraph/networks.json` and `frontend/.env.local` are wired to them. Contracts (#18) are feature-complete (52/52 tests green); subgraph (#19) in `subgraph/`; frontend (#20/#21) in `frontend/`.

Testnet run validated on-chain: curve create/buy/sell, the anti-snipe cap (including that a sell does **not** decrease `purchasedOf`), future-only `setCurveParams`, a full graduation (pool seeded + full-range LP NFT locked in `LPLock` + `feeProtocol` applied), and both swap-router directions incl. `multicall`+`unwrapWETH9`. **`P1ETH` graduated on the live 0.1 ETH calibration** (pool `0x8c723D40…CDf2`, LP NFT id 2 locked) and the whole chain reacted — subgraph `Graduation` entity matches wei-for-wei, frontend feed and swap page both light up. **`LPLock.collect` is proven on-chain**: fees swept to treasury from locked NFT 1 with principal and ownership untouched. `LaunchpadFactory`/`GraduationManager`/`LPLock` are Blockscout-verified.

**The indexer is live.** `subgraph/docker/docker-compose.yml` runs graph-node + Postgres + IPFS; the subgraph is deployed as `octopus/octopus` and synced from `startBlock` 93090715. Query endpoint **`http://localhost:8100/subgraphs/name/octopus/octopus`** (both path segments; host ports are remapped into the 81xx range because 8000/8080 collide with other local stacks — status API on 8130, deploy admin on 8120). The older `launchpad/launchpad` name still exists in the DB pointing at the same deployment; `octopus/octopus` is the one to use. **The stack needs ~1 GB of Docker VM headroom** — if IPFS shows `Restarting (137)` with `OOMKilled=false`, the VM is in global OOM, not the subgraph broken; see `subgraph/README.md`. Every indexed entity reconciles against the on-chain smoke test — table in `subgraph/README.md`. The frontend runs against it: feeds, curve charts, holder tables and the swap page's pool resolution all populate from live subgraph data. On a 0.3s-block chain the **block ingestor**, not the log scan, is the bottleneck — stock settings sit ~2 min behind head and never converge; the tuned compose env holds a stable ~40s. Note `synced: true` compares against graph-node's *own* ingested head, so it can read true while genuinely behind the chain — measure lag against `eth_blockNumber`.

**`QuoterV2` is deployed** at `0xC02123e9Ac2E87BDC85dB4af0664b2d694c4e857` (testnet 46630) via the standalone `contracts/script/DeployQuoter.s.sol` — a read-side lens with no owner and no funds, so it drops onto a live deployment safely. The swap page now shows **exact** quotes (fee + price impact) via `VITE_QUOTER_ADDRESS`, falling back to the old `slot0` estimate when unset. `contracts/test/QuoterV2.t.sol` pins quote == actual execution against the live pool (57/57 tests green). Note `quoteExactInputSingle` is non-`view` — call it with `eth_call` only.

**Multi-wallet testing is done.** `contracts/.env` holds `TEST_PK_1..6` (0.4 ETH each). Launch `SNIPE` exercised **anti-snipe across six competing wallets** — cap binding (`BuyCapExceeded`), cap-as-ceiling, sell-then-rebuy evasion blocked, the crossing buy still capped (decision #7), the cap lifting after the 120M window, and graduation with **6 holders** whose subgraph netting closes to the wei. Anti-snipe was armed for it and then **restored to the baseline** (`antiSnipeThreshold = 0`); re-arm with `setCurveParams(33333333333333333, 100, 25e24, 120e24)`. Note production (8M cap / 120M threshold) needs **≥15 distinct wallets** to traverse the window by design.

**Remaining:** (1) **mainnet 4663 deploy** — same runbook, `docs/deploy.md` (plus `DeployQuoter.s.sol`); (2) verify the V3 stack + quoter on Blockscout (deployed via `vm.getCode`, so it needs a standard-JSON input from the upstream artifacts); (3) a launched-but-untraded token indexes with `priceX18 = 0` — `LaunchCreated` carries no reserves and the pruned RPC forbids an `eth_call` on backfill, so fixing it means emitting the frozen curve params from the contract (see `subgraph/README.md`); (4) **frontend visual design** — the 🐙 wordmark is a placeholder and the CSS is deliberately plain.

⚠️ **Fork tests against 46630 must not fork at `latest`.** The node rejects state at the newest block (`-32000 unsupported block number`) and prunes state after ~5,600 blocks (~28 min). `QuoterV2.t.sol` reads the head at runtime and forks 300 blocks back; a hardcoded block number rots within the hour.

> ⚠️ **WETH9 is per-chain.** `Constants.WETH9` is **mainnet-only** and has **no code on 46630**. Testnet WETH9 is `0x7943e237c7F95DA44E0301572D358911207852Fa` (byte-identical proxy + implementation to mainnet's). Always pass `WETH9=` explicitly to `DeployLaunchpad.s.sol`. The frontend now selects it per `VITE_CHAIN_ID`.
>
> ⚠️ `forge script --broadcast` needs **`--non-interactive`**: `LaunchpadFactory` is 26,586 bytes (over EIP-170; fine on Orbit) and forge otherwise opens a TTY prompt that dies with `IO error: not a terminal`.

**#20/#21 shape (Builds 09/10 — frontend):** Custom React + Vite + TS SPA in `frontend/` (spec decision #8 — **not** a `Uniswap/interface` fork). wagmi/viem (injected connector only), react-query with ~5s live polling, graphql-request against the #19 subgraph, recharts. **#20:** create-token form (`createLaunch`; image stored client-side as v1 has no on-chain image field), live curve view (chart + progress from subgraph, buy/sell quoted on-chain via `quoteBuy`/`quoteSell`, anti-snipe cap from cumulative `purchasedOf`), transparent creator/holder positions. **#21:** "just graduated" feed + live-curves browse, and a swap page (`/swap/:address`) trading graduated pools through the platform's **own v3-periphery `SwapRouter`** — ETH→TOKEN via payable `exactInputSingle`, TOKEN→ETH via `multicall([exactInputSingle → router, unwrapWETH9 → user])`; output now comes from our own `QuoterV2` (exact, incl. fee + price impact) with on-chain `amountOutMinimum` protection, falling back to a labelled `slot0` spot estimate when `VITE_QUOTER_ADDRESS` is unset. **43 unit tests green** (`cd frontend && npm test`), `tsc -b` + `vite build` clean. Env-driven addresses (`VITE_FACTORY_ADDRESS` / `VITE_SWAP_ROUTER_ADDRESS` / `VITE_SUBGRAPH_URL`); runs in preview mode with a banner until set. Both reviews applied per ticket. Bundle is ~868 kB (wagmi pulls unused WalletConnect/MetaMask SDK — a `manualChunks`/trim follow-up); token images are per-browser (metadata-contract follow-up).

**#19 shape (Build 08 — subgraph):** The Graph subgraph in `subgraph/` (graph-node toolchain) indexing `eip155:4663`. Sources: `LaunchpadFactory.LaunchCreated` (fixed addr) → `Token` + spawns a **`BondingCurve` data-source template** per launch (curve addresses are runtime-discovered; token address passed via data-source context); `BondingCurve.Bought/Sold/Graduation` (template) → `Trade`/`Holder`/curve-progress; `GraduationManager.Graduated` (fixed addr) → the `Graduation` feed. Entities: `Factory` (rollups), `Token` (curve progress: reserves, tokensSold, priceX18, progressBps vs 800M), `Trade` (immutable buy/sell log), `Holder` (netted on-curve position), `Graduation` (just-graduated feed). All derived from events, **no eth_calls** (CURVE_SUPPLY is a constant) → deterministic + matchstick-testable. **8 matchstick tests green** (`cd subgraph && npm test`; needs `libpq` on macOS — see `subgraph/README.md`). Both reviews applied: fixed a `volumeEth` overcount on the graduation-crossing buy (was counting the refunded ETH). **Not deployed** — self-hosted graph-node (chain 4663 isn't on The Graph's hosted/decentralized nets); manifest carries placeholder addresses pending #18 deploy keys, filled via `networks.json` (`graph build --network robinhood`). v1 holders are curve-position-only; secondary ERC-20 transfers are a documented follow-up.

**#18 shape:** `LaunchpadFactory` is now `Ownable2Step` (two-step handoff to a Safe multisig — a mistyped owner can't brick control). Added guarded `setCurveParams` (virtualEthReserve / tradeFeeBps ≤10% / maxBuyPerWallet / antiSnipeThreshold ≤800M), future-only; `virtualTokenReserve` stays calibration-locked so graduation price continuity (#16) holds for any V_eth. Full deploy pipeline in `contracts/script/DeployLaunchpad.s.sol` + runbook `docs/deploy.md` (testnet 46630 → mainnet 4663, Blockscout verify). Real on-chain broadcast + Blockscout verification need deploy keys (not available in-session); delivered as production scripts + runbook, validated via fork dry-run + a fork test mirroring the ownership choreography.

**Optional low-severity test gaps left on #17** (flagged in review, non-blocking): negative-owner tests for `setProtocolFee`/`setPoolProtocolFee`; an explicit `NPM.burn` reverts assertion; a `ProtocolFeeSkipped`-path test.
