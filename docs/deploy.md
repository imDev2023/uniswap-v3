# Deploy runbook

The production pipeline for the launchpad plus our own Uniswap V3 stack on Robinhood Chain.
**Testnet first (46630), then mainnet (4663).**
Ownership lands under a Safe multisig on mainnet; four contracts verify on Blockscout.

Script: [`contracts/script/DeployLaunchpad.s.sol`](../contracts/script/DeployLaunchpad.s.sol).
Last exercised end to end: **build #38**, testnet 46630, 2026-08-06.
The addresses and receipts that run produced are in [`docs/deployments-testnet.md`](./deployments-testnet.md); this file is the procedure, that one is the record.

> ⚠️ **A deploy is not finished when the script succeeds.**
> It is finished when four contracts are verified, `networks.json` carries four addresses, the subgraph has re-indexed and the app has been loaded against the result.
> Steps 4 to 7 are not optional follow-up, they are the deploy.

## What the script does (one broadcast)

1. Deploys the platform's **own, unmodified** Uniswap V3 factory + SwapRouter + NonfungiblePositionManager, byte-for-byte from the audited release via `vm.getCode` ([ADR-0001](./adr/0001-unmodified-uniswap-v3-from-audited-artifacts.md)).
2. Deploys `LaunchpadFactory` wired to that V3 factory + position manager, with the **broadcaster** as initial owner.
   Its constructor creates **three more contracts**: `LPLock`, then `GraduationManager`, then `DevVesting`.
   They are `CREATE`d from inside the constructor, so they never appear in the broadcast file the way a direct deploy does - the script `console2.log`s all three so you do not have to dig them out.
3. `setOwner(launchpad)` on the V3 factory, handing the protocol fee switch to the launchpad so `applyProtocolFee` works at graduation.
4. `launchpad.transferOwnership(SAFE)`, starting the **`Ownable2Step`** handoff.
   Ownership does **not** move until the new owner calls `acceptOwnership()`, so a mistyped `SAFE` can never brick the launchpad.

**Four contracts come out of this, not two.** `DevVesting` arrived in #35 and is the one every earlier version of this runbook forgot.

## Prerequisites

```bash
export PATH="$HOME/.foundry/bin:$PATH"
cd contracts && set -a && . ./.env && set +a

# Required
export SAFE=0x...                        # the address that will own the launchpad
# Optional (sensible defaults)
export TREASURY=0x...                    # fee sink; defaults to $SAFE
export CREATION_FEE=10000000000000000    # 0.01 ETH in wei (default)

# ⚠️ WETH9 IS PER-CHAIN and the script's default is MAINNET-ONLY.
#    Constants.WETH9 has no code on 46630. Always pass it explicitly on testnet.
export WETH9=0x7943e237c7F95DA44E0301572D358911207852Fa   # 46630
```

⚠️ **`SAFE` on testnet is deliberately the deployer EOA** (`0x8Ec5f1e0…9A80C`), decided 2026-08-05.
A real multisig would hold the whole ticket open waiting for an external `acceptOwnership()` before any owner-only setter could run, and the calibration in step 3 gates the re-seed which gates the acceptance test.
**On mainnet `SAFE` is the real multisig** and the handoff is a genuine multisig transaction.

Blockscout verification needs **all three** of these exported, even for a testnet-only deploy - `forge` reads the whole `[etherscan]` table in `foundry.toml` and errors on the unused mainnet entry if it is unset:

```bash
export BLOCKSCOUT_API_KEY=verifyContract        # keyless; the value is an ignored placeholder
export BLOCKSCOUT_TESTNET_API=https://explorer.testnet.chain.robinhood.com/api
export BLOCKSCOUT_MAINNET_API=https://robinhoodchain.blockscout.com/api
```

## 1. Fork tests, then a dry run

```bash
cd contracts && forge test        # 185 tests. Fork tests are PINNED and use the archive endpoint.
```

⚠️ The archive endpoint rate-limits.
Back-to-back full runs can fail with `vm.deal: failed to get account ... 429`; that is not a test failure, wait ~3 minutes.

```bash
EXPECTED_CHAIN_ID=46630 forge script script/DeployLaunchpad.s.sol --fork-url robinhood_testnet
```

The dry run executes against **real chain state** and needs no keys.
It prints every address the real run will produce and the gas estimate (~0.00055 ETH for the whole pipeline).

## 2. Broadcast

```bash
EXPECTED_CHAIN_ID=46630 forge script script/DeployLaunchpad.s.sol \
  --rpc-url robinhood_testnet --broadcast --non-interactive --private-key $PRIVATE_KEY
```

- `EXPECTED_CHAIN_ID` makes the script revert if pointed at the wrong chain. **Set it on every broadcast.** A mistyped RPC must fail loudly rather than deploy somewhere else.
- `--non-interactive` is **required**: `LaunchpadFactory` is large enough that forge otherwise opens a TTY confirmation prompt, which fails with `IO error: not a terminal` in a non-TTY shell. Robinhood Chain is an Arbitrum Orbit chain with a raised code-size limit, so the deploy succeeds.

Then finalize the handoff and re-apply the testnet calibration:

```bash
cast send $LAUNCHPAD "acceptOwnership()" --rpc-url robinhood_testnet --private-key $PRIVATE_KEY

cast call $LAUNCHPAD "owner()(address)"        --rpc-url robinhood_testnet   # == $SAFE
cast call $LAUNCHPAD "pendingOwner()(address)" --rpc-url robinhood_testnet   # == 0x0
```

On **mainnet** the Safe executes `acceptOwnership()` as a multisig transaction; until it does, the deployer remains owner.

## 3. Calibration - and what does NOT need setting

A fresh deploy already lands on the **spec** values for everything the tokenomics program added, so do not "restore" them:

| Read back after deploy | Value | Set by |
| --- | --- | --- |
| `maxDevAllocationBps()` | `500` (5%) | constant, no call needed |
| `defaultLockDuration()` | `31536000` (365 days) | constant, no call needed |
| `vestingDuration()` | `2592000` (30 days) | constant, no call needed |
| `creatorFeeBps()` | `7000` (70%) | constant, no call needed |

**`setLockParams` and `setMaxDevAllocationBps` are therefore NOT part of a deploy.** They exist to retune later.

The one thing that does need setting on testnet is the graduation target, because the code default is the **10 ETH mainnet** figure:

```bash
# Values PINNED by contracts/test/Calibration.t.sol against the contract - use these, do not derive:
#   0.1 ETH ->   33333333333333333
#     1 ETH ->  333333333333333333   <- current testnet
#    10 ETH -> 3333333333333333333   <- mainnet target, and the code default
cast send $LAUNCHPAD "setCurveParams(uint256,uint16,uint256,uint256)" \
  333333333333333333 100 8000000000000000000000000 0 \
  --rpc-url robinhood_testnet --private-key $PRIVATE_KEY
```

⚠️ **Do not size a new target as `target / 3`.**
That identity is an approximation and is off by a wei for most targets; the true amount is
`ceilDiv(V_eth × V_tok, V_tok - C) - V_eth`, and the counter-intuitive consequence is that the
*repeating-decimal* targets are the exact ones. 0.1, 1 and 10 ETH all land exactly, which is why they
are the three chosen; a "rounder" 1.5 or 12 ETH lands a wei out. The full table is in
[`docs/tokenomics.md`](./tokenomics.md), and `Calibration.t.sol` pins it against the contract.

The trailing `0` is `antiSnipeThreshold`, and switching the cap **off** is deliberate on testnet: at a 1 ETH target the production 8M-per-wallet cap lets one wallet contribute ~0.0025 ETH, so a solo graduation would need hundreds of wallets.
Mainnet keeps the armed default.

⚠️ `setCurveParams` is **future-only**. Every launch created before the call keeps the calibration it froze at `createLaunch`, which is what lets one board legitimately carry launches at two different targets - see step 6.

## 4. Verify FOUR contracts on Blockscout

Not two, not three.
`LPLock`, `GraduationManager` and `DevVesting` are created by the factory's constructor, so `--guess-constructor-args` refuses them ("not supported for contracts created by contracts"): pass the args explicitly.
Optimizer **on at 200 runs**, pragma pinned **0.8.24** since #35a - verification must match both exactly, and both are properties of the build an auditor reviews.

```bash
LP=<LaunchpadFactory>  NPM=<NonfungiblePositionManager>  V3F=<UniswapV3Factory>
GM=<GraduationManager> LOCK=<LPLock>  DV=<DevVesting>  W9=$WETH9  DEP=<deployer>

forge verify-contract $LP src/LaunchpadFactory.sol:LaunchpadFactory \
  --chain 46630 --verifier blockscout --verifier-url "$BLOCKSCOUT_TESTNET_API" \
  --constructor-args $(cast abi-encode "constructor(address,address,uint256,address,address,address)" \
    $DEP $DEP 10000000000000000 $NPM $V3F $W9) --watch

forge verify-contract $LOCK src/periphery/LPLock.sol:LPLock \
  --chain 46630 --verifier blockscout --verifier-url "$BLOCKSCOUT_TESTNET_API" \
  --constructor-args $(cast abi-encode "constructor(address,address)" $NPM $LP) --watch

forge verify-contract $GM src/periphery/GraduationManager.sol:GraduationManager \
  --chain 46630 --verifier blockscout --verifier-url "$BLOCKSCOUT_TESTNET_API" \
  --constructor-args $(cast abi-encode "constructor(address,address,address,address)" \
    $LP $NPM $W9 $LOCK) --watch

forge verify-contract $DV src/periphery/DevVesting.sol:DevVesting \
  --chain 46630 --verifier blockscout --verifier-url "$BLOCKSCOUT_TESTNET_API" \
  --constructor-args $(cast abi-encode "constructor(address,address)" $LP $GM) --watch
```

⚠️ The factory's **first constructor argument is the deployer, not `SAFE`**: the launchpad is deployed owned by the broadcaster and only then transferred. Passing `SAFE` here fails verification with no useful message.

Confirm independently rather than trusting the CLI's "successfully verified":

```bash
curl -s "https://explorer.testnet.chain.robinhood.com/api/v2/addresses/<addr>" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['is_verified'])"
```

The V3 stack (factory / router / position manager / QuoterV2) is **not** verified by this procedure - it is deployed from upstream artifacts via `vm.getCode`, so there is no in-repo Solidity for `forge verify-contract` to compile. Tracked as its own Stage-4 item.

## 5. Point the subgraph at the new deployment

`subgraph/networks.json` needs **four addresses and four `startBlock`s**.
All four launchpad contracts are created in the same transaction, so they share one `startBlock`: the block of the `LaunchpadFactory` deploy, which you can read out of `broadcast/DeployLaunchpad.s.sol/46630/run-latest.json`.

🔴 **`DevVesting` was `0x0` in `networks.json` from #36 until #38.**
A zero-address data source does **not** error - it indexes nothing - so the vesting panel reads empty and looks exactly like "this launch has no carve". Fill all four.

```bash
cd subgraph/docker && docker compose up -d && cd ..
npm run codegen
npx graph build --network robinhood-testnet    # stamps addresses from networks.json
npx graph create --node http://localhost:8120/ octopus/octopus
npx graph deploy --node http://localhost:8120/ --ipfs http://localhost:5001 \
  --version-label vX.Y.Z octopus/octopus
git checkout -- subgraph.yaml                  # AFTER deploy - the build rewrote the tracked manifest
```

Order matters: `graph deploy` re-reads the root `subgraph.yaml`, so restoring it first would ship the placeholder zero-addresses.

Measure sync against the **chain's own** `eth_blockNumber`, never the `synced` column - it is a sticky Postgres flag that can never go false, and `health` only reflects mapping errors.
Full runbook and the reorg-deadlock recovery are in [`subgraph/README.md`](../subgraph/README.md).

## 6. Re-seed the board

```bash
export LAUNCHPAD=<new factory>
forge script script/SeedTestnet.s.sol:SeedTestnet --sig 'run()' \
  --rpc-url robinhood_testnet --broadcast --slow --non-interactive

# then re-calibrate (step 3) and:
export SHOWCASE_PK=<a throwaway key, NOT one from contracts/.env>
forge script script/SeedTestnet.s.sol:SeedTestnet --sig 'showcase()' \
  --rpc-url robinhood_testnet --broadcast --slow --non-interactive
```

- ⚠️ **Never remove `--slow`.** It is what keeps creates and buys in separate blocks, and it is why we still have no evidence about graph-node 0.40.2 and same-block dynamic data sources.
- ⚠️ **Fund the wallets first, and generously.** `forge script` simulates the entire script before broadcasting **anything**, so an under-funded wallet fails the whole run at simulation time with `OutOfFunds` and writes nothing. That is a safe failure, not a partial board - but it costs a full re-run.
- ⚠️ **`run()` alone leaves the tokenomics UI unexercised.** Its board is all zero-carve, default-lock launches, so the lock card, the vesting card and the concentration figure all render their EMPTY states - which is indistinguishable from broken. `showcase()` creates the carved, permanently-locked and carved-and-graduated launches that the acceptance test actually needs.
- The cheap board and the realistic launches can sit on **different calibrations**, because `setCurveParams` is future-only. Rebuilding the whole board at a 1 ETH target costs ~3.6 ETH; seeding it at 0.1 ETH and only the showcase at 1 ETH costs ~1.5 ETH and exercises both scales.
- `SHOWCASE_PK` is deliberately a throwaway: the acceptance test imports the creator's key into a real MetaMask, and **no key that lives in `contracts/.env` may ever be typed into a browser session.**

## 7. 🔴 The acceptance test - load the app

The redeploy mechanics passing is not the deploy working.
Point `frontend/.env.local` at the new `VITE_FACTORY_ADDRESS`, `VITE_GRADUATION_MANAGER_ADDRESS`, `VITE_SWAP_ROUTER_ADDRESS` and `VITE_QUOTER_ADDRESS` (the quoter is a separate script, `DeployQuoter.s.sol`, and must be re-pointed at the new V3 factory), then load the running app and confirm it says **true** things:

- the create form reads its bounds from the new factory (max carve 5.00%, 1 year default lock, 70%);
- a carved launch reports concentration against **its own** curve allocation, not the 800M constant;
- an ungraduated carved launch says the schedule has **not started**, never "100% vested";
- the lock card names the reclaim **blocker** ("Lock has not expired"), and says "of the locked position's fees", never "of pool fees";
- a graduated launch's curve positions are labelled **Final**;
- 🔴 **stop graph-node and reload a graduated launch.** Its vesting schedule must still run and the creator's claim button must still be there - `graduatedAt` comes from `GraduationManager` over RPC, and everything indexed-only must degrade with a named outage rather than an empty panel that reads as "nobody has traded".

Five defects in #29, four in the de-risking probe, and the worst defect in #37 were found by watching the running app rather than by tests.

## 8. Mainnet (4663)

Repeat steps 1-4 with `EXPECTED_CHAIN_ID=4663`, `--rpc-url robinhood`, `$BLOCKSCOUT_MAINNET_API`, the **real multisig** as `SAFE`, and the mainnet WETH9.
Do **not** run step 3's calibration (mainnet wants the 10 ETH code default with anti-snipe armed) and do **not** run step 6 - `SeedTestnet.s.sol` hard-reverts on 4663 by design.

## Owner-tunable params

Seven live on `LaunchpadFactory` behind `onlyOwner`.
Two do not, and both exceptions matter more than the rule.

| Setter | On | Binds | Notes |
| --- | --- | --- | --- |
| `setTreasury` | factory | future fees | zero address rejected |
| `setCreationFee` | factory | future launches | |
| `setCurveParams` | factory | future launches | `virtualEthReserve`, `tradeFeeBps` (<= 10%), `maxBuyPerWallet`, `antiSnipeThreshold` (strictly < `CURVE_SUPPLY`) |
| `setLockParams` | factory | future launches | `defaultLockDuration`, `creatorFeeBps` |
| `setMaxDevAllocationBps` | factory | future launches | ceiling on the creator's carve |
| `setVestingDuration` | factory | future grants | bounded `[30d, 4y]` |
| `setProtocolFee` | factory | future graduations | 0 = off, else 4..10 |
| `setInactivityPeriod` | **`LPLock`** | ⚠️ **EVERY lock, including existing ones** | monotonic, lengthen only. Not `onlyOwner`: it checks `launchpad.owner()` itself |
| `setPoolProtocolFee` | factory | ⚠️ **a specific live pool** | retroactive, no delay, no notice |

⚠️ **"All owner params are future-only" is false, and the two exceptions are the ones worth knowing.**

`LPLock.setInactivityPeriod` is **not** on the factory and is **not** future-only.
`inactivityPeriod` is the one lock term read **live** at `reclaim` time rather than frozen per position, so changing it moves the reclaim gate on every lock that already exists.
That is why its setter is monotonic: lengthening only ever moves an existing lock's terms in the creator's favour, and the accepted cost is that a mistake is permanent.
Sending `setReclaimInactivityPeriod` to the factory - a name this runbook used to list - reaches nothing.

⚠️ **`setPoolProtocolFee` is the one unmitigated privileged power**: retroactive on a live pool, no delay and no notice.
It is capped at 25% of swap fees and cannot touch principal.
The multisig is the only control.
Recorded in [`docs/security-checklist.md`](./security-checklist.md#deliberate-omissions).

⚠️ **`virtualTokenReserve` is not in this table and is not a constant either.**
Since #34 both `V_tok = C²/(C - G)` and `V_eth = target × G/(C - G)` are **solved per launch** from that launch's own carve, so the graduation target stays put whatever the creator takes. Calling it "calibration-locked" is a claim from before the dev allocation existed.

**There is no emergency pause and no timelock.** Both were declined on 2026-08-04 with reasons and costs recorded in [`docs/security-checklist.md`](./security-checklist.md#deliberate-omissions). Earlier versions of this runbook recommended a timelock as a fast-follow; that recommendation is withdrawn, not outstanding.

## What a deploy can no longer assume

Corrections that earlier revisions of this file got wrong, kept so they are not reintroduced:

- **The LP lock is not permanent.** Since [ADR-0005](./adr/0005-the-lp-lock-is-conditional-not-permanent.md) it is 1 year by default, extendable by the creator, monotonic, with permanent selectable at creation. "Graduated LP is permanently locked" was true up to #32 and is false now.
- **There is a pre-mine.** A creator may take 0-5% of the curve supply, vesting linearly from graduation. The surviving claim is **zero protocol allocation**, which is a different statement.
- **Three contracts became four**, and the fourth (`DevVesting`) is the one that gets skipped.
- **`GraduationManager.graduated` is not a bool.** It is `graduatedAt`, a `uint64` timestamp, since #35. Zero means "has not graduated" and is not a timestamp.
