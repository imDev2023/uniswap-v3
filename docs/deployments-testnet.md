# Deployment — Robinhood Chain **testnet** (46630)

Broadcast of [`contracts/script/DeployLaunchpad.s.sol`](../contracts/script/DeployLaunchpad.s.sol)
per the runbook in [`docs/deploy.md`](./deploy.md). Addresses are public; this file is committed.

| Field | Value |
| --- | --- |
| Chain | Robinhood Chain Testnet, chainId **46630** |
| RPC | `https://rpc.testnet.chain.robinhood.com` |
| Explorer | https://explorer.testnet.chain.robinhood.com |
| Deployer EOA | `0x8Ec5f1e04531416d337E61733DfC5d1685D9A80C` |
| Deploy block | **93090712** (first tx) – 93090715 (last) |
| Gas spent | ~0.00023 ETH total (deploy + `acceptOwnership`) |

## Addresses

| Contract | Address | Verified |
| --- | --- | --- |
| `LaunchpadFactory` | `0xE98B99ADD42c550bf40B887Bf07A8f0119a22232` | ✅ Blockscout |
| `GraduationManager` | `0xE44a178EaD9D35D4e0e6d0fE77Cee82F81F785a5` | ✅ Blockscout |
| `LPLock` | `0xf9D783674b2F575aFe2fcd70a8BCEfe38Ea33aAd` | ✅ Blockscout |
| `UniswapV3Factory` (ours) | `0x808088B7949877b0eF9CC514627426505CF069bA` | ⬜ see note |
| `SwapRouter` (ours) | `0x7a9232B5af20635AbC85c5f854648E916B3b8826` | ⬜ see note |
| `NonfungiblePositionManager` (ours) | `0x52e32e892E43b945a3FE747305CC7C2496dDbB61` | ⬜ see note |
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
| Deploy `UniswapV3Factory` | `0xbc2fb6b5eeda196814d2c9506ae2ea340ece09e272b7da7b3847f47f7cbfdbc4` |
| Deploy `SwapRouter` | `0xb57bd8c71f9530cffad9d0a472a0ab6b371ef8369370cbe34941976519b5deb1` |
| Deploy `NonfungiblePositionManager` | `0x5df9e5bf2051fe8b4436ea10eadc88cf8cfb2a2f6cad256a563197b20f0f10d9` |
| Deploy `LaunchpadFactory` | `0xc04d91b98620902d6020c6ff008e508890a58563fa5f5077af5d8d37dea90b21` |
| `v3Factory.setOwner(launchpad)` | `0x7a60375cfc0fb8a485cb57697a03d60394f991ab21c999078e7d92de5b719ed8` |
| `launchpad.transferOwnership(SAFE)` | `0xf7dbdcf9d0c492e9148b2c2f5b486202c781030c3c66a37a26a855d6f0e09bef` |
| `launchpad.acceptOwnership()` | `0x71ba77c46ee14d863ac6592d4b835372af98619c34ee4cc10d3662ad50d57545` |

All receipts `status = 0x1`.

## Post-deploy state (verified via `cast`)

```
launchpad.owner()             = 0x8Ec5f1e04531416d337E61733DfC5d1685D9A80C   # == SAFE ✅
launchpad.pendingOwner()      = 0x0000000000000000000000000000000000000000   # handoff complete ✅
launchpad.treasury()          = 0x8Ec5f1e04531416d337E61733DfC5d1685D9A80C
launchpad.creationFee()       = 10000000000000000                            # 0.01 ETH
launchpad.graduationManager() = 0xE44a178EaD9D35D4e0e6d0fE77Cee82F81F785a5
launchpad.lpLock()            = 0xf9D783674b2F575aFe2fcd70a8BCEfe38Ea33aAd
v3Factory.owner()             = 0xE98B99ADD42c550bf40B887Bf07A8f0119a22232   # == launchpad ✅
graduationManager.weth9()     = 0x7943e237c7F95DA44E0301572D358911207852Fa   # testnet WETH9 ✅
swapRouter.WETH9()            = 0x7943e237c7F95DA44E0301572D358911207852Fa
positionManager.WETH9()       = 0x7943e237c7F95DA44E0301572D358911207852Fa
positionManager.factory()     = 0x808088B7949877b0eF9CC514627426505CF069bA
```

On this testnet the deployer EOA **is** the `SAFE` value, so `acceptOwnership()` was sent from the
EOA. On mainnet the Safe multisig must execute it as a multisig transaction.

## Notes on the broadcast

- `forge script --broadcast` needs **`--non-interactive`**: `LaunchpadFactory` compiles to 26,586
  bytes, over the EIP-170 24,576 limit, and forge otherwise opens a TTY confirmation prompt that
  fails with `IO error: not a terminal` in a non-TTY shell. (The oversize contract is our own
  `LaunchpadFactory` — **not** the position manager, which lands at 24,384.) Robinhood Chain is an
  Arbitrum Orbit chain with a raised code-size limit, so the deploy succeeds.
- `forge verify-contract` reads `[etherscan]` in `foundry.toml`, which interpolates
  `BLOCKSCOUT_API_KEY` / `BLOCKSCOUT_TESTNET_API` / `BLOCKSCOUT_MAINNET_API`. **All three** must be
  exported or forge errors on the unused mainnet one.

## Smoke test — end-to-end on 46630 ✅

Every production path was exercised on-chain against this deployment.

### Launch A — `SMOKE`, production calibration

Token `0x3AdDafBAC225B160a2770145c1259F5de5b9bd0e` · curve `0xf48A1140bD437E5161730fA55f0C9C8479c348ad`

| Step | Result |
| --- | --- |
| `createLaunch("Smoke Test Token","SMOKE")` + 0.01 ETH | ✅ 800M minted to curve |
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

Token `0x1bFB12F7bE47cb8C485a1193551e25d99DcA9375` · curve `0x56d1EcDdF12ae4Ee662b873DC39b6Aa15C03a7a8`

Calibrated to `virtualEthReserve = 0.3 ETH` so graduation costs ~0.9 ETH instead of ~90 (the
deployer holds ~2.9 testnet ETH). `virtualTokenReserve` is calibration-locked, so the #16 price
continuity property is exercised faithfully — only the absolute ETH scale differs.

| Check | Result |
| --- | --- |
| Threshold-crossing `buy` of **1.5 ETH** (oversized on purpose) | ✅ graduated; **net spend exactly 0.9 ETH** + gas — the 0.6 ETH excess was refunded |
| `curve.graduated()` / curve ETH balance | ✅ `true` / `0` — fully drained |
| Pool `0x4eB4Ca4260cBCbf015740fA0e2259f82A6fd9cf7` | ✅ `getPool(TOKEN,WETH,10000)` resolves to it |
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

### Not covered

- **Multi-wallet anti-snipe.** One EOA was used, so the per-wallet cap is proven per-wallet but not
  across competing buyers in one block.
- **Graduation at production scale.** Launch B graduated at 1/100th the ETH scale. The mechanism is
  validated; the ~90 ETH absolute figure is not exercised on testnet.
- **`LPLock.collect`.** The pool has accrued essentially no fees yet, so the fee-routing path to
  treasury is still test-only.
- **Subgraph indexing.** No graph-node is running — see `subgraph/README.md`.

## ⚙️ Current testnet curve config — **1 ETH graduation** (test calibration)

The live 46630 factory is deliberately **not** on production calibration. It is set so a new launch
graduates for **exactly 1 ETH**, so the full lifecycle is cheap to exercise repeatedly.

| Param | Live testnet value | Production value (code default) |
| --- | --- | --- |
| `virtualEthReserve` | **1/3 ETH** (`333333333333333333`) | 30 ETH |
| `tradeFeeBps` | 100 (1%) | 100 (1%) |
| `maxBuyPerWallet` | **800M** (effectively uncapped) | 8M |
| `antiSnipeThreshold` | **0** (cap inactive) | 120M |

**Why `virtualEthReserve = 1/3 ETH` gives exactly 1 ETH:** `virtualTokenReserve` is calibration-locked
at `CURVE_SUPPLY² / (CURVE_SUPPLY - GRADUATION_RESERVE)`, which fixes `finalEthReserve = 4 × V_eth`.
So **ETH-to-graduate = 3 × V_eth**, always. 30 ETH → 90; 1/3 ETH → 1.

Verified on launch `ONEETH` (token `0x9903AFeF4800a4b8A05e4Ee62BE2bA720444255F`, curve
`0x5CdF2eed221F3b2816BdA978fD4dE10e46210407`): `finalEthReserve - virtualEthReserve` = **1.000000 ETH**.

> The 1% trade fee is taken off the way in, so graduating costs ~**1.0101 ETH gross** (1 ETH *net*
> reaches the reserve). Send a little over 1 ETH — the curve refunds any excess past the threshold.

**Anti-snipe is off**, and that is deliberate: at this scale the production 8M-per-wallet cap would
let one wallet contribute only ~0.0025 ETH, so a solo graduation would need ~400 wallets. The cap
itself is already proven on the `SMOKE` launch above (production calibration, cap enforced).

**This is testnet-only state, set via the owner-only `setCurveParams`.** The Solidity constants in
`LaunchpadFactory` are untouched — `DEFAULT_VIRTUAL_ETH_RESERVE` is still `30 ether`, so a **mainnet
deploy is unaffected** and lands on production calibration.

Restore production values on testnet at any time:

```bash
cast send $LAUNCHPAD "setCurveParams(uint256,uint16,uint256,uint256)" \
  30000000000000000000 100 8000000000000000000000000 120000000000000000000000000 \
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
