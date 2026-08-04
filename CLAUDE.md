# Octopus

**Octopus** is a DEX + bonding-curve launchpad on **Robinhood Chain** (chainID 4663, testnet 46630).
Projects launch on a pump.fun-style bonding curve and graduate atomically into a locked, full-range `TOKEN/WETH` V3 pool.

This file is an **index and a set of warnings**, not a mirror of `docs/`.
Everything here links to where the detail actually lives. Do not restate those docs back into this file.

> **Naming.** "Octopus" is the product brand. The AMM is **unmodified Uniswap V3** ([ADR-0001](docs/adr/0001-unmodified-uniswap-v3-from-audited-artifacts.md)).
> Rebrand product surfaces freely, but **never** rename or strip `@uniswap/v3-core`/`v3-periphery` deps, `IUniswapV3Factory`/`IUniswapV3Pool`, artifact paths in `V3Deployer.sol`, or `GPL-2.0-or-later` SPDX headers - those name real upstream software and carry licence obligations.
> Also unchanged: deployed contract names (`LaunchpadFactory`, `GraduationManager`, `LPLock`), the subgraph `Factory` entity id (`"launchpad"`), and the repo/remote name `uniswap-v3` (cosmetic, deferred).

## Where things are

| | |
| --- | --- |
| Domain model, 3 contexts, ADR index | [`CONTEXT-MAP.md`](CONTEXT-MAP.md) - **read before renaming anything**; the contexts deliberately do not share a language |
| ⚠️ **Tokenomics spec** (the current job) | [`docs/tokenomics.md`](docs/tokenomics.md) - this is a SPEC, not a description of the deployed system |
| Testnet addresses, tx hashes, seeding | [`docs/deployments-testnet.md`](docs/deployments-testnet.md) |
| RPC capability measurements | [`docs/rpc-capability.md`](docs/rpc-capability.md) |
| Managed-host + create-flow probe | [`docs/de-risking-probe.md`](docs/de-risking-probe.md) |
| Auditor hand-off brief | [`docs/audit-scope.md`](docs/audit-scope.md) |
| Deploy runbook | [`docs/deploy.md`](docs/deploy.md) |
| Driving a real MetaMask from `agent-browser` | [`docs/metamask-agent-browser.md`](docs/metamask-agent-browser.md) - untracked; needed to test the wallet-connected UI |
| Indexer runbook, reorg recovery | [`subgraph/README.md`](subgraph/README.md) |
| Issue tracker / triage / domain workflow | [`docs/agents/`](docs/agents/) |

Architecture decisions are GitHub issue [#1](https://github.com/imDev2023/uniswap-v3/issues/1) (`wayfinder:map`) plus [`docs/adr/`](docs/adr/).

## Ticket rhythm

One ticket per branch, `build/<NN>-<slug>`, branched from `main`.
Implement plus tests at the fork-test seam, keep the suite green, run `/code-review` (two axes) against `main`, apply findings, merge.
Builds #12-#34 are merged; #26-#29 were scoped in-session and have no issues of their own.

## Current state

🔴 **Contracts are NOT frozen** (ended 2026-08-02, deliberately) and 🔴 **the deployed ones no longer match [`docs/tokenomics.md`](docs/tokenomics.md).**
The pre-tokenomics build is done and validated on testnet 46630; Stages 3 and 4 have the open items listed below.

**Suites** (verify, do not trust): `forge test`, `cd subgraph && npm test`, `cd frontend && npm test` plus `tsc -b` and `vite build`.

## Testnet 46630

Everything (addresses, launch table, calibration, restore commands) is in [`docs/deployments-testnet.md`](docs/deployments-testnet.md).

⚠️ **It is all about to become historical.** #38 moves every address and the subgraph `startBlock`, needs all **four** contracts re-verified on Blockscout (#35 added `DevVesting`, deployed by the factory's constructor like `LPLock` and `GraduationManager`), and re-seeds the board. Plan for it; do not discover it.
⚠️ **Only `CALIB` sits on the current 1 ETH calibration**; the other 16 froze at 0.1 ETH because `setCurveParams` is future-only, and six older launches are on a superseded factory.


---

# 🔴 THE ACTIVE JOB: the tokenomics build program

Agreed 2026-08-02. Spec is [`docs/tokenomics.md`](docs/tokenomics.md); the two property changes it forced are [ADR-0005](docs/adr/0005-the-lp-lock-is-conditional-not-permanent.md) (the lock is conditional) and [ADR-0006](docs/adr/0006-the-curve-allocation-is-per-launch.md) (the curve allocation is per launch, and it is a pre-mine).
**Read the spec before touching any of this. Do not re-derive it and do not re-open the settled decisions.**

Six tickets, **on top of** the remaining pre-tokenomics work below. Three done.

| Ticket | Scope | State |
| --- | --- | --- |
| `build/33-lplock-lock-records` | see [ADR-0005](docs/adr/0005-the-lp-lock-is-conditional-not-permanent.md) | ✅ merged (`8e9af94`) |
| `build/34-curve-carve` | see [ADR-0006](docs/adr/0006-the-curve-allocation-is-per-launch.md) | ✅ merged (`f000969`) |
| `build/35-dev-vesting` | see [ADR-0007](docs/adr/0007-vesting-runs-from-graduation.md) | ⬅️ **built, UNCOMMITTED, not yet reviewed** |
| `build/36-launchconfig-subgraph` | New `LaunchConfig` event, schema, mappings, matchstick | not started |
| `build/37-frontend-lock-vesting` | Create form (dev %, lock choice), token page (lock/vesting/reclaim state) | not started |
| `build/38-testnet-redeploy` | Fork tests, full redeploy, Blockscout re-verify, re-seed | not started |

**Governing principle: every new number is owner-tunable and FUTURE-ONLY**, so testnet feedback retunes the platform with a transaction rather than a redeploy, and no in-flight launch ever changes under a trader.

### Settled, do not re-litigate

Full reasoning is in [`docs/tokenomics.md`](docs/tokenomics.md#settled-decisions). Outcomes only:

1. **Creator fee share: 70% of the graduated pool's LP share**, 30% treasury. Curve trade fee and the 0.25% pool protocol fee stay 100% protocol. ⚠️ Revised 2026-08-02; reverses the original "no creator fee share".
2. **Dev allocation** free, 0-5% of curve supply, creator-selected, vested linearly from graduation over 30 days (owner-tunable, `[30d, 4y]`). A pre-mine; retires the "no pre-mine" claim.
3. **LP lock 1 year default**, creator may extend (monotonic), permanent selectable at creation.
4. **`reclaim` permissionless**, requires expired AND no pool activity for >= 180 days. Tokens burned, WETH to treasury. Donation is off-chain with published proof, never an on-chain charity address.
5. **Zero protocol token allocation.**
6. **Anti-snipe levels unchanged**, retune from testnet feedback. ⚠️ It did NOT survive as "no contract change": #34 had to rescale both params onto each launch's own `C`. See amendment 4.
7. **Target 10 ETH mainnet / 1 ETH testnet**, via route (A). Both shipped in #34.
8. **Reclaim inactivity period is monotonic** (lengthen only).

### Constraints that must survive into the tickets

- ⚠️ **Do NOT widen `LaunchCreated`.** It already carries 12 fields and `_emitLaunchCreated` exists *purely* because inlining it overflows the EVM's 16-slot reachable stack (`viaIR` was rejected as too disruptive). Emit a second `LaunchConfig` event instead.
- ⚠️ **Beware the same-block dynamic data source.** Anything the factory triggers on the curve inside the creation tx fires before the `BondingCurve` template exists as an indexed source. graph-node 0.40.2's behaviour is **unverified** and we have no evidence on our own chain, because `SeedTestnet.s.sol` uses `--slow`. **Emit anything that matters from the FACTORY**, which is fixed-address and always indexing.
- ⚠️ **`reclaim` must be structurally impossible for third-party positions.** A public LP-locking service for arbitrary pairs is on the roadmap, which would make `LPLock` a custodian of strangers' assets.
- ⚠️ **`maxBuyPerWallet` is a share of tokens, not ETH**, so the 90→10 ETH move made the same 1% cap cost ~9x less. The sniping barrier fell by that factor and nothing has been decided about it. Open question for the testnet retune, with #34's rescale, in [`docs/tokenomics.md`](docs/tokenomics.md#amendments-made-during-implementation) amendment 4.

---

# Remaining pre-tokenomics work

Estimates and confidence in [`docs/de-risking-probe.md`](docs/de-risking-probe.md). ~9-9.5 tickets, several invalidated by the mandatory redeploy.

**Stage 3 (frontend), still open:** create-flow URI validation (🔴 the field writes permanently with **no validation at all** - `ipfs//…`, free text, `javascript:`, whitespace all pass, and the read side silently ignores every one of them); name `maxLength={40}` vs validation rejecting `>32`; **no search, no pagination, no address lookup** past `BOARD_PAGE_SIZE = 50`; ⚠️ **injected-only wallets, so mobile cannot connect at all**; "Holders" → **Curve Position** relabel (decided, not built).

**Stage 4 (infra), still open:** frontend hosting; monitoring wiring (`scripts/indexer-health.mjs` exists, nothing runs it); 🔴 **key protection - the RPC key ships verbatim in the browser bundle**, so domain allowlisting or a proxy is required before any public deploy; Stage-2 RPC fallbacks for the homepage list and curve progress; Blockscout verification of the V3 stack + QuoterV2.

**Also before mainnet:** production-scale graduation has never run on live testnet (now ~1 test ETH, no longer blocked); adversarial MEV is untested and nothing is scoped.

🔴 **THE AUDIT COMES LAST, after the project is complete and the user has tested it himself. Do not ask about it, do not propose starting it, and never propose vendors.** It is a favour from the user's Solidity-developer friends and he will raise it when ready.

**Lead-time items on the user's clock** - remind, do not chase: the real multisig for `SAFE`, the root `LICENSE` choice, and "Octopus" trademark clearance.

---

# Open decisions - ask, never assume

- **Commit, merge and push.** `#35` is built but UNCOMMITTED and unreviewed. `main` is 7 ahead of `origin/main`; nothing has been pushed this whole program. Each is a per-request action, not standing permission.
- **The 30-day vesting default is the shortest the contract allows**, so a 5% allocation is fully liquid a month after graduation (~-30.6% if dumped whole). Chosen 2026-08-04; flagged as a testnet-retune candidate, not as settled.
- **Two security items raised in #34 and deliberately not actioned**: `pragma solidity ^0.8.24` floats repo-wide (Consensys says lock it; changing it moves bytecode, so do it before #38's redeploy or not at all), and `createLaunch` has no reentrancy guard despite refunding via `.call` (CEI holds and re-entry just buys another launch, so it was judged gas for no threat).
- **Goldsky migration** is measured and proven but **not done** - a one-line `VITE_SUBGRAPH_URL` change. `octopus-probe/1.0.0` is live on the free tier: keep or delete?
- **Alchemy paid tier?** The free tier's 10-block `eth_getLogs` cap is the only thing stopping one provider serving everything.
- ⚠️ **[`docs/rpc-capability.md`](docs/rpc-capability.md) carries two numbers that later re-runs contradicted** (the 5,000-block consistent-depth figure, and `eth_getBlockReceipts` availability). Recording the correction was **declined once**. Re-offer; never silently fix.
- **`QuoterV2.t.sol`'s `V3_FACTORY = 0x808088B7…`** appears nowhere in `docs/deployments-testnet.md` while claiming to run against "the genuinely deployed stack". Pre-existing and passing.
- **Em-dash sweep** of existing repo prose: available on request, deliberately not done. New text uses plain hyphens.
- **`lib/priceSeries.ts` documents one honesty limit deliberately UNFIXED**: resampling keeps the last price per bucket, so a fully-reversing move leaves no trace.

# 🔭 Out of scope right now

Public LP locking for arbitrary pairs, lending and borrowing, a general DEX surface, loans.
The user has said the project will get much bigger; the current focus is the exchange and launchpad only.

---

# ⚠️ Traps

Hard-won, mostly discovered by running something rather than reasoning about it. Each one produced a confidently wrong result first.

**Tests that pass for the wrong reason**

- **A wrong-selector call reverts exactly like an authorization failure.** `IUniswapV3Minimal` declared `decreaseLiquidity` with flat args where the real NPM takes a struct - all members static, so the calldata body is identical and only the 4-byte selector differs. `LpLock.t.sol` asserted "an attacker cannot withdraw principal" with a bare `vm.expectRevert()` and caught the selector miss instead, **for six builds**. Pin reverts to a specific error or message; a bare `expectRevert` proves almost nothing.
- **`assertGt(x, 0)` cannot see a diversion.** Diverting 70% of fees to a new address left the old test green, because the 30% remainder still satisfied it.
- **`vm.prank` and `vm.expectRevert` apply to the NEXT call**, and a getter like `factory.MAX_LOCK_DURATION()` inline in the arguments *is* that next call. Hoist reads before the cheatcode. Hit twice in one file, after writing a comment warning about it.
- **A revert-only test does not prove a bound is safe.** Test that the value AT the ceiling still works, or a clamp that bricks the product passes review.
- **A test where the caller IS the beneficiary cannot see a misrouted payout.** Every #35 vesting test that claimed *as* the creator stayed green when `claim` was mutated to pay `msg.sender`; only the one that claims from a stranger caught it. Whenever a function's destination is fixed rather than a parameter, call it from somebody who is not that destination.

- **A test buy sized in ETH is coupled to the calibration.** Nine graduation tests opened with a hardcoded `buy{value: 0.15 ether}` per filler wallet, which sat under the 8M anti-snipe cap at 90 ETH and blew through it at 10 ETH - the same ETH buys ~9x the tokens. `test/CurveDriver.sol` now derives the size from the curve's own cap and reserves. Nobody thinks of a literal in a test setup as a test input.
- ⚠️ **Editing the spec so it describes what you built is not a fix, it is a lost constraint.** #34 changed six things in `docs/tokenomics.md` and declared two. A code review caught it. Every implementation-time change to the spec now goes in its "Amendments made during implementation" table, marked in-scope or not, so it can be reverted deliberately.
- **A number in a doc has no way to fail.** Four `virtualTokenReserve` values in the `docs/tokenomics.md` table were wrong when written, because they were reasoned out rather than computed. `Calibration.t.sol` now pins the whole published table against the contract.

**Calibration**

- ⚠️ **A value that has always been constant is the one you forget is a variable.** `V_tok = C^2/(C - G)` depends on the curve allocation, so it stopped being a constant the moment #34 carved `C` - yet the ticket scope named only `V_eth`. Pinned at 800M while `C` carves to 760M, the pool opens **9.25% above** the curve's close. `Calibration.t.sol` pins the failure mode.
- **A clamp can reproduce the exact state it was meant to prevent.** `buyCapActive()` is `tokensSold < antiSnipeThreshold` and sellout is `tokensSold == C`, so clamping an unreachable threshold to `C` still never lifts the cap. Rescaling by `C / CURVE_SUPPLY` was the fix; `setCurveParams` now also rejects a threshold *equal to* `CURVE_SUPPLY`.

**Enums, defaults and zero**

- **Reserve the enum's zero slot for `None`.** Every field of an unregistered key reads as zero, so a status enum whose first member is the privileged one silently grants that status to everything that was never registered.

**Uniswap V3 specifics**

- **`increaseObservationCardinalityNext` is permissionless on any pool.** A hardcoded `observations(0)` latches onto a stale timestamp once a stranger grows the ring. Always read `slot0().observationIndex`.
- **Observation timestamps are `uint32` and wrap ~every 136 years**; the pool's own comparisons are overflow-safe. Subtract in `unchecked` uint32 arithmetic. Mints and burns also write an observation, so dust counts as activity.
- **The locked LP is not a treasury holding the raise. It is the counterparty to every trade.** A fully-exited pool holds ~2 ETH, not 10 - which is why any time-only unlock right is worth ~5x more when abused than when used as intended.
- ⚠️ **WETH9 is per-chain.** `Constants.WETH9` is mainnet-only and has no code on 46630. Always pass `WETH9=` explicitly to `DeployLaunchpad.s.sol`.

**Indexer honesty**

- **`synced` is a sticky Postgres column that can never go false.** `health` only reflects mapping errors and `fatalError` only fires for *deterministic* ones, so all three read green during total failure. Measure lag against the chain's own `eth_blockNumber`.
- **graph-node returns `_meta.block.timestamp: null`** while `number` and `hash` populate - which once made the entire degradation system inert. Read the timestamp from RPC by number.
- **A lagging indexer does not error, it returns an empty array.** Check indexer health on the empty branch, not just the error branch, or "no rows" silently becomes "nobody has traded".
- **`indexingStatuses` with no arguments returns an empty array** on 0.40.2 even while actively indexing; use `indexingStatusesForSubgraphName`.
- **graph-node cannot self-heal from a reorg deadlock** and `graphman chain check-blocks` does not repair it. Purging the poisoned block cache is mandatory before `graphman rewind`. Runbook in [`subgraph/README.md`](subgraph/README.md); detect with `scripts/indexer-health.mjs`.
- **Alert in seconds, never in blocks.** At 0.1 s blocks the same wall-clock lag reads ~3x larger.

**Measuring RPC endpoints**

- **`eth_getBalance` returns `0x0` with no error on unreadable state**, so it reports a pruned node as a full archive. Use `eth_call`.
- **A single sample cannot measure a load-balanced endpoint.** Report a rate, not a threshold.
- **A cap refusal proves logs EXIST at that depth**; counting it as pruning inverts its meaning. And a sampling window too small to contain a log manufactures the appearance of absence.
- **A measurement tool carrying fixed advice will eventually give wrong advice with the authority of a measurement.** Derive the advice from the reading.
- **A tool is safe or unsafe relative to what you point it at**, so changing its inputs is a change to it. `scripts/rpc-probe.mjs` masks endpoints; other tools do not.
- ⚠️ **Repeated back-to-back probe runs trip the official limiter**, after which adaptive pacing ratchets and a 2-minute run silently takes an hour. Space runs out.

**Frontend**

- **Five defects in #29 and four in the de-risking probe were found by watching the running app**, not by tests - including a chart that silently never painted (no error; the canvas just stayed at its default size) and a first-load flash of 23 fake "arrivals". Load the page.
- **Sorting a paged list client-side ranks only the current page.** The board's "closest to graduation" could never surface a curve outside the newest 50.
- **Measure a bundle by sourcemap attribution, not by hypothesis.** The long-assumed WalletConnect bloat was absent; the real cost was `graphql` at 142 kB, pulled in to read an operation name off a parsed AST that was then discarded.
- **viem's `isAddress` is strict about EIP-55 casing.** Parse route params case-insensitively; `curveOf(token) != 0` is what actually guards safety.

**Fork tests**

- **Every fork test is PINNED and forks from an archive endpoint** (`contracts/test/ForkConfig.sol`, aliases `robinhood_archive` / `robinhood_testnet_archive`, reading `RPC_*_ARCHIVE_URL` from `contracts/.env`). Missing vars fail loudly rather than falling back to a pruning endpoint - which is how flakiness got in. Four suites had been forking at `latest` and re-fetching live state every run.
- **The optimizer is on** (200 runs) as of #24, which took `LaunchpadFactory` under EIP-170. Build settings are part of what auditors review and what Blockscout verification must match.

---

# Setup

```bash
export PATH="$HOME/.foundry/bin:$PATH"
cd contracts && forge test        # fork tests need RPC_*_ARCHIVE_URL in contracts/.env (already there)
cd frontend  && npm test          # no services needed
cd subgraph  && npm test          # matchstick; needs libpq on macOS
node scripts/rpc-probe.mjs --self-test        # offline, no deps
node scripts/indexer-health.mjs --self-test   # offline, no deps
```

**The indexer is STOPPED between sessions.** Bring it up only to use it:

```bash
cd subgraph/docker && docker compose up -d    # resumes, no re-sync; give it ~60s
cd subgraph/docker && docker compose down     # never -v, it would destroy the volumes
```

Query endpoint `http://localhost:8100/subgraphs/name/octopus/octopus` (both path segments; host ports are remapped into the 81xx range to avoid collisions, status 8130, admin 8120).
⚠️ Docker holds ~8 GB of the user's RAM, but **most of it is a separate `localai`/`n8n`/`open-webui`/`qdrant` stack**. Do not stop those and do not quit Docker Desktop without asking.

# Hard constraints

- **Ask before committing, merging, or pushing.** None of these is standing permission.
- **Do not deploy to mainnet 4663.** Testnet deploys, seeding and launches are fine.
- **Never print, echo or commit anything from `contracts/.env`.** Mask by hand where a tool does not: `sed -E 's#(/v2/)[A-Za-z0-9_-]+#\1<key>#g'`.
- **No em dashes in new text**, and no agent attribution in commit messages.
- Contract changes are scoped to the settled program above. Anything beyond it: ask.
