# Tokenomics and revenue model

Every number here was read off the deployed contracts or computed from them on 2026-08-01, not recalled.
Figures are given at the **agreed 10 ETH mainnet graduation target**.

⚠️ **This document is the substrate for an UNFINISHED discussion.** The user opened a detailed tokenomics review and it is the live thread: see [Open questions](#open-questions).
Nothing below has been changed as a result of it yet.

## Supply

| | value | share |
| --- | --- | --- |
| Total supply | 1,000,000,000 | fixed, no mint function exists |
| Sold on the bonding curve | 800,000,000 | 80% |
| Seeded into the pool at graduation | 200,000,000 | 20% |
| Protocol / treasury allocation | **0** | 0% |
| Creator allocation | **0** | 0% |

Source: `LaunchpadFactory.CURVE_SUPPLY` / `GRADUATION_RESERVE`.

The 800/200 split is **identical to pump.fun's**, which was checked rather than assumed.
Neither platform has a pre-mine, a team allocation or vesting.

⚠️ **"Only 800M is tradable" is a misreading that comes up.** All 1B trades. The 800M is held by curve buyers and sells freely into the pool after graduation; the 200M *is* the pool's token-side inventory, which is what anybody buys from. A pool needs both sides. What is permanently locked is the **LP position**, not the tokens' tradability.

## Price and value at a 10 ETH graduation

```
open price   3.125e-9 ETH/token   ->  FDV   3.125 ETH
grad price   5.000e-8 ETH/token   ->  FDV  50.000 ETH
                                       multiple   16.00x
                                       FDV/raise   5.00x
pool at graduation: 200,000,000 tokens + 10 ETH  =  20 ETH TVL  (40% of FDV)
```

**Return by entry point**, which is the fair-launch story in one line:

| bought at | return at graduation |
| --- | --- |
| the very first wei | **16x** |
| the average curve price | **4x** |
| the last wei before graduation | 1x |

Benchmark: pump.fun's ~85 SOL raise against a ~$69k graduation market cap is also roughly 4-5x.
**The curve shape is already calibrated in line with the benchmark.** Only the absolute ETH figure is a live choice.

## ⚠️ The invariant that must never be broken

This explains why `virtualTokenReserve` is deliberately not tunable through `setCurveParams`, and it is the single most important thing to understand before touching calibration:

```
200,000,000 tokens x 5.0e-8 (graduation price) = 10.000000 ETH = exactly the raise
```

The curve's **final marginal price is exactly the pool's opening price**, and the 200M reserve valued at that price is **exactly balanced** against the raised ETH.
So there is no price gap at graduation, no lopsided pool, and no arbitrage gift to the first person to swap.

It holds for **any** graduation target, which is precisely why `virtualEthReserve` is safe to retune and the token side is not.

### Consequence: the multiples are structural, not settings

Changing the graduation target scales every absolute price and changes **neither** the 16x nor the 5x FDV/raise ratio.
If either of those numbers is wrong for the product, the graduation target is **not** the lever. `virtualTokenReserve` is, and moving it breaks the invariant above.

### Calibration arithmetic

`ETH-to-graduate = 3 x virtualEthReserve` is an **approximation and is off by one wei for most targets**. Do not size a calibration with it. The true amount is:

```
ceilDiv(V_eth x V_tok, V_tok - CURVE_SUPPLY) - V_eth
```

The counter-intuitive result is that **repeating-decimal targets are the exact ones**: `V_eth = target/3` truncates and the `ceilDiv` recovers precisely what the truncation lost.
Both chosen targets land exactly: **1 ETH testnet** and **10 ETH mainnet**. Rounder-looking targets such as 1.5, 3, 9 or 12 come out one wei over. Full table in `docs/deployments-testnet.md`.

## Liquidity

The graduation position is **full range** (`MIN_TICK` / `MAX_TICK` in `GraduationManager`), and it must stay that way.
A concentrated position that drifts out of range becomes 100% one asset and stops providing liquidity, which would silently void the "locked liquidity forever" promise.
Capital-inefficient by design; correct for a permanent lock.

20 ETH of pool TVL at graduation is deep relative to pump.fun's commonly-cited $10-15k migrations. A genuine differentiator, and it follows from seeding the entire raise.

## Anti-snipe economics at 10 ETH

Defaults are `maxBuyPerWallet` 8M (1% of curve supply) and `antiSnipeThreshold` 120M (15% of curve supply).

| | |
| --- | --- |
| Cost for one wallet to max the 8M cap at open | **0.025 ETH** |
| Total ETH to reach the 120M lift threshold | **0.42 ETH** (4.2% of the raise) |
| Minimum distinct wallets to traverse the window | **15** |

⚠️ Untested at this calibration. Real launches should exceed 15 buyers so it ought to be invisible, but the friction only bites organic launches: a determined sniper simply uses 15 wallets.

⚠️ `maxBuyPerWallet` is a share of **tokens**, so recalibrating the raise does not change it. Moving the target from 90 ETH to 10 ETH made that same 1% cost roughly **9x less ETH**, so the economic barrier to sniping fell by the same factor.

---

# Revenue model

Four streams, all routed to `treasury`. Values read live from the deployed factory.

## 1. Creation fee, `0.01 ETH` flat

Charged on every `createLaunch` and forwarded to treasury in the same transaction. Excess is refunded.
Paid by **everyone who launches**, including the overwhelming majority that never graduate. The high-frequency line.

## 2. Curve trade fee, `1%` (100 bps)

On both buys and sells, on gross ETH. Hard-capped at 10% in code (`MAX_TRADE_FEE_BPS = 1000`).
A launch that graduates puts 10 ETH net into the reserve, so buyers pay ~10.101 ETH gross: **~0.101 ETH minimum** per graduation, plus fees on every sell and re-buy along the way.

## 3. Pool protocol fee, `25%` of swap fees, in perpetuity

Graduated pools use the **1% fee tier** (`POOL_FEE_TIER = 10000`), and `protocolFee = 4` means the protocol takes 1/N = 1/4 of each swap's fee:

```
pool charges     1.00% per swap
  -> protocol     0.25%     via collectProtocolFees
  -> LPs          0.75%
```

This is why the launchpad owns the V3 factory: it is what makes the fee switch ours to flip.

## 4. Locked LP position fees

`LPLock.collect()` routes **100%** of the locked position's accrued fees to treasury.
At graduation **we are the only LP**, so the 0.75% LP share is also ours.

A freshly graduated pool therefore earns the protocol effectively the **entire 1%** of swap volume (0.25% protocol + 0.75% LP), diluting toward 0.25% as third-party liquidity joins.

⚠️ **The permanent LP lock is not only a trust device. It is the largest long-term revenue line**, and it is a perpetuity: it can never be withdrawn, so it keeps earning on that pool forever.

## Shape of the business

| | per launch |
| --- | --- |
| Launched, never graduates | 0.01 ETH + 1% of whatever churned |
| Graduates | ~0.111 ETH up front, **plus an annuity on all future pool volume** |

Two very different lines. Published research on pump.fun found only **~0.63%** of tokens graduate, so the annuity is built by a small tail and the flat creation fee has to carry the rest.

## Levers and their guardrails

| Lever | Range | Retroactive? |
| --- | --- | --- |
| `creationFee` | any | future launches |
| `tradeFeeBps` | 0 to 10% | **future launches only** |
| `protocolFee` | 0, or 4 to 10 (25% down to 10%) | future graduations |
| `setPoolProtocolFee` | per pool | ⚠️ **yes, retroactive on a live pool** |
| `treasury` | any | future collections |

⚠️ **`setPoolProtocolFee` is the one retroactive lever.** Everything else is frozen-at-creation by design, but this changes the economics of a pool people are already trading. A governance consideration for when `SAFE` becomes a real multisig.

## Two honest caveats

**Streams 3 and 4 accrue but do not self-deliver.** Both `LPLock.collect` and `collectProtocolFees` are permissionless, but somebody has to call them, or fees sit in the pool indefinitely. No scheduled sweep is built. This is the one concrete use case for a scheduler.

**Only stream 4 is proven on-chain.** `LPLock.collect` was verified sweeping fees to treasury with principal and ownership untouched. `applyProtocolFee` is applied at graduation and tested, but `collectProtocolFees` has never been observed sweeping real fees from a live pool.

---

# Open questions

⚠️ **This is a live, unfinished discussion.** The user asked to settle tokenomics in detail before further building, on the correct reasoning that the contracts are frozen but **unaudited**, so this is the cheapest moment to change them.

**1. There is no creator fee share, and it is the biggest strategic gap.** ⬅️ *recommended starting point*
pump.fun pays creators **0.05% of all trading fees**, and since January 2026 lets them split it across up to 10 wallets, transfer coin ownership and revoke update authority.
That is the entire supply-side growth engine: it is why people launch there rather than elsewhere.
We pay creators nothing, so we are asking them to launch for love.
It interacts directly with the revenue model above, because a creator share has to come out of either the 1% curve fee or the pool fee, and which one is a real decision.

**2. `createLaunch` has no dev-buy.**
It is `payable` but only for the fee, and refunds any excess. A creator wanting the first tokens must send a second transaction, during which a bot can front-run them into the cheapest supply.
Anti-snipe caps the damage at 8M / 0.025 ETH, but the creator still does not get first position on their own launch. Every competitor bundles this.

**3. Is 10 ETH the right bar?**
The shape is right; the absolute number is a dollar-denominated call against the current ETH price and is the user's.
Higher means fewer graduations, deeper pools, more serious launches. Lower means more graduations, thinner pools, more churn and more fee volume.

**4. Zero protocol token allocation.**
Recommendation: **keep it at zero.** It is the cleanest version of the no-pre-mine promise and it is what the locked LP already signals. Revenue comes from fees, and stream 4 is already a perpetuity on every graduated pool.

**5. Anti-snipe at 15 wallets.** See the figures above.

⚠️ **Questions 1 and 2 are contract changes**, which is exactly why they are being settled now rather than after an audit.
