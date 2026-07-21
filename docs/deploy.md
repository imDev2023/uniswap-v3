# Deploy runbook — Build 07 (#18)

The production pipeline for the launchpad + our own Uniswap V3 stack on Robinhood Chain. **Testnet
first (46630), then mainnet (4663).** Ownership lands under a Safe multisig; contracts verify on
Blockscout.

Script: [`contracts/script/DeployLaunchpad.s.sol`](../contracts/script/DeployLaunchpad.s.sol).

## What the script does (one broadcast)

1. Deploys the platform's **own, unmodified** Uniswap V3 factory + SwapRouter + NonfungiblePositionManager
   (byte-for-byte the audited release, via `vm.getCode` — decision #4).
2. Deploys `LaunchpadFactory` wired to that V3 factory + position manager, with the **broadcaster** as
   initial owner.
3. `setOwner(launchpad)` on the V3 factory — hands the protocol fee switch to the launchpad so
   `applyProtocolFee` works at graduation (#17).
4. `launchpad.transferOwnership(SAFE)` — starts the **`Ownable2Step`** handoff. Ownership does **not**
   move until the Safe calls `acceptOwnership()`, so a mistyped `SAFE` can never brick the launchpad.

## Prerequisites

```bash
export PATH="$HOME/.foundry/bin:$PATH"
cd contracts

# Required
export SAFE=0x...                 # the Gnosis Safe multisig that will own the launchpad
# Optional (sensible defaults)
export TREASURY=0x...             # fee sink; defaults to $SAFE
export CREATION_FEE=10000000000000000   # 0.01 ETH in wei (default)
export WETH9=0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73   # RH mainnet WETH9 (default)
# Blockscout verification (keyless; api-key is ignored placeholder)
export BLOCKSCOUT_API_KEY=verifyContract
export BLOCKSCOUT_TESTNET_API=https://<rh-testnet-blockscout>/api
export BLOCKSCOUT_MAINNET_API=https://<rh-mainnet-blockscout>/api
```

Set the actual Blockscout instance URLs from the Robinhood Chain docs before verifying.

## 1. Testnet (46630) — dry run, then broadcast

```bash
# Dry run against real testnet state (no broadcast, no keys needed):
EXPECTED_CHAIN_ID=46630 forge script script/DeployLaunchpad.s.sol --fork-url robinhood_testnet

# Real deploy + verify (uses your configured signer, e.g. --account or --private-key):
EXPECTED_CHAIN_ID=46630 forge script script/DeployLaunchpad.s.sol \
  --rpc-url robinhood_testnet --broadcast \
  --verify --verifier blockscout --verifier-url "$BLOCKSCOUT_TESTNET_API" \
  --account deployer
```

The `EXPECTED_CHAIN_ID` guard makes the script revert if pointed at the wrong chain.

## 2. Finalize the Safe handoff

The Safe multisig must execute **`launchpad.acceptOwnership()`** (a single transaction from the Safe).
Until it does, the deployer remains owner. Confirm afterward:

```bash
cast call $LAUNCHPAD "owner()(address)" --rpc-url robinhood_testnet   # == $SAFE
cast call $LAUNCHPAD "pendingOwner()(address)" --rpc-url robinhood_testnet  # == 0x0
```

## 3. Smoke-test on testnet

- Create a launch, buy through the anti-snipe window, graduate, and confirm the pool is seeded +
  locked in `LPLock` and the protocol fee switch is on.
- From the Safe, exercise a guarded setter (e.g. `setCurveParams`, `setTreasury`) and confirm it binds
  only **future** launches.

## 4. Mainnet (4663)

Repeat step 1 with `EXPECTED_CHAIN_ID=4663`, `--rpc-url robinhood`, and `$BLOCKSCOUT_MAINNET_API`, then
steps 2–3 on mainnet.

```bash
EXPECTED_CHAIN_ID=4663 forge script script/DeployLaunchpad.s.sol \
  --rpc-url robinhood --broadcast \
  --verify --verifier blockscout --verifier-url "$BLOCKSCOUT_MAINNET_API" \
  --account deployer
```

## Owner-tunable params (all owner-only via the Safe; all future-only)

| Setter | Binds | Notes |
| --- | --- | --- |
| `setTreasury` | future fees | zero-addr rejected |
| `setCreationFee` | future launches | |
| `setCurveParams` | future launches | `virtualEthReserve`, `tradeFeeBps` (≤10%), `maxBuyPerWallet`, `antiSnipeThreshold` (≤800M). `virtualTokenReserve` is calibration-locked and not exposed. |
| `setProtocolFee` | future graduations | 0 = off, else 4..10 |
| `setPoolProtocolFee` | a specific pool | owner override |

In-flight launches freeze their params into curve immutables at `createLaunch`, and graduated LP is
permanently locked — no setter can reach either.

## Fast-follow (not in #18)

A timelock in front of `setTreasury` / fee setters (spec note on #18). Recommended before mainnet
volume; tracked separately.
