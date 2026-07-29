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

Ticket rhythm (build tickets #12–#21 built the stack; #22–#25 are merged; **Stages 1 and 2 are done — the next branch is `build/26-<slug>`, for Stage 3 (frontend redesign) or Stage 4 (infrastructure); both run in parallel with the audit wait**. Tracked as GitHub issues; the map is #1, spec is #11):
1. One ticket per branch: `build/<NN>-<slug>`, branched from `main`.
2. Implement + write tests at the fork-test seam; keep the full suite green.
3. Run `/code-review` (two axes) against `main`; apply worthwhile findings.
4. Comment status on the ticket; merge the branch to `main` before the next ticket.

### Live testnet 46630 addresses (build #24 — supersedes everything earlier)

| | |
| --- | --- |
| `LaunchpadFactory` | `0x632FD8713356aCc4ec9BdC6b378c05707bc9D1E7` ✅ verified |
| `GraduationManager` | `0x3e28d8838951C9F1ad229a5506584616E46D5E14` ✅ verified |
| `LPLock` | `0x8FBAa12EEF6BB15C7dD33cCaAB62dbb9e3BeC0e1` ✅ verified |
| `UniswapV3Factory` | `0x158a14f6Aa8C86921e624e3ed0526F31520cB2BD` |
| `SwapRouter` | `0x4507B2864CEcaBE10330d927c9608AA55A00fFD3` |
| `NonfungiblePositionManager` | `0xFc1C035Dc7e0C91ECFE8AC3bC31D1AC05d780CC4` |
| `QuoterV2` | `0xfcfA720Fe7397cA75233C6DB7aCBDa5859835cf6` |
| `WETH9` (pre-existing) | `0x7943e237c7F95DA44E0301572D358911207852Fa` |
| Deployer = SAFE = treasury | `0x8Ec5f1e04531416d337E61733DfC5d1685D9A80C` |
| Subgraph `startBlock` | `94091260` |

`owner() == SAFE`, `pendingOwner() == 0x0`. Only launch on this factory is **`META`** (token `0x52eEF29C3c869b4D04F3C1451b16548dEaa923bE`), which is graduated — pool `0xDC27FeCB8589c0FB0328fd98963c823a1681E933`, LP NFT 1 locked. **The six older launches (`P1ETH`, `SNIPE`, `GRAD`, `RDOGE`, `SMOKE`, `ONEETH`) are on the SUPERSEDED factory `0xE98B99ADD42c550bf40B887Bf07A8f0119a22232` and are unreachable from the current one.**

**Testnet curve calibration:** the live 46630 factory graduates a new launch for **exactly 0.1 ETH** (`virtualEthReserve = 1/30 ETH = 33333333333333333`; ETH-to-graduate is always `3 × V_eth`), anti-snipe off — re-applied after the #24 redeploy via `setCurveParams(33333333333333333, 100, 8e24, 0)`. `setCurveParams` is future-only, so older launches keep their frozen calibration. Solidity constants are untouched — a **mainnet deploy still lands on production calibration (90 ETH)**. Restore/re-scale commands in `docs/deployments-testnet.md`.

**Current state:** #12–#21 done and merged to `main` — **the full build sequence is complete**, and the stack is **deployed and smoke-tested on testnet 46630**. Build **#24** (Stage 1: frozen curve params in `LaunchCreated`, on-chain `metadataURI`, `token`-indexed trade events, optimizer on) is merged. **`main` is pushed to `origin/main`.** Addresses, tx hashes and the full end-to-end smoke test are in **`docs/deployments-testnet.md`**; `subgraph/networks.json` and `frontend/.env.local` are wired to them. Contracts are feature-complete and **frozen for audit** (84/84 tests green); subgraph (#19) in `subgraph/`; frontend (#20/#21) in `frontend/`.

Testnet run validated on-chain: curve create/buy/sell, the anti-snipe cap (including that a sell does **not** decrease `purchasedOf`), future-only `setCurveParams`, a full graduation (pool seeded + full-range LP NFT locked in `LPLock` + `feeProtocol` applied), and both swap-router directions incl. `multicall`+`unwrapWETH9`. **`P1ETH` graduated on the live 0.1 ETH calibration** (pool `0x8c723D40…CDf2`, LP NFT id 2 locked) and the whole chain reacted — subgraph `Graduation` entity matches wei-for-wei, frontend feed and swap page both light up. **`LPLock.collect` is proven on-chain**: fees swept to treasury from locked NFT 1 with principal and ownership untouched. `LaunchpadFactory`/`GraduationManager`/`LPLock` were Blockscout-verified on that deployment.

⚠️ **Build #24 redeployed the whole stack**, so every address above moved and the launches named in this paragraph (`P1ETH`, `SNIPE`, `GRAD`, `RDOGE`, `SMOKE`, `ONEETH`) live on the **superseded** factory `0xE98B99ADD42c550bf40B887Bf07A8f0119a22232`. Their validation records still stand for the behaviour they exercised, but they are not reachable from the current factory, and the contracts needed re-verifying on Blockscout. **All three are now verified** (`LaunchpadFactory`, `GraduationManager`, `LPLock` — solc 0.8.24, optimizer 200, confirmed in explorer metadata). The long-standing "internally-created contracts can't be verified" blocker is **resolved as of 2026-07-28**: the explorer now has creation bytecode for factory-created contracts, and both verified first try with ordinary `forge verify-contract` + explicit constructor args. See `docs/deployments-testnet.md`. The current deployment was re-validated end-to-end via launch `META` — see `docs/deployments-testnet.md`.

**The indexer is live.** `subgraph/docker/docker-compose.yml` runs graph-node + Postgres + IPFS; the subgraph is deployed as `octopus/octopus` and synced from `startBlock` 94091260. Query endpoint **`http://localhost:8100/subgraphs/name/octopus/octopus`** (both path segments; host ports are remapped into the 81xx range because 8000/8080 collide with other local stacks — status API on 8130, deploy admin on 8120). The older `launchpad/launchpad` name still exists in the DB pointing at the same deployment; `octopus/octopus` is the one to use. **The stack needs ~1 GB of Docker VM headroom** — if IPFS shows `Restarting (137)` with `OOMKilled=false`, the VM is in global OOM, not the subgraph broken; see `subgraph/README.md`. Every indexed entity reconciles against the on-chain smoke test — table in `subgraph/README.md`. The frontend runs against it: feeds, curve charts, holder tables and the swap page's pool resolution all populate from live subgraph data. On a 0.3s-block chain the **block ingestor**, not the log scan, is the bottleneck — stock settings sit ~2 min behind head and never converge; the tuned compose env holds a stable ~40s. Note `synced: true` compares against graph-node's *own* ingested head, so it can read true while genuinely behind the chain — measure lag against `eth_blockNumber`.

**`QuoterV2` is deployed** at `0xfcfA720Fe7397cA75233C6DB7aCBDa5859835cf6` (testnet 46630) via the standalone `contracts/script/DeployQuoter.s.sol` — a read-side lens with no owner and no funds, so it drops onto a live deployment safely. The swap page now shows **exact** quotes (fee + price impact) via `VITE_QUOTER_ADDRESS`, falling back to the old `slot0` estimate when unset. `contracts/test/QuoterV2.t.sol` pins quote == actual execution against the live pool. Note `quoteExactInputSingle` is non-`view` — call it with `eth_call` only.

**Multi-wallet testing is done.** `contracts/.env` holds `TEST_PK_1..6` (0.4 ETH each). Launch `SNIPE` exercised **anti-snipe across six competing wallets** — cap binding (`BuyCapExceeded`), cap-as-ceiling, sell-then-rebuy evasion blocked, the crossing buy still capped (decision #7), the cap lifting after the 120M window, and graduation with **6 holders** whose subgraph netting closes to the wei. Anti-snipe was armed for it and then **restored to the baseline** (`antiSnipeThreshold = 0`); re-arm with `setCurveParams(33333333333333333, 100, 25e24, 120e24)`. Note production (8M cap / 120M threshold) needs **≥15 distinct wallets** to traverse the window by design.

## Road to mainnet (agreed 2026-07-26; Stage 1 closed 2026-07-27)

**There is no backend left to build, and the contracts are now frozen.** What remains is the audit, the frontend redesign, deployment and hosting.

**The audit is the long pole** (external dependency, unpredictable latency) and it could not start until the contracts were final — which they now are. So the sequencing from here is *hand to auditors → Stages 2/3/4 in parallel with the audit wait → Stage 5 deploy*. Stages 2, 3 and 4 are independent of each other and can be taken in any order; **Stage 2 is the best resilience-per-hour.**

### Stage 1 — finalise contracts ✅ DONE (build #24)

**Shipped and validated on testnet 46630.** `LaunchCreated` now carries the metadata URI and all six frozen curve params; `LaunchToken` has permanent `metadataURI` plus a `launchpad` back-reference; `token` is indexed on `Bought`/`Sold`; the optimizer is on. 84/84 contract tests, 13/13 matchstick, 43/43 frontend. **`docs/audit-scope.md` is the hand-off document for the auditors** — it emphasises the graduation transition and records one real finding: the crossing-buy clamp IS reachable, costing the protocol ≤1 wei while leaving the raise exactly calibrated.

What shipped, and the settled decisions behind it:

1. **`LaunchCreated` emits the full frozen curve set** — `metadataURI`, `virtualEthReserve`, `virtualTokenReserve`, `curveTokenAllocation`, `tradeFeeBps`, `maxBuyPerWallet`, `antiSnipeThreshold`. `createLaunch` builds ONE `CurveConfig` in memory and uses it both to construct the curve and to populate the event, so log and immutables cannot drift. Killed the `priceX18 = 0` bug (an untraded launch now indexes its true opening price) and removed the last hardcoded Solidity constant from the subgraph mappings.
2. **On-chain metadata URI** — `string public metadataURI` on `LaunchToken`, constructor-set, **no setter for anyone**. The three design decisions (all settled 2026-07-27):
   - ✅ **JSON metadata URI**, NFT-standard shape (`{name, description, image, banner, links}`) — not an image URI. Bought once so description/socials/banner can be added later without a new contract.
   - ✅ **Immutable at creation.** No setter, for anyone — matches the "fair launch, no rug" ethos the locked LP already establishes, and rules out bait-and-switch (clean art at launch, swapped after people buy).
   - ✅ **Stored on the token contract** (`string public metadataURI`) **and emitted** in `LaunchCreated`. Readable over plain RPC with no indexer, which is exactly what Stage 2 needs. ~40–45k gas once at creation, negligible against the 0.01 ETH creation fee.

   Shape: `createLaunch(name, symbol, metadataURI)`.

   ⚠️ **Consequence — this decision creates the project's first server-side component.** Immutable + content-addressed means uploading to IPFS *before* `createLaunch`, and pinning needs an API key that **cannot** live in a Vite bundle. So the create-token flow needs either (a) a small serverless upload/pin endpoint holding the pinning secret (Pinata / web3.storage / Filebase), (b) creators bringing their own URI (bad UX, fine for v1), or (c) a client-safe upload service. Decide during Stage 3. It also adds an **IPFS gateway** as a frontend read dependency — pick one deliberately and have a fallback.

   ⚠️ **Two consequences of immutability to design for:** an unpinned or typo'd URI is permanent, so the UI needs a graceful fallback avatar and the pin must be durable; and abusive imagery cannot be removed on-chain, so **moderation is a frontend denylist** — plan for one rather than discovering the need in production.
3. **Last-call pass.** Two additions accepted: **`token` indexed on `Bought`/`Sold`** (one `eth_getLogs` filter now covers every launch, including ones that don't exist yet — groundwork for Stage 2) and **`LaunchToken.launchpad`** (a token names its own factory, so `token.launchpad()` → `curveOf(token)` resolves a curve in two RPC calls with no indexer and no prior knowledge of the factory set). Two candidates **declined**: emitting cumulative `purchasedOf` in `Bought` (derivable), and changing the frozen `treasury` (documented as an owner operational constraint instead).
4. **Optimizer switched on (200 runs)** — it had never been enabled. `LaunchpadFactory` went 27,594 B → **15,942 B, under EIP-170**, so the deploy no longer depends on Orbit's relaxed limit.

**Audit is covered** — the user's Solidity-developer friends. **Do not propose audit vendors.** `docs/audit-scope.md` is the hand-off document: it directs reviewers at the **graduation transition** (atomic curve→pool handoff, crossing-buy refund arithmetic, curve rounding direction) — where our code meets Uniswap V3 and no upstream audit covers.

⚠️ **One real finding is already recorded there: the crossing-buy clamp IS reachable.** `grossNeeded` is a `ceilDiv` and the fee is a floor division, so `grossNeeded - 1` still crosses. The **raise stays exactly calibrated** — the protocol's own fee absorbs the wei — and underpaying by 1000 wei doesn't cross at all. Pinned in `contracts/test/CrossingBuyBoundary.t.sol`. The brief asks reviewers to verify the bound rather than re-derive it.

### Stage 2 — decouple trading from the indexer ✅ DONE (build #25)

**Shipped and validated against a real indexer outage.** The trade path no longer touches the subgraph. `hooks/useOnchainToken.ts` resolves everything from the one address baked into the build (`VITE_FACTORY_ADDRESS`): `curveOf(token)` → curve, `curve.graduated()`, `launchpad.v3Factory()` → `getPool(token, WETH, 10000)` → pool, plus ERC-20 `name`/`symbol`. Two Multicall3 rounds, verified on-chain to return exactly the addresses the subgraph used to supply.

Settled decisions:

1. **The launchpad is the root of trust, not `LaunchToken.launchpad()`.** A token can name any factory it likes; trusting that would let a hostile ERC-20 at `/token/0x…` point the UI at a fake curve and collect real ETH. Asking *our* launchpad "is this yours?" (`curveOf(token) != 0`) cannot be spoofed. Verified against WETH9 → "not a token launched on Octopus".
2. **Degradation is visible and per-panel.** A global banner states the indexer is down *and that trading is unaffected*; each indexed panel (chart / curve stats / holders) degrades to its own labelled notice rather than rendering empty — an empty chart reads as "no trades", a different and worse lie.
3. **Lag is measured in block timestamps, not `synced`.** graph-node's `synced` compares against its own ingested head and reads true while minutes behind. `_meta.block.timestamp` vs the RPC head timestamp is skew-free and needs no per-chain block-time constant. Threshold 300 s, matching the ops alert rule.
4. **Multicall3 declared on both chains** (canonical address, confirmed present on 4663 and 46630) so each resolution round is one `eth_call` at a single block — fewer round-trips and no torn read.

⚠️ **Fixed a pre-existing trade-path bug:** viem's `isAddress` is strict about EIP-55 checksum casing, so a correctly-formed address with different casing was rejected as "Invalid token address" before any RPC call — including the META address as written in this file. Route params now parse case-insensitively via `lib/address.ts` and normalise with `getAddress`; the `curveOf != 0` check is what actually guards safety.

### Stage 3 — frontend redesign (parallel with audit; largest remaining chunk)

Build against the *final* Stage-1 data shape. The 🐙 wordmark is a placeholder and the CSS is deliberately plain. Open framing questions, unanswered: high-energy pump.fun-style board vs restrained/credible; keep the emoji wordmark or commission a real identity; visual pass only vs re-thinking flows (the homepage currently front-loads "Just graduated" above live curves, arguably backwards for a launchpad). Also queued: trim the ~868 kB bundle (wagmi pulls unused WalletConnect/MetaMask SDK).

### Stage 4 — infrastructure (parallel with audit)

**The chain is the source of truth; Postgres is a derived cache** rebuildable by re-indexing. So you need *fast re-index* and a *durable log source*, not PITR backups. Losing the indexer DB is an availability incident, not data loss. The one genuinely non-derivable thing is token metadata — which Stage 1 moves on-chain.

- **RPC is the real #1 dependency**, not the database: frontend *and* indexer both need it, and the frontend calls it **directly from users' browsers** (traffic scales with users; an API key in a Vite bundle is public — proxy it or use domain allowlisting). Run **two endpoints with failover**; it's the only component with no graceful degradation.
- ⚠️ **Re-run the RPC capability probes against mainnet 4663 — never measured.** Log-retention depth matters most: if mainnet prunes logs below the deploy block, re-indexing becomes impossible and the "rebuildable cache" assumption dies.
- **Indexer hosting:** managed subgraph host (Goldsky / Alchemy / SettleMint — *ask whether they support 4663 first*) or self-host graph-node on a real VM (8 GB min, 16 GB comfortable). [Ponder](https://ponder.sh) is a lighter alternative (plain Postgres, no IPFS) but means rewriting the mappings and discarding 13 matchstick tests — don't switch unless graph-node ops become the problem.
- ⚠️ **Verify Postgres locale/collation before picking a managed provider.** graph-node requires `C` collation and it can only be set at cluster creation — unfixable afterwards without recreating the DB.
- **Frontend:** static SPA → Cloudflare Pages / Vercel / Netlify. Addresses are baked in at **build** time, so a contract change means a rebuild.
- **Monitoring:** graph-node already exposes Prometheus metrics (container 8040 → host 8140). Alert on **indexer lag > 5 min** (compare `latestBlock` to RPC `eth_blockNumber` — `synced: true` lies) and **any owner-role transaction**.
- **Rough cost ~$200–500/mo**: indexer VM $40–80, managed Postgres $25–100, RPC $100–300, frontend $0–20, monitoring $0–30.

**Service verdicts (asked 2026-07-26):** **Postgres** ✅ required (graph-node's store, not a choice). **PostHog** ✅ fine for analytics. **Convex** 🟡 good for metadata/comments/watchlists — must *not* replace the subgraph (no reorg handling, no re-index story). **Trigger.dev** 🟡 optional; one real use case is scheduled permissionless `LPLock.collect` fee sweeps, which otherwise accrue untouched. **Prisma** ❌ not needed — graph-node owns its Postgres schema (`sgd1.*`, block-range columns for time-travel); it is an internal format, not a stable API. Never write to it; query GraphQL instead.

### Stage 5 — mainnet deploy

Audit findings → fixes → deploy per `docs/deploy.md` (+ `DeployQuoter.s.sol`), remembering `WETH9=` explicitly. **Do not deploy to mainnet 4663 without asking the user first.**

### Also settle before deploy

- **Root `LICENSE` file** — repo has none and declares none, while all Solidity is `GPL-2.0-or-later`. The user's call, still outstanding.
- **"Octopus" trademark clearance** — not done.
- **`SAFE` must be a real multisig on mainnet.** On testnet it is the deployer EOA.
- **Verify the V3 stack + QuoterV2 on Blockscout** — deployed via `vm.getCode`, so it needs a standard-JSON input built from the upstream `@uniswap/v3-core`/`v3-periphery` artifacts. Until then users cannot read the code they trade against.
- ✅ **RESOLVED 2026-07-28 — `GraduationManager` / `LPLock` are verified.** Both are internal `CREATE`s from the factory constructor, which the testnet explorer previously could not verify (no `creation_bytecode`). It now can: both verified first try with ordinary `forge verify-contract` + explicit constructor args. Mainnet Blockscout is a newer build (`v11.2.3` vs `v10.2.6`) and already hosts many verified factory-created contracts (18 of 20 sampled), so the gap does not exist there either. **The proposed fallback — deploying the two peripherals top-level, a contract change that would have had to precede the audit — is dropped. Contracts stay frozen as audited.** Details in `docs/deployments-testnet.md`.

⚠️ **Fork tests against 46630 must not fork at `latest`.** The node rejects state at the newest block (`-32000 unsupported block number`) and prunes state after ~5,600 blocks (~28 min). `QuoterV2.t.sol` reads the head at runtime and forks 300 blocks back; a hardcoded block number rots within the hour.

> ⚠️ **WETH9 is per-chain.** `Constants.WETH9` is **mainnet-only** and has **no code on 46630**. Testnet WETH9 is `0x7943e237c7F95DA44E0301572D358911207852Fa` (byte-identical proxy + implementation to mainnet's). Always pass `WETH9=` explicitly to `DeployLaunchpad.s.sol`. The frontend now selects it per `VITE_CHAIN_ID`.
>
> ℹ️ **The optimizer is on (200 runs) as of #24**, which took `LaunchpadFactory` from 27,594 B to **15,942 B — under EIP-170**. `--non-interactive` on `forge script --broadcast` is therefore no longer required (it existed only to skip forge's oversize TTY prompt, which died with `IO error: not a terminal`). Harmless to keep. Build settings are part of what the auditors review and what Blockscout verification must match.

**#25 shape (Build 12 — Stage 2, RPC-first trading):** The trade path is fully decoupled from the indexer. New `hooks/useOnchainToken.ts` resolves curve, graduation state, pool and labels from RPC alone, rooted at `VITE_FACTORY_ADDRESS`; `lib/onchainToken.ts` holds the decision table as a pure function (15 unit tests) so the money path's states are testable without a chain. New `hooks/useIndexerStatus.ts` + `lib/indexerHealth.ts` measure real lag (`_meta.block.timestamp` vs RPC head timestamp — never `synced`) and drive a global `IndexerBannerView` plus per-panel `IndexedDataNotice`. `SwapPage` and `TokenPage` no longer read any address from the subgraph; `lib/address.ts` parses route params case-insensitively (viem's strict EIP-55 check was rejecting valid addresses). Multicall3 declared on both chains. **Validated by stopping graph-node against the live testnet**: swap page still resolved pool `0xDC27…E933` and rendered the panel, with "Charts unavailable / Trading is unaffected"; token page kept its trade panel with three individually-labelled degraded panels; WETH9 correctly rejected as not-a-launch; everything recovered on restart. 79 frontend tests green.

**#20/#21 shape (Builds 09/10 — frontend):** Custom React + Vite + TS SPA in `frontend/` (spec decision #8 — **not** a `Uniswap/interface` fork). wagmi/viem (injected connector only), react-query with ~5s live polling, graphql-request against the #19 subgraph, recharts. **#20:** create-token form (`createLaunch(name, symbol, metadataURI)`; the URI goes on-chain and is permanent, "bring your own URI" for v1 — the local image field is now only a preview), live curve view (chart + progress from subgraph, buy/sell quoted on-chain via `quoteBuy`/`quoteSell`, anti-snipe cap from cumulative `purchasedOf`), transparent creator/holder positions. **#21:** "just graduated" feed + live-curves browse, and a swap page (`/swap/:address`) trading graduated pools through the platform's **own v3-periphery `SwapRouter`** — ETH→TOKEN via payable `exactInputSingle`, TOKEN→ETH via `multicall([exactInputSingle → router, unwrapWETH9 → user])`; output now comes from our own `QuoterV2` (exact, incl. fee + price impact) with on-chain `amountOutMinimum` protection, falling back to a labelled `slot0` spot estimate when `VITE_QUOTER_ADDRESS` is unset. **43 unit tests green** (`cd frontend && npm test`), `tsc -b` + `vite build` clean. Env-driven addresses (`VITE_FACTORY_ADDRESS` / `VITE_SWAP_ROUTER_ADDRESS` / `VITE_SUBGRAPH_URL`); runs in preview mode with a banner until set. Both reviews applied per ticket. Bundle is ~868 kB (wagmi pulls unused WalletConnect/MetaMask SDK — a `manualChunks`/trim follow-up); token metadata is now on-chain and global (#24); what remains for Stage 3 is the READ side — an IPFS gateway choice, a fallback avatar for unpinned URIs, and a moderation denylist.

**#19 shape (Build 08 — subgraph):** The Graph subgraph in `subgraph/` (graph-node toolchain) indexing `eip155:4663`. Sources: `LaunchpadFactory.LaunchCreated` (fixed addr) → `Token` + spawns a **`BondingCurve` data-source template** per launch (curve addresses are runtime-discovered; token address passed via data-source context); `BondingCurve.Bought/Sold/Graduation` (template) → `Trade`/`Holder`/curve-progress; `GraduationManager.Graduated` (fixed addr) → the `Graduation` feed. Entities: `Factory` (rollups), `Token` (curve progress: reserves, tokensSold, priceX18, progressBps; plus `metadataURI` and the six frozen curve params from #24), `Trade` (immutable buy/sell log), `Holder` (netted on-curve position), `Graduation` (just-graduated feed). All derived from events, **no eth_calls** (since #24 even `curveTokenAllocation` arrives in `LaunchCreated`, so no Solidity constant is copied into the mappings) → deterministic + matchstick-testable. **13 matchstick tests green** (`cd subgraph && npm test`; needs `libpq` on macOS — see `subgraph/README.md`). Both reviews applied: fixed a `volumeEth` overcount on the graduation-crossing buy (was counting the refunded ETH). **Not deployed** — self-hosted graph-node (chain 4663 isn't on The Graph's hosted/decentralized nets); manifest carries placeholder addresses pending #18 deploy keys, filled via `networks.json` (`graph build --network robinhood`). v1 holders are curve-position-only; secondary ERC-20 transfers are a documented follow-up.

**#18 shape:** `LaunchpadFactory` is now `Ownable2Step` (two-step handoff to a Safe multisig — a mistyped owner can't brick control). Added guarded `setCurveParams` (virtualEthReserve / tradeFeeBps ≤10% / maxBuyPerWallet / antiSnipeThreshold ≤800M), future-only; `virtualTokenReserve` stays calibration-locked so graduation price continuity (#16) holds for any V_eth. Full deploy pipeline in `contracts/script/DeployLaunchpad.s.sol` + runbook `docs/deploy.md` (testnet 46630 → mainnet 4663, Blockscout verify). Real on-chain broadcast + Blockscout verification need deploy keys (not available in-session); delivered as production scripts + runbook, validated via fork dry-run + a fork test mirroring the ownership choreography.

**Optional low-severity test gaps left on #17** (flagged in review, non-blocking): negative-owner tests for `setProtocolFee`/`setPoolProtocolFee`; an explicit `NPM.burn` reverts assertion; a `ProtocolFeeSkipped`-path test.
