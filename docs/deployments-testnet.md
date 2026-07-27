# Deployment — Robinhood Chain **testnet** (46630)

Broadcast of [`contracts/script/DeployLaunchpad.s.sol`](../contracts/script/DeployLaunchpad.s.sol)
per the runbook in [`docs/deploy.md`](./deploy.md). Addresses are public; this file is committed.

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
| `LaunchpadFactory` | `0x632FD8713356aCc4ec9BdC6b378c05707bc9D1E7` | ⬜ re-verify pending |
| `GraduationManager` | `0x3e28d8838951C9F1ad229a5506584616E46D5E14` | ⬜ re-verify pending |
| `LPLock` | `0x8FBAa12EEF6BB15C7dD33cCaAB62dbb9e3BeC0e1` | ⬜ re-verify pending |
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

Token `0x52eEF29C3c869b4D04F3C1451b16548dEaa923bE` · curve `0x81a14013d3F048BcBe4AF0fB8b88aF0ec25D799a`

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

Token `0x99fa21DCC0BAA3EFE125b32CCeEDa9AbcA4F90b8` · curve `0xFa3506cE7e4450dD50CAA6063cB0Ca98BaD42fC0`

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

Token `0xca77ffb346Be5945e6D745ed6723d7d794317c8F` · curve `0x41068c3d86dA330ba2Ac00Dc0FbDd08974b5f072`
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

The live 46630 factory is deliberately **not** on production calibration. It is set so a new launch
graduates for **exactly 0.1 ETH**, so the full lifecycle is cheap to exercise repeatedly.

| Param | Live testnet value | Production value (code default) |
| --- | --- | --- |
| `virtualEthReserve` | **1/30 ETH** (`33333333333333333`) | 30 ETH |
| `tradeFeeBps` | 100 (1%) | 100 (1%) |
| `maxBuyPerWallet` | **800M** (effectively uncapped) | 8M |
| `antiSnipeThreshold` | **0** (cap inactive) | 120M |

**Why `virtualEthReserve = 1/30 ETH` gives exactly 0.1 ETH:** `virtualTokenReserve` is
calibration-locked at `CURVE_SUPPLY² / (CURVE_SUPPLY - GRADUATION_RESERVE)`, which fixes
`finalEthReserve = 4 × V_eth`. So **ETH-to-graduate = 3 × V_eth**, always. 30 ETH → 90; 1/3 ETH → 1;
1/30 ETH → 0.1.

Verified on launch `P1ETH` (token `0x99fa21DCC0BAA3EFE125b32CCeEDa9AbcA4F90b8`, curve
`0xFa3506cE7e4450dD50CAA6063cB0Ca98BaD42fC0`, tx
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
# 1 ETH graduation:    333333333333333333
# 0.1 ETH graduation:   33333333333333333   <- current
cast send $LAUNCHPAD "setCurveParams(uint256,uint16,uint256,uint256)" \
  33333333333333333 100 800000000000000000000000000 0 \
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
