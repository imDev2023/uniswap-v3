# Deployment - Robinhood Chain **testnet** (46630)

Broadcast of [`contracts/script/DeployLaunchpad.s.sol`](../contracts/script/DeployLaunchpad.s.sol)
per the runbook in [`docs/deploy.md`](./deploy.md). Addresses are public; this file is committed.

---

# 🟢 CURRENT - build #38, 2026-08-06

The tokenomics redeploy.
**Everything below the "historical" divider is the superseded #24 deployment**, and is kept only for the validation records that still stand for the behaviour they exercised.

| Field | Value |
| --- | --- |
| Chain | Robinhood Chain Testnet, chainId **46630** |
| RPC | `https://rpc.testnet.chain.robinhood.com` |
| Explorer | https://explorer.testnet.chain.robinhood.com |
| Deployer EOA | `0x8Ec5f1e04531416d337E61733DfC5d1685D9A80C` |
| `SAFE` / owner | `0x8Ec5f1e04531416d337E61733DfC5d1685D9A80C` - the deployer EOA, decided 2026-08-05. The real multisig is a **mainnet** item |
| Treasury | `0x8Ec5f1e04531416d337E61733DfC5d1685D9A80C` |
| Deploy blocks | **97379690** (first tx) - 97379693 (last) |
| Subgraph `startBlock` | **97379693** - all four launchpad contracts are created in that one block |
| Gas spent | ~0.00055 ETH for the whole pipeline |
| Build | **#38** - redeployed for the tokenomics program (#33-#37): conditional LP lock, per-launch curve allocation, vesting from graduation, and the `nonReentrant` guard on `createLaunch` |

## Addresses

| Contract | Address | Verified |
| --- | --- | --- |
| `LaunchpadFactory` | `0xF1A9c1e70b6aEB48b85eE77518557c057283c6F5` | ✅ solc 0.8.24, optimizer 200 |
| `GraduationManager` | `0x4C0429f0881fA9B08DA314551de351087e8d48C3` | ✅ solc 0.8.24, optimizer 200 |
| `LPLock` | `0x3589e6aA59Ef396B63B3C2bAEe28E92a5498A8CE` | ✅ solc 0.8.24, optimizer 200 |
| **`DevVesting`** | `0x7727aC11099006651E67A2B7FBb5472Ea73d36c0` | ✅ solc 0.8.24, optimizer 200 - **first deployment ever** (#35 added it; it had never existed on chain) |
| `UniswapV3Factory` (ours) | `0x13a27fFB6A32721673DC449F606dC56926A61208` | ⬜ upstream artifact, see note |
| `SwapRouter` (ours) | `0xd258cca099f357F0b3488f20f7B4bf14A7727673` | ⬜ upstream artifact, see note |
| `NonfungiblePositionManager` (ours) | `0x49c4376c99a23DA36ec0018C6c417E73Ee4D167a` | ⬜ upstream artifact, see note |
| `QuoterV2` (ours) | `0xad315bece754ed5D0D4E87Bf6A70E45231607afC` | ⬜ upstream artifact, see note |
| `WETH9` (canonical, pre-existing) | `0x7943e237c7F95DA44E0301572D358911207852Fa` | n/a |

The three `LaunchpadFactory`-created contracts verified on the **first attempt** with explicit `--constructor-args`, including `DevVesting`.
Confirmed independently via `/api/v2/addresses/<addr>` reading `is_verified: true`, not just from the CLI's own success message.

⚠️ The V3 stack is deployed byte-for-byte from the audited upstream artifacts via `vm.getCode` ([ADR-0001](./adr/0001-unmodified-uniswap-v3-from-audited-artifacts.md)), so there is no in-repo Solidity for `forge verify-contract` to compile.
Still a Stage-4 item, unchanged by this deploy.

## Transactions

| Step | Tx |
| --- | --- |
| Deploy `UniswapV3Factory` | `0x56d66e5602e59ca30d940f904bbc1c394d47594e4eb32ba5117909c878b14759` |
| Deploy `SwapRouter` | `0x2a9d73bcf1c8478d1469d784dfb45963aecd823243cfca20ec95775c30d2c2d4` |
| Deploy `NonfungiblePositionManager` | `0xa84902e510128a49aa982965359eb1267da7f3d52f0963c04ffe2e5c6d76837a` |
| Deploy `LaunchpadFactory` (+ `LPLock`, `GraduationManager`, `DevVesting`) | `0x377743e656455934386e4d0c5c98809f3369dc5288ff4b7b967fcd0b503e7d5b` |
| `v3Factory.setOwner(launchpad)` | `0x10866c3f1df5b7a6636bc4828897dd6d5485b4dd69016ed897067a1ae29bc810` |
| `launchpad.transferOwnership(SAFE)` | `0x76254e65f7f763dbfd7a210e4d437a6b850bdc6bd27695aa96dd1547449027b8` |
| `launchpad.acceptOwnership()` | `0x4fae3034d5a11e85ddc8585c538f21ad14dccf7135668ad0b25e1b32ba8bc386` |
| `setCurveParams` → 0.1 ETH target | `0x8c2b7cf7a1fae7588fd848ae8aa07204cd51e0019e9ede8d1ca39fbeae8c3e31` |
| `setCurveParams` → 1 ETH target | `0xbc443be33fcd91c24e7e48795bed95c1ec2c72e0da2771bea7d0f1bd4d77cbad` |
| Deploy `QuoterV2` (separate script) | `0x05f02a2417af79648a531b3ce5ab6b9f8d4dd4169a01b4366f10ebed80b239a0` |

All receipts `status = 0x1`.

## Post-deploy state (verified via `cast`)

```
launchpad.owner()               = 0x8Ec5f1e04531416d337E61733DfC5d1685D9A80C   # == SAFE ✅
launchpad.pendingOwner()        = 0x0000000000000000000000000000000000000000   # handoff complete ✅
launchpad.graduationManager()   = 0x4C0429f0881fA9B08DA314551de351087e8d48C3
launchpad.lpLock()              = 0x3589e6aA59Ef396B63B3C2bAEe28E92a5498A8CE
launchpad.devVesting()          = 0x7727aC11099006651E67A2B7FBb5472Ea73d36c0
v3Factory.owner()               = 0xF1A9c1e70b6aEB48b85eE77518557c057283c6F5   # == launchpad ✅
```

⚠️ **The tokenomics defaults needed NO setter calls** - a fresh deploy already lands on the spec:

```
maxDevAllocationBps() = 500        # 5%
defaultLockDuration() = 31536000   # 365 days
vestingDuration()     = 2592000    # 30 days
creatorFeeBps()       = 7000       # 70%
```

So `setLockParams` and `setMaxDevAllocationBps` are **not** part of a deploy, contrary to what was planned for this ticket.
Only `setCurveParams` is, because the code default is the 10 ETH mainnet target.

## ⚙️ Curve calibration - this board carries TWO

`setCurveParams` is future-only, so launches created either side of a retune legitimately differ.
That is used deliberately here: the density board was seeded at the cheap target, and only the launches that exercise the tokenomics UI at the realistic one.
Rebuilding the whole board at 1 ETH would have cost ~3.6 ETH against 2.69 ETH of testnet funds.

| Launches | Target | `virtualEthReserve` | Anti-snipe |
| --- | --- | --- | --- |
| `RDOGE` … `QUIET` (the 11 board launches) | **0.1 ETH** | `33333333333333333` | off (threshold 0) |
| `VEST`, `FOREVER`, `CLAIM` (the showcase) | **1 ETH** | `333333333333333333` | off (threshold 0) |

Anti-snipe is off deliberately: at these targets the production 8M-per-wallet cap would let one wallet contribute a fraction of a percent, so a solo graduation would need hundreds of wallets.
The cap itself is proven on the superseded deployment's `SMOKE` and `SNIPE` launches, below.

⚠️ **A carved launch does not land on the target to the wei.**
`SEND` (0% carve) raised exactly `100000000000000000`; `CLAIM` (4% carve) raised `999999999999999997`, three wei short of 1 ETH.
Re-solving `V_eth = target * G/(C - G)` for a 768M allocation does not divide evenly, and the `ceilDiv` does not recover the whole truncation.
It is immaterial at 3e-18 relative, and pool seeding is exactly 200M tokens either way, but it means "the raise equals the target exactly" is a 0%-carve property rather than a general one.
First observed on a live chain here, and recorded in [`docs/tokenomics.md`](./tokenomics.md#amendments-made-during-implementation).

## Launch table (as of 2026-08-06, after `run()` + `showcase()`)

| Symbol | Token | Progress | Graduated | Dev carve | Lock |
| --- | --- | --- | --- | --- | --- |
| `RDOGE` | `0xd4ad8deb5f297d27bb3b756214fd68a8616feda7` | 96% | | - | 1 year |
| `OCAT` | `0x6c11fd6a8abe3c32e0bc706d0d7525ebbf5b059e` | 73% | | - | 1 year |
| `CANDLE` | `0x3591d434eb94bab01992ebbe8cb12da4c17e1064` | 72% | | - | 1 year |
| `DIAMOND` | `0xe2ef5c876620bd1c2be081947464ad81ec0e0a2b` | 58% | | - | 1 year |
| `BOOTS` | `0x1d9364a7cc162eba3fe370c985f2c3a847a8c4bf` | 45% | | - | 1 year |
| `COURAGE` | `0xae3c96ec06a81bb792b84ad4f704062c4eff1e0c` | 26% | | - | 1 year |
| `TENT` | `0x4968a09db9228404df96f9a82a02cd4a8a770dc7` | 19% | | - | 1 year |
| `PAPER` | `0x97c1fa0c47d17e137042c395b92499ab9af4a0d1` | 10% | | - | 1 year |
| `RUGPRF` | `0xedf313ee117af82812634cc433930e1f7e0b1754` | 3% | | - | 1 year |
| `SEND` | `0x6ca9b0d7872da22ebb637433a8d698404b2da085` | 100% | ✅ pool `0x60fE9610F443a5704AE1417E228689EcE14c40Eb`, LP NFT 1 | - | 1 year |
| `QUIET` | `0x5f2070a692adae6fe5a7c912475c2351e142b641` | 0% | | - | 1 year - untraded, the `priceX18 = 0` regression guard |
| **`VEST`** | `0x0f46d5b61ee9d6b579a36f9247890b4c224a74e0` | 35% | | **40M (5%)** | 1 year |
| **`FOREVER`** | `0x38f0e2fda7d581872125dfa7e90900d633a751fa` | 20% | | **24M (3%)** | **permanent** |
| **`CLAIM`** | `0xd2f1423078970746127978a8935e92c423073398` | 100% | ✅ pool `0x62Ce15666FA30B0592eb76cE3a211Ef6bD44Fb4f`, LP NFT 2 | **32M (4%)** | 1 year |

The three showcase launches were created by a **throwaway** key (`0xe4d1c06131881F2A49b71826d86Dad38A27Ae10C`), deliberately not one of the `TEST_PK_*` keys and not the deployer.
The acceptance test imports the creator's key into a real MetaMask, and no key from `contracts/.env` may ever be typed into a browser session.

⚠️ `RDOGE` reuses a ticker from two earlier deployments at a different address. Unrelated launches.

## ✅ Acceptance test - the app against live indexed data

The point of #38.
Every earlier confirmation of the tokenomics UI was against mocks or a local `anvil --fork-url` deploy, because `DevVesting` had never been deployed.

| Check | Result |
| --- | --- |
| Create form reads bounds from the new factory | ✅ "max 5.00%", "Default: 1 year from graduation", 70% |
| Creator fee names its denominator | ✅ "70% of the locked position's fees" - never "of pool fees" |
| Carved launch's progress denominator | ✅ `VEST` reads "266M / 760M", the carved allocation, not 800M |
| Concentration derived per launch | ✅ `VEST` 5.3% (40M/760M), `FOREVER` 3.1%, `CLAIM` 4.2% - not 5.0% against the 800M constant |
| Ungraduated carve → schedule not started | ✅ "Nothing has vested and nothing is releasing yet" |
| Permanent lock renders as permanent | ✅ `FOREVER`: "TERM Permanent … can never be withdrawn or reclaimed" |
| Graduated launch's positions | ✅ "Final. The curve closed at graduation" |
| Lock card states the **term** | ✅ "TERM 1 year" and "UNLOCKS IN 12 months" on `CLAIM`, never "forever" (ADR-0005) |
| Lock card names the **blocker** | ✅ "Lock has not expired" (`reclaimBlocker` = 4 = `NotExpired`, matching the chain) |
| Graduated + carved → schedule running | ✅ "Releasing linearly since graduation", 1.3% vested |
| 🔴 **graph-node STOPPED, graduated launch** | ✅ schedule still runs and the creator's claim button is still there - `graduatedAt` over RPC. Indexed-only panels degrade with a named outage ("the indexer is unreachable"), never an empty panel |
| 🔴 **A real claim, end to end** | ✅ 427,876.54 CLAIM released to the creator through MetaMask; `DevVesting` indexed its **first ever** `Claimed` event and `devClaimed` now diverges from `devAllocation`, which is the state the two-number concentration display was built for |

⚠️ `VESTED SO FAR` (428.58K, computed client-side from wall-clock) runs slightly ahead of `CLAIMED` (427.88K, indexed).
That is the intended behaviour, and the reason there is deliberately no `devVestedSoFar` field: a subgraph only writes when an event fires, so any stored figure would be silently stale between trades.

## ✅ Acceptance test - creator fee earnings (#39)

Run 2026-08-06 against `CLAIM` (LP NFT `2`, pool `0x62Ce15666FA30B0592eb76cE3a211Ef6bD44Fb4f`), the only launch with a locked position.
Fees had to be manufactured first: the position had earned nothing since graduation.

| Step | Result |
| --- | --- |
| Swap 0.02 ETH → `CLAIM` through our `SwapRouter` | ✅ tx `0x0c37b074…d85b2` - accrues fees on the WETH side |
| Swap the `CLAIM` back → WETH | ✅ tx `0x6b673fc9…3ec2` - accrues fees on the token side, so both assets are exercised |
| `LPLock.collect(2)` simulated before collecting | ✅ gross `149999999999999` WETH and `29123357521082565294538` CLAIM |
| ⚠️ **Card BEFORE any collection** | ✅ "Waiting to be collected 0.000104 ETH / 20.39K CLAIM" **and** "Nothing has been collected yet". This is the state the whole card exists for: the indexer honestly reports zero collections while the creator is genuinely owed money |
| `LPLock.collect(2)`, sent by the DEPLOYER not the creator | ✅ tx `0xf6c53db1…436c6`; creator's `CLAIM` balance `427,876.54 → 448,262.89`, exactly `+20,386.35` |
| Indexed split sums to the gross | ✅ `creator0 + treasury0 = 149999999999999` and `creator1 + treasury1 = 29123357521082565294538`, both exact - the floor rounding leaves the remainder with the treasury |
| ⚠️ **`sentBy` is not the creator** | ✅ `sentBy 0x8ec5…a80c` (deployer), `creator 0xe4d1…e10c`. The card says "sent by", never "collected by": `FeesCollected` carries no `msg.sender` |
| Card AFTER collecting | ✅ "Waiting 0 ETH / 0 CLAIM" (a genuine zero) and "Collected so far 0.000104 ETH / 20.39K CLAIM … Treasury received 8.74K CLAIM and 0.000045 ETH" |
| ⚠️ **No wallet connected throughout** | ✅ every figure above rendered with the wallet disconnected. The first build did NOT: `useSimulateContract` simulates as the connected account and threw `ConnectorNotConnectedError`, so the accrued panel was dark for every visitor who had not connected. It reads through `usePublicClient().simulateContract` now |
| 🔴 **graph-node STOPPED** | ✅ "Waiting to be collected" still reads the chain; "Collected so far" degrades to "Not indexed yet. The position and its history exist on-chain either way." The first build failed this too - it took the position's `tokenId` from the indexed `Lock.id`, so an outage disabled the chain read as well and the panel hung on "Reading the position…". `GraduationManager.tokenIdOf` supplies it now |

⚠️ **`CLAIM` is `token1` in its own pool** (`token0` is WETH `0x7943e237…52Fa`).
The non-obvious branch is the live one, so any code that assumed the launch token is `token0` would have been wrong on the only position that exists.

---

# 📜 HISTORICAL - build #24 deployment (superseded by #38)

Everything below describes the **superseded** `0x632FD871...D1E7` deployment.
Its addresses are dead, its subgraph `startBlock` is dead, and its launch table is unreachable from the current factory.
It is kept because the validation records still stand for the behaviour they exercised: the anti-snipe cap under six competing wallets, `LPLock.collect` to treasury, and the curve-params future-only proof were all demonstrated on chain there and are not re-run every redeploy.

| Field | Value |
| --- | --- |
| Chain | Robinhood Chain Testnet, chainId **46630** |
| RPC | `https://rpc.testnet.chain.robinhood.com` |
| Explorer | https://explorer.testnet.chain.robinhood.com |
| Deployer EOA | `0x8Ec5f1e04531416d337E61733DfC5d1685D9A80C` |
| Deploy block | **94091260** (first tx) – 94091261 (last) |
| Gas spent | ~0.0005 ETH total (deploy + `acceptOwnership`) |
| Build | **#24 (Build 11)** — redeployed for the Stage 1 contract changes |

## Addresses

| Contract | Address | Verified |
| --- | --- | --- |
| `LaunchpadFactory` | `0x632FD8713356aCc4ec9BdC6b378c05707bc9D1E7` | ✅ Blockscout (optimizer 200) |
| `GraduationManager` | `0x3e28d8838951C9F1ad229a5506584616E46D5E14` | ⬜ blocked — see note |
| `LPLock` | `0x8FBAa12EEF6BB15C7dD33cCaAB62dbb9e3BeC0e1` | ⬜ blocked — see note |
| `UniswapV3Factory` (ours) | `0x158a14f6Aa8C86921e624e3ed0526F31520cB2BD` | ⬜ see note |
| `SwapRouter` (ours) | `0x4507B2864CEcaBE10330d927c9608AA55A00fFD3` | ⬜ see note |
| `NonfungiblePositionManager` (ours) | `0xFc1C035Dc7e0C91ECFE8AC3bC31D1AC05d780CC4` | ⬜ see note |
| `QuoterV2` (ours) | `0xfcfA720Fe7397cA75233C6DB7aCBDa5859835cf6` | ⬜ see note |
| `WETH9` (canonical, pre-existing) | `0x7943e237c7F95DA44E0301572D358911207852Fa` | n/a |
| Treasury | `0x8Ec5f1e04531416d337E61733DfC5d1685D9A80C` | n/a |

**V3 stack verification note:** the factory / router / position manager are deployed byte-for-byte
from the audited Uniswap release artifacts via `vm.getCode` (decision #4), so there is no in-repo
Solidity source for `forge verify-contract` to compile. Verifying them needs a standard-JSON input
built from the upstream `@uniswap/v3-core` / `v3-periphery` package artifacts — tracked as a
follow-up, not a blocker.

## ⚠️ Testnet WETH9 differs from mainnet

`contracts/src/Constants.sol` hardcodes the **mainnet** WETH9
(`0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`). That address has **no code on 46630**. The canonical
testnet WETH9 is `0x7943e237c7F95DA44E0301572D358911207852Fa` — confirmed equivalent, not merely
similar:

- its proxy bytecode is **byte-identical** to mainnet `0x0Bd7…AD73`, and
- its EIP-1967 implementation bytecode is **byte-identical** to the mainnet implementation, and
- `deposit()` succeeds and `withdraw()` reverts with the correct `ERC20: burn amount exceeds balance`.

The deploy therefore passed `WETH9=0x7943e237c7F95DA44E0301572D358911207852Fa` explicitly. **Any
re-deploy or mainnet deploy must keep passing the right per-chain value** — the script's default is
mainnet-only. `GraduationManager.weth9()` on this deployment reads back the testnet address.

## Transactions

| Step | Tx |
| --- | --- |
| Deploy `UniswapV3Factory` | `0x7e701a57e28cb5429c379b77f8c4bdb2b2e82fbedce224631fbedd5ec1918f55` |
| Deploy `SwapRouter` | `0x3ace945a74024521af1c2f9a6b54a0a4dbc6ee581eceb9885342c91721b9ed72` |
| Deploy `NonfungiblePositionManager` | `0xcaab481a4fa8f96c94bfe3dfe91bd2837665ea0e8562df88558a386623fea33c` |
| Deploy `LaunchpadFactory` (+ `GraduationManager`, `LPLock`) | `0xf58e2a8d4db5c200e009c32fcae4d752aaa7d7379d4a124f2170e8502b42a535` |
| `v3Factory.setOwner(launchpad)` | `0x6d3521a2c26f8f20697756024eabeaac13aa9b4e90d285474f47ae19bb0672a4` |
| `launchpad.transferOwnership(SAFE)` | `0x001e09650500ba2ac7667f9759cef300a1eac26dabc40d83ddc8ab1d13d16ab1` |
| `launchpad.acceptOwnership()` | `0x7d51a7cdb66adcd548a61f38cacd85d8879a1a9fa45a49953f09514385bc5db8` |
| Deploy `QuoterV2` (separate script) | `0xba4125ebb47022f59c41f404b638a6853decdd1fca59e159dcaecfac8306e707` |

All receipts `status = 0x1`.

## QuoterV2 — exact swap quotes

Deployed separately via [`contracts/script/DeployQuoter.s.sol`](../contracts/script/DeployQuoter.s.sol),
because the quoter is a pure read-side lens: no owner, no funds, and nothing in the protocol
references it, so it can be added to a live deployment with zero risk to pools or the launchpad.

```
quoter.factory() = 0x158a14f6Aa8C86921e624e3ed0526F31520cB2BD   # == our V3 factory ✅
quoter.WETH9()   = 0x7943e237c7F95DA44E0301572D358911207852Fa   # testnet WETH9 ✅
```

Live check — `quoteExactInputSingle` 0.01 ETH → `GRAD` on the graduated pool returns
**2,150,469.10 GRAD**, and the swap page now renders exactly that figure instead of a `slot0`
estimate. `contracts/test/QuoterV2.t.sol` pins the property that matters against the live pool:
**the quote equals what the swap actually pays out**, both directions.

> ⚠️ `quoteExactInputSingle` is **non-`view`** — it performs a real swap and reverts with the result.
> Always call it with `eth_call` (the frontend uses wagmi's `useSimulateContract`). Sending it as a
> transaction burns gas and reverts.

Reproduce:

```bash
EXPECTED_CHAIN_ID=46630 \
  V3_FACTORY=0x158a14f6Aa8C86921e624e3ed0526F31520cB2BD \
  WETH9=0x7943e237c7F95DA44E0301572D358911207852Fa \
  forge script script/DeployQuoter.s.sol \
  --rpc-url robinhood_testnet --broadcast --non-interactive --private-key $PRIVATE_KEY
```

## Post-deploy state (verified via `cast`)

```
launchpad.owner()             = 0x8Ec5f1e04531416d337E61733DfC5d1685D9A80C   # == SAFE ✅
launchpad.pendingOwner()      = 0x0000000000000000000000000000000000000000   # handoff complete ✅
launchpad.treasury()          = 0x8Ec5f1e04531416d337E61733DfC5d1685D9A80C
launchpad.creationFee()       = 10000000000000000                            # 0.01 ETH
launchpad.graduationManager() = 0x3e28d8838951C9F1ad229a5506584616E46D5E14
launchpad.lpLock()            = 0x8FBAa12EEF6BB15C7dD33cCaAB62dbb9e3BeC0e1
v3Factory.owner()             = 0x632FD8713356aCc4ec9BdC6b378c05707bc9D1E7   # == launchpad ✅
graduationManager.weth9()     = 0x7943e237c7F95DA44E0301572D358911207852Fa   # testnet WETH9 ✅
swapRouter.WETH9()            = 0x7943e237c7F95DA44E0301572D358911207852Fa
positionManager.WETH9()       = 0x7943e237c7F95DA44E0301572D358911207852Fa
positionManager.factory()     = 0x158a14f6Aa8C86921e624e3ed0526F31520cB2BD
```

On this testnet the deployer EOA **is** the `SAFE` value, so `acceptOwnership()` was sent from the
EOA. On mainnet the Safe multisig must execute it as a multisig transaction.

## Notes on the broadcast

- `forge script --broadcast` needs **`--non-interactive`**: `LaunchpadFactory` used to compile to 26,586
  bytes, over the EIP-170 24,576 limit, and forge otherwise opens a TTY confirmation prompt that
  fails with `IO error: not a terminal` in a non-TTY shell. (The oversize contract is our own
  `LaunchpadFactory` — **not** the position manager, which lands at 24,384.) Robinhood Chain is an
  Arbitrum Orbit chain with a raised code-size limit, so the deploy succeeds.
- `forge verify-contract` reads `[etherscan]` in `foundry.toml`, which interpolates
  `BLOCKSCOUT_API_KEY` / `BLOCKSCOUT_TESTNET_API` / `BLOCKSCOUT_MAINNET_API`. **All three** must be
  exported or forge errors on the unused mainnet one.

## ✅ RESOLVED (2026-07-28) — all three contracts are verified; no contract change needed

**Every contract in the launchpad stack is now Blockscout-verified on testnet 46630**, including the
two the factory creates internally. The earlier diagnosis below is **stale** and is kept only as a
record of what was tried.

| Contract | Address | Verified |
| --- | --- | --- |
| `LaunchpadFactory` | `0x632FD871…D1E7` | ✅ solc 0.8.24, optimizer 200 |
| `GraduationManager` | `0x3e28d883…5E14` | ✅ solc 0.8.24, optimizer 200 |
| `LPLock` | `0x8FBAa12E…C0E1` | ✅ solc 0.8.24, optimizer 200 |

Both internally-created contracts verified on the **first attempt**, with no workaround, using the
ordinary command and explicit constructor args:

```bash
forge verify-contract 0x3e28d8838951C9F1ad229a5506584616E46D5E14 \
  src/periphery/GraduationManager.sol:GraduationManager \
  --chain 46630 --verifier blockscout --verifier-url "$BLOCKSCOUT_TESTNET_API" \
  --constructor-args $(cast abi-encode "constructor(address,address,address,address)" \
    $LAUNCHPAD $NPM $WETH9 $LPLOCK) --watch
# -> Pass - Verified

forge verify-contract 0x8FBAa12EEF6BB15C7dD33cCaAB62dbb9e3BeC0e1 \
  src/periphery/LPLock.sol:LPLock \
  --chain 46630 --verifier blockscout --verifier-url "$BLOCKSCOUT_TESTNET_API" \
  --constructor-args $(cast abi-encode "constructor(address,address)" $NPM $LAUNCHPAD) --watch
# -> Pass - Verified
```

**What changed:** the explorer now has the creation bytecode it previously lacked. `/api?module=
contract&action=getcontractcreation` returns, for `GraduationManager`, a full `creationBytecode`
(runtime + constructor args) **and** a `contractFactory` field naming `LaunchpadFactory` — a field
that did not exist in the response before. `creator_address_hash` is now attributed to the factory
rather than to an unrelated deploy tx. Either the instance was upgraded or its internal-transaction
index was backfilled; either way the missing input is present and matching succeeds.

**Mainnet is not at risk.** `robinhoodchain.blockscout.com` runs a *newer* Blockscout
(`v11.2.3` vs testnet's `v10.2.6`), reports `indexed_internal_transactions_ratio: 1.00`, and already
hosts verified factory-created contracts: of 20 sampled verified mainnet contracts, **18 were created
by another contract**, every one with full creation bytecode recorded.

➡️ **Consequence: the proposed fallback is dropped.** Deploying `GraduationManager` / `LPLock` as
top-level contracts instead of from the factory constructor would have been a **contract change
required before the audit**. It is not needed. The contracts stay frozen exactly as audited.

<details>
<summary>Superseded diagnosis (kept for the record)</summary>

`GraduationManager` and `LPLock` could not be verified on this explorer, and the reason was on
Blockscout's side, not ours:

- both are created by an internal `CREATE` inside the factory's constructor;
- `forge verify-contract --guess-constructor-args` refused outright: *"Fetching of constructor
  arguments is not supported for contracts created by contracts"*;
- passing the args explicitly returned `OK` then `Fail - Unable to verify`;
- `/api/v2/addresses/{addr}` reported **`creation_bytecode: false`** for both, and mis-attributed
  their `creation_transaction_hash` to the `NonfungiblePositionManager` deploy tx rather than the
  factory's. Without creation bytecode there was nothing for it to match against.
- submitting via the v2 standard-JSON endpoint was accepted (*"verification started"*) but never
  completed. Note that endpoint needs `-F "files[0]=@file.json;type=application/json"` — without the
  explicit content type it replies `JSON files not found`.

**Our source was provably correct even then.** Comparing deployed runtime bytecode against the local
artifact: LPLock differed in exactly **80 bytes** and GraduationManager in **320** — precisely 4 and
16 20-byte slots, every one an immutable address (`positionManager`, `launchpad`, `weth9`, `lpLock`),
present on-chain and zero-filled in the artifact as expected. No logic difference. The successful
verification above confirms that conclusion independently.

</details>

## Build #24 (Build 11) redeploy — Stage 1 validation ✅

This deployment **replaces** the one used for builds #12–#23. The contracts changed (widened
`LaunchCreated`, on-chain `metadataURI`, `token`-indexed trade events, `LaunchToken.launchpad`) and
the optimizer was switched on, so every address moved. **The launches recorded further down
(`SMOKE`, `RDOGE`, `GRAD`, `P1ETH`, `SNIPE`, `ONEETH`) live on the SUPERSEDED factory
`0xE98B99ADD42c550bf40B887Bf07A8f0119a22232` and are not reachable from this one.** They are kept
because their validation records still stand for the behaviour they exercised.

Calibration re-applied after deploy: `setCurveParams(33333333333333333, 100, 8e24, 0)` — graduation
at **0.1 ETH**, anti-snipe **off**, matching the previous testnet setup.

### Launch — `META`, the Stage 1 end-to-end

Token `0x52eEF29c3c869B4D04F3c1451b16548DEAA923bE` · curve `0x81a14013d3F048BcBe4AF0fB8b88aF0ec25D799a`

| Step | Result |
| --- | --- |
| `createLaunch("Meta Test","META","ipfs://bafkrei…vyku")` | ✅ 3-arg signature accepted |
| `token.metadataURI()` over plain RPC | ✅ returns the URI exactly — **metadata is global, not per-browser** |
| `token.launchpad()` | ✅ `0x632FD871…D1E7` — token names its own factory |
| `launchpad.curveOf(token)` from that | ✅ resolves the curve in **two RPC calls, no indexer** |
| `LaunchCreated` data payload | ✅ decodes to `V_eth 33333333333333333`, `V_tok 1.0666e27`, `alloc 8e26`, `fee 100`, `cap 8e24`, `threshold 0` — **identical to the curve's immutables** |
| `curve.priceX18()` **before any trade** | ✅ `31249999` — the `priceX18 = 0` bug is dead |
| Subgraph `Token` before any trade | ✅ `priceX18 31249999`, `tradeCount 0`, all six params + `metadataURI` indexed |
| `buy` 0.02 ETH | ✅ 397,490,589.71 tokens; subgraph `Trade` + `Holder` indexed — **the `token`-indexed `Bought` signature works** |
| `buy` 0.25 ETH (crossing) | ✅ graduated in-tx; `tokensSold` = 8e26 exactly; curve balance **0** |
| Pool seeded | ✅ `0xDC27FeCB8589c0FB0328fd98963c823a1681E933` — 200M tokens + **0.0999999999999998 WETH** |
| LP NFT 1 owner | ✅ `LPLock` `0x8FBAa12E…C0e1` |
| `slot0().feeProtocol` | ✅ `68` (= 4 \| 4<<4) — protocol fee switched on at graduation |
| Subgraph `Graduation` | ✅ `raisedEth` / `wethSeeded` = `100000000000000000` — **exactly 0.1 ETH, wei-for-wei** |
| Subgraph rollups | ✅ `launchCount 1`, `graduationCount 1`, `progressBps 10000`, `metadataURI` survives graduation |

Subgraph redeployed as `octopus/octopus` from `startBlock` **94091260**, synced and healthy.

## Smoke test — end-to-end on 46630 ✅ (superseded deployment)

Every production path was exercised on-chain against this deployment.

### Launch A — `SMOKE`, production calibration

Token `0x3ADDafBaC225b160A2770145c1259f5De5b9Bd0e` · curve `0xf48a1140bD437e5161730fa55F0c9C8479C348aD`

| Step | Result |
| --- | --- |
| `createLaunch("Smoke Test Token","SMOKE")` + 0.01 ETH | ✅ 800M minted to curve — *2-arg signature; build #24 added a third `metadataURI` arg* |
| `buy` 0.22 ETH | ✅ 7,688,183.78 tokens — **exactly** the `quoteBuy` figure |
| `buy` 0.05 ETH (2nd, would total ~9.4M) | ✅ **reverts** `BuyCapExceeded(9.43e24, 8e24)` — anti-snipe holds |
| `buy` 0.008 ETH (inside 311k headroom) | ✅ simulates fine — cap is a ceiling, not a freeze |
| `approve` + `sell` 2M tokens | ✅ 0.0564 ETH out, 0.00057 fee; `tokensSold` decreased |
| `purchasedOf` after the sell | ✅ still 7.688M — **sell-then-rebuy cannot evade the cap** |

### Curve params are future-only

`setCurveParams(0.3 ETH, 100bps, 800M, 0)` was executed from the owner, then restored. While the
factory defaults were changed, launch A's curve still read `virtualEthReserve = 30 ETH` and
`maxBuyPerWallet = 8M` — **in-flight launches freeze their params at `createLaunch`, confirmed
on-chain**, not just in tests. Production values are restored (30 ETH / 100 bps / 8M / 120M).

### Launch B — `GRAD`, test calibration, graduated

Token `0x1bfb12f7BE47CB8c485A1193551E25D99Dca9375` · curve `0x56D1eCddF12AE4ee662B873dC39B6AA15c03A7A8`

Calibrated to `virtualEthReserve = 0.3 ETH` so graduation costs ~0.9 ETH instead of ~90 (the
deployer holds ~2.9 testnet ETH). `virtualTokenReserve` is calibration-locked, so the #16 price
continuity property is exercised faithfully — only the absolute ETH scale differs.

| Check | Result |
| --- | --- |
| Threshold-crossing `buy` of **1.5 ETH** (oversized on purpose) | ✅ graduated; **net spend exactly 0.9 ETH** + gas — the 0.6 ETH excess was refunded |
| `curve.graduated()` / curve ETH balance | ✅ `true` / `0` — fully drained |
| Pool `0x4eB4cA4260cBcBF015740Fa0e2259f82A6fd9cF7` | ✅ `getPool(TOKEN,WETH,10000)` resolves to it |
| Pool seeding | ✅ 200,000,000 TOKEN + 0.9 WETH, liquidity `1.341e22` |
| Full-range position | ✅ ticks `-887200 … 887200` at the 1% tier |
| LP NFT id 1 owner | ✅ `LPLock` `0xf9D783…3aAd` |
| LP is *structurally* locked | ✅ `LPLock` exposes only `collect` + `onERC721Received` — no transfer/burn/approve. `decreaseLiquidity` from the deployer reverts `Not approved` |
| Protocol fee switch (#17) | ✅ `slot0.feeProtocol = 68` = 4/4 — `applyProtocolFee` fired at graduation |

### Swap page paths (#21) — both directions through our own `SwapRouter`

| Path | Result |
| --- | --- |
| ETH→TOKEN, payable `exactInputSingle`, 0.01 ETH | ✅ pool WETH 0.8999 → 0.9099 |
| TOKEN→ETH, `multicall([exactInputSingle → router, unwrapWETH9 → user])`, 1M tokens | ✅ +0.00453 native ETH received (net of gas) |
| Router WETH dust after unwrap | ✅ `0` — nothing stranded |

### Launch C — `P1ETH`, 0.1 ETH calibration, graduated

Token `0x99fa21dCc0Baa3EfE125b32ccEeDa9aBCa4f90b8` · curve `0xFA3506Ce7e4450DD50CAA6063Cb0cA98bAd42fC0`

The first launch created **after** the 0.1 ETH re-calibration, so it graduates on the live testnet
config rather than a bespoke one. It sat at 99.74% and was completed with one small buy.

| Check | Result |
| --- | --- |
| Graduating `buy` of **0.005 ETH** (`minTokensOut` 2e24) | ✅ returned exactly `2015113350125942574345375` — the full remaining allocation |
| Threshold-crossing refund | ✅ only ~0.00101 ETH gross charged; the ~0.00399 ETH excess refunded |
| `curve.graduated()` / curve ETH balance | ✅ `true` / `0` |
| Pool `0x8c723D400288c380b8742A5f34931feBE6c4CDf2` | ✅ `getPool(TOKEN,WETH,10000)` resolves to it |
| Pool seeding | ✅ 200,000,000 TOKEN + **0.1 WETH**, liquidity `4.472e21` |
| Full-range position | ✅ ticks `-887200 … 887200` at the 1% tier |
| LP NFT id 2 owner | ✅ `LPLock` `0xf9D783…3aAd` |
| Protocol fee switch (#17) | ✅ `slot0.feeProtocol = 68` = 4/4 |

Tx `0xe06f970304aba889faad0013b65df219eff39625567bc7320af6475352ccce1f`, block **93528382**,
17 logs, gas 5,401,965. Confirms the **3 × `virtualEthReserve`** graduation identity on a launch
that froze the current calibration: `finalEthReserve − virtualEthReserve` = exactly `1e17`.

Indexed end-to-end: the subgraph's `Graduation` entity reads pool `0x8c723d40…cdf2`, `tokenId` 2,
`tokensSeeded` 200M, `wethSeeded` / `raisedEth` `1e17`, matching the chain wei-for-wei; the frontend
shows P1ETH at the head of the "Just graduated" feed and `/swap/0x99fa21…90b8` resolves the pool
("liquidity locked · 0.1 ETH seeded").

### `LPLock.collect` — fee path to treasury ✅

Exercised on locked position **NFT id 1** (the `GRAD` pool), which had accrued real fees from the
#21 swap-page test swaps. `collect` is **permissionless** but hardcodes `recipient = launchpad
.treasury()`, so anyone may trigger it and only the treasury can receive.

| Check | Result |
| --- | --- |
| `eth_call` preview of `collect(1)` | 7,500 GRAD + 0.000075 WETH |
| Broadcast (tx `0x8e86148c0beedf33bf402d53e6a6cc6c99730c240b1493594bcc96ec0a14d2f5`, block 93671810) | ✅ treasury received **exactly** those amounts |
| Position liquidity before → after | ✅ `13416407864998738185908` → unchanged — **principal untouched** |
| `tokensOwed0/1` after | ✅ `0 / 0` — fully swept |
| NFT 1 owner after | ✅ still `LPLock` — collection does not move the position |

### Launch D — `SNIPE`, six wallets, anti-snipe armed ✅

Token `0xcA77FFb346be5945E6d745Ed6723D7D794317c8F` · curve `0x41068c3D86da330bA2Ac00dc0FBDd08974B5F072`
· pool `0x03D5597ad23eBda088a5F22353dd3ea5D56Efe15` · LP NFT **id 3** locked in `LPLock`

The first launch traded by **more than one wallet**. Anti-snipe was armed for it via
`setCurveParams(33333333333333333, 100, 25e24, 120e24)` (tx `0x833b11d4…34f`) — production's **15%
threshold kept**, per-wallet cap scaled 1% → 3.125% because six wallets cannot traverse a window
that by design needs ≥15 (`120M / 8M`). Restored to the baseline afterwards (tx `0x017ebffe…a82`).

Test wallets `TEST_PK_1..6` in `contracts/.env` (gitignored), 0.4 ETH each.

| # | Step | Result |
| --- | --- | --- |
| 1 | W1 buys 24M | ✅ `purchasedOf` 24M, `tokensSold` 24M |
| 2 | W1 buys 2M more | ✅ **reverts `BuyCapExceeded(26.996M, 25M)`** — decoded from the revert data |
| 3 | W1 buys 1M | ✅ succeeds → exactly 25M. The cap is a **ceiling, not a freeze** |
| 4 | W2, W3 buy 24M each | ✅ competing wallets each capped independently |
| 5 | W3 **sells 10M**, then re-buys 5M | ✅ `tokensSold` 73M→63M but `purchasedOf` **stays 24M** → re-buy **still reverts**. Sell-then-rebuy cannot evade the cap, now proven with competing buyers |
| 6 | W4, W5 buy 24M each | ✅ `tokensSold` 111M — still under the 120M threshold, cap still active |
| 7 | W6 buys 24M — the **crossing** buy | ✅ still capped (24M ≤ 25M): the window snapshot is taken **before** `tokensSold` mutates, so one buy cannot cross the threshold to escape its own cap (decision #7) |
| 8 | `buyCapActive()` after crossing | ✅ `false` at `tokensSold` 135M ≥ 120M |
| 9 | **W1** — the wallet blocked in step 2 — buys **100M in one go** | ✅ succeeds. Cap has genuinely lifted, and `purchasedOf` stays 25M (no longer written once inactive) |
| 10 | W6 graduates with 0.15 ETH (deliberate overpay) | ✅ net spend 0.09155 ETH vs 0.0914961 needed + gas — the 0.0585 ETH excess refunded |

Graduation identical in shape to launches B and C: pool seeded **200,000,000 SNIPE + 0.1 WETH**,
liquidity `4.472e21`, full range `-887200 … 887200` at the 1% tier, `slot0.feeProtocol = 68`,
LP NFT id 3 owned by `LPLock`.

**Multi-holder state reconciles exactly.** The subgraph indexes `holderCount` **6**, 10 trades
(9 buys / 1 sell), and the netting closes to the wei:

```
Σ bought   = 810,000,000e18      (W6 589M, W1 125M, W2/W4/W5 24M each, W3 24M)
Σ sold     =  10,000,000e18      (W3)
Σ balances = 800,000,000e18      == tokensSold == curveTokenAllocation ✅
```

W3 is the interesting row — `bought` 24M, `sold` 10M, `balance` 14M — confirming `Holder` nets
buys against sells rather than tracking gross. The frontend's holder table renders all six with
correct shares (73.6% / 15.6% / 3% / 3% / 3% / 1.7%) and "Creator holdings 0" (the deployer created
the launch but never bought).

### Not covered

- **Graduation at production scale.** Launches B, C and D graduated at 1/100th–1/900th of the ETH
  scale. The mechanism is validated; the ~90 ETH absolute figure is not exercised on testnet.
- **Same-block competition.** The six wallets bought in sequential blocks. The cap is per-wallet
  cumulative state, so ordering within a block does not change the arithmetic, but a genuine
  same-block race has not been staged.
- ~~**Multi-wallet anti-snipe.**~~ Now covered — launch D above.
- ~~**Multi-holder state.**~~ Now covered — launch D above.
- ~~**`LPLock.collect`.**~~ Now covered — see above.
- ~~**Subgraph indexing.**~~ Now covered: a self-hosted graph-node indexes this deployment from
  `startBlock` 93090715 and reproduces every event above. Stack + verification table in
  `subgraph/README.md`.

## ⚙️ Current testnet curve config — **1 ETH graduation** (test calibration)

**Changed 2026-08-01 on the user's instruction: testnet graduation is now 1 ETH (was 0.1 ETH).**
Set by `setCurveParams(333333333333333333, 100, 8e24, 0)` — tx
`0xf6047f279e42e7a5d16e2d3ea5d4f2f050673e4599ee796a6a5ac8521fbb79a1`, block 96028540.
`setCurveParams` is **future-only**, so every launch created before that block keeps the 0.1 ETH
calibration it froze at `createLaunch`; only launches created after it graduate at 1 ETH.

The live 46630 factory is deliberately **not** on production calibration. It is set so a new launch
graduates for **1 ETH**, which is cheap enough to exercise the full lifecycle repeatedly while being
close enough to the 10 ETH mainnet target that the arithmetic is exercised at a realistic scale.

| Param | Live testnet value | Production value (code default) |
| --- | --- | --- |
| `virtualEthReserve` | **1/3 ETH** (`333333333333333333`) | 30 ETH |
| `tradeFeeBps` | 100 (1%) | 100 (1%) |
| `maxBuyPerWallet` | 8M (`8e24`) | 8M |
| `antiSnipeThreshold` | **0** (cap inactive) | 120M |

✅ **Verified on-chain to be exactly 1 ETH**, on launch `CALIB` (token
`0x3F5D94bfa4f0BaCE252A6e7F700FBF5ec9DDA4B5`, curve `0x1B7a5061A9E3EDa96B95dC4A3b6274aCac495d45`),
created after the change specifically to read the calibration off a real curve:

```
virtualEthReserve = 333333333333333333
finalEthReserve   = 1333333333333333333
raised            = 1000000000000000000      # exactly 1 ETH
```

⚠️ **`3 × V_eth` is an approximation, and it is off by one wei for most targets. Do not size a
calibration with it.** The true amount is `ceilDiv(V_eth × V_tok, V_tok − CURVE_SUPPLY) − V_eth`,
and the `ceilDiv` is what decides the last wei. The counter-intuitive consequence is that the
**repeating-decimal targets are the exact ones**: `V_eth = target/3` truncates, and the `ceilDiv`
recovers precisely what the truncation lost. Targets whose thirds divide evenly have nothing to
recover, so the ceiling rounds them one wei **over**.

| Target | `V_eth = target/3` | Actual raised | Exact? |
| --- | --- | --- | --- |
| 0.1 ETH | `33333333333333333` | `100000000000000000` | ✅ |
| **1 ETH** | **`333333333333333333`** | **`1000000000000000000`** | ✅ ← current testnet |
| 1.2 ETH | `400000000000000000` | `1200000000000000001` | ✗ +1 wei |
| 1.5 ETH | `500000000000000000` | `1500000000000000001` | ✗ +1 wei |
| 2 ETH | `666666666666666666` | `1999999999999999999` | ✗ −1 wei |
| 3 ETH | `1000000000000000000` | `3000000000000000001` | ✗ +1 wei |
| 9 ETH | `3000000000000000000` | `9000000000000000001` | ✗ +1 wei |
| **10 ETH** | **`3333333333333333333`** | **`10000000000000000000`** | ✅ ← mainnet target |
| 12 ETH | `4000000000000000000` | `12000000000000000001` | ✗ +1 wei |
| 15 ETH | `5000000000000000000` | `15000000000000000001` | ✗ +1 wei |

**Both chosen targets — 1 ETH testnet and 10 ETH mainnet — land exactly.** Picking a "rounder"
number like 1.5 or 12 would make the result *less* clean, not more.

ℹ️ This table previously claimed `maxBuyPerWallet` was **800M**; the live value read `8e24` (8M)
before the change and was preserved as such. The doc had drifted from the chain.

**Why `virtualEthReserve = 1/30 ETH` gave exactly 0.1 ETH:** `virtualTokenReserve` is
calibration-locked at `CURVE_SUPPLY² / (CURVE_SUPPLY - GRADUATION_RESERVE)`, which fixes
`finalEthReserve = 4 × V_eth`. So **ETH-to-graduate = 3 × V_eth**, always. 30 ETH → 90; 1/3 ETH → 1;
1/30 ETH → 0.1.

Verified on launch `P1ETH` (token `0x99fa21dCc0Baa3EfE125b32ccEeDa9aBCa4f90b8`, curve
`0xFA3506Ce7e4450DD50CAA6063Cb0cA98bAd42fC0`, tx
`0x4125c4db1d618a23a705ead6878b81fe1902a505c1feada33efa75473e52c6a1`) — read straight off the curve:

```
virtualEthReserve = 33333333333333333
finalEthReserve   = 133333333333333333      # ratio exactly 4.0
difference        = 100000000000000000      # == 0.1 ETH exactly, not 1 wei short
```

`1e18/30` truncates to `33333333333333333`, but `finalEthReserve` is `ceil(k / finalTokenReserve)`,
and that rounding up lands the difference on exactly `1e17`.

> The 1% trade fee is taken off the way in, so graduating costs ~**0.10101 ETH gross** (0.1 ETH *net*
> reaches the reserve). Send a little over 0.1 ETH — the curve refunds any excess past the threshold.

**Anti-snipe is off**, and that is deliberate: at this scale the production 8M-per-wallet cap would
let one wallet contribute only ~0.00025 ETH, so a solo graduation would need ~400 wallets. The cap
itself is already proven on the `SMOKE` launch above (production calibration, cap enforced).

**Previously 1 ETH.** Set by
`setCurveParams(33333333333333333, 100, 800000000000000000000000000, 0)` — tx
`0x9e8b9d7240f41ae0fe814f673a6a1fe3eb00b8232c71e9fb5ab47ad5a455da41`, block 93355174. Because
`setCurveParams` is future-only, the older `ONEETH` / `SMOKE` / `GRAD` launches keep the calibration
they froze at `createLaunch` — only launches created after that block graduate at 0.1 ETH.

**This is testnet-only state, set via the owner-only `setCurveParams`.** The Solidity constants in
`LaunchpadFactory` are untouched — `DEFAULT_VIRTUAL_ETH_RESERVE` is still `30 ether`, so a **mainnet
deploy is unaffected** and lands on production calibration.

Restore production values on testnet at any time:

```bash
cast send $LAUNCHPAD "setCurveParams(uint256,uint16,uint256,uint256)" \
  30000000000000000000 100 8000000000000000000000000 120000000000000000000000000 \
  --rpc-url robinhood_testnet --private-key $PRIVATE_KEY
```

Or re-scale the graduation threshold to any target — `virtualEthReserve = target / 3`:

```bash
# 10 ETH graduation:  3333333333333333333   <- the agreed MAINNET target
#  1 ETH graduation:   333333333333333333   <- current testnet setting
# 0.1 ETH graduation:   33333333333333333
cast send $LAUNCHPAD "setCurveParams(uint256,uint16,uint256,uint256)" \
  333333333333333333 100 8000000000000000000000000 0 \
  --rpc-url robinhood_testnet --private-key $PRIVATE_KEY
```

`setCurveParams` is **future-only** — it never touches an in-flight curve (proven on-chain above), so
existing launches keep whatever calibration they froze at `createLaunch`.

## Reproduce

```bash
export PATH="$HOME/.foundry/bin:$PATH"
cd contracts && set -a && . ./.env && set +a

EXPECTED_CHAIN_ID=46630 WETH9=0x7943e237c7F95DA44E0301572D358911207852Fa \
  forge script script/DeployLaunchpad.s.sol \
  --rpc-url robinhood_testnet --broadcast --non-interactive --private-key $PRIVATE_KEY
```

## Seeding a board to look at (build #28)

`contracts/script/SeedTestnet.s.sol` populates the launchpad with a realistic spread of launches.
It exists because the live board (Stage 3) is a density problem: against a single graduated token
the board renders as one card in an empty grid, which proves nothing about layout, sort order,
progress meters or the trade feed.
It seeds the **chain**, not fixtures, so what the UI shows is real contract state.

⚠️ **Testnet only.** The script hard-reverts on mainnet 4663.
It spends real ETH across seven keys and creates permanent, unremovable launches, and `metadataURI`
has no setter by design, so a stray mainnet run would be public forever.

```bash
export PATH="$HOME/.foundry/bin:$PATH"
cd contracts
export LAUNCHPAD=0x632FD8713356aCc4ec9BdC6b378c05707bc9D1E7

# Create the launch table and buy each curve up to its target progress.
forge script script/SeedTestnet.s.sol:SeedTestnet --sig 'run()' \
  --rpc-url robinhood_testnet --broadcast --slow

# Trade a little on every live curve, to refresh "recent trades" while iterating on the feed.
# Safe to repeat; it never buys enough to graduate anything.
forge script script/SeedTestnet.s.sol:SeedTestnet --sig 'churn()' \
  --rpc-url robinhood_testnet --broadcast --slow
```

`--slow` matters: it waits for each transaction to land before sending the next.
Without it, nonce-ordered submission on a 0.3 s-block chain can have a buy arrive before the
creation it depends on.

The spread deliberately includes the cases design forgets: a launch with **no** metadata URI (the
common case, since v1 is bring-your-own-URI), a launch whose `ipfs://` URI does **not** resolve, an
**untraded** launch at 0% (also the regression guard for the `priceX18 = 0` bug fixed in #24), one
launch that **graduates** on its crossing buy, and curves at both ends of the progress meter.
Buy amounts are derived from the curve's own invariant rather than a hardcoded table, so the script
stays correct if the testnet calibration is re-scaled with `setCurveParams`.

The 2026-07-30 run created 11 launches (total cost ~0.47 ETH across the six `TEST_PK_*` wallets),
taking the factory to 12 launches / 2 graduations / 23 trades.

### Seeded launch table (as of 2026-07-30, after `run()` + one `churn()`)

Progress moves whenever `churn()` is run again, so treat the percentages as indicative.

| Symbol | Token | Progress | Graduated |
| --- | --- | --- | --- |
| `META` | `0x52eEF29c3c869B4D04F3c1451b16548DEAA923bE` | 100% | ✅ pool `0xDC27FeCB8589c0FB0328fd98963c823a1681E933`, LP NFT 1 |
| `SEND` | `0xF92A5Cd2F903750B83CF507897E5c5768Fc50Ebb` | 100% | ✅ pool `0x65F3aC73CeE1e0cF7130AA4b7974633Aff465D3f` |
| `RDOGE` | `0x11E0d50dB0f8F8fc635C159898EDBDF7113c635a` | 97% | |
| `OCAT` | `0x19ae982840Ad1FB9e166742f682Ade566495531c` | 75% | metadata URI set, does **not** resolve |
| `CANDLE` | `0xF5fDFD8A677E8b7587685706eb68E7F51b1a35d0` | 63% | |
| `DIAMOND` | `0x4f34e3A28076a35933f8E87c962d1eCC5CFD26E1` | 60% | |
| `BOOTS` | `0xb97c60F6D38aA8Bb7272cb5075dF90940149b107` | 46% | metadata URI set, does **not** resolve |
| `COURAGE` | `0x745877C5ce6769D9Ac017c1949A4A3C6788c1333` | 21% | |
| `TENT` | `0x935B14EF40C8bD8bEcee2F1ac1C8893DB94F3877` | 21% | |
| `PAPER` | `0x1C9738C6af152fe7b70B177c0498f6A27BE40ffc` | 12% | |
| `RUGPRF` | `0xA2d638E797dD6Aabe57e8994e80C5bB822CEC2d5` | 3% | |
| `QUIET` | `0x8554b5011685E3F81502E8bE9cc9AF7f9c0486ec` | 2% | launched untraded; `churn()` has since bought it |

⚠️ This set reuses the ticker **`RDOGE`** at a different address from the one on the superseded
factory. They are unrelated launches.

### Metadata launches added 2026-07-31 (build #30)

The seeded set above deliberately covers the metadata cases that FAIL, but it left no case that
SUCCEEDS, so the read side had no happy path to be built against.
Note `META`'s URI is not one: its CID resolves `200` with a **zero-byte body**, and `OCAT`/`BOOTS`
are structurally valid CIDs that were never pinned (both answer `504`).

| Symbol | Token | Metadata URI | Exercises |
| --- | --- | --- | --- |
| `ORICH` | `0x439F067FbCe73A6eB6e9e638B327370BF8c79D96` | `data:application/json;base64,…` | Full document - name, description, two links, and a nested `ipfs://` image. Depends on **no gateway**, so it stays a working fixture even if every public gateway is down. |
| `OPIN` | `0x5a3184C973d268Ab674F5b039F97e86Ee8456F84` | `ipfs://QmeSjSinHpPnmXmspMjwiXyN6zS4E9zccariGR3jxcaWtq/1` | The real IPFS path: a widely-pinned CIDv0 with a directory path, so it also covers the CIDv0 spelling that cannot be expressed as a gateway subdomain. |

`ORICH` also received four buys (~0.011 ETH total) so the chart and range selector had a real
irregular series to re-derive.

Created with `cast send $FACTORY "createLaunch(string,string,string)" <name> <symbol> <uri>
--value 0.01ether`.
⚠️ Both are permanent and their URIs can never be changed - `metadataURI` has no setter.

⚠️ **There is no longer a never-traded launch on testnet.** `QUIET` was created untraded on purpose
(it is the regression case for the `priceX18 = 0` bug fixed in #24, and for the board's "New" card
state), but `churn()` bought it up to ~2%. Create a fresh one with `createLaunch` and simply do not
buy it if that state needs to be exercised by hand again. The board's untraded rendering is covered
by `HomePage.test.tsx` regardless.
