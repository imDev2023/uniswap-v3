# Tokenomics and revenue model

Every number here was read off the deployed contracts or computed from them, not recalled.
Figures are given at the **agreed 10 ETH mainnet graduation target**.

✅ **The tokenomics discussion opened on 2026-08-01 was completed on 2026-08-02.**
Every decision is recorded under [Settled decisions](#settled-decisions).
Nothing has been built yet: this document is the spec, not a description of the deployed system.

⚠️ **The deployed contracts no longer match this document.**
The settled decisions require contract changes, so the sections below describe the *intended* system.
Where the two differ it is called out explicitly.

⚠️ **The contract freeze is over**, as a direct consequence of these decisions.
It was always justified as "do not redo frontend work against a shifting data shape", and the data shape is now shifting on purpose.

## Supply

| | value | share |
| --- | --- | --- |
| Total supply | 1,000,000,000 | fixed, no mint function exists |
| Sold on the bonding curve | 760,000,000 to 800,000,000 | 76% to 80%, depends on the dev allocation |
| Seeded into the pool at graduation | 200,000,000 | 20% |
| **Creator (dev) allocation** | **0 to 40,000,000** | **0% to 5% of curve supply, creator's choice, free, vested** |
| Protocol / treasury allocation | **0** | 0% |

Source: `LaunchpadFactory.CURVE_SUPPLY` / `GRADUATION_RESERVE`.
⚠️ Deployed today: curve supply is a fixed 800,000,000 and there is no dev allocation.

⚠️ **"Only 800M is tradable" is a misreading that comes up.**
All 1B trades.
The curve allocation is held by curve buyers and sells freely into the pool after graduation; the 200M *is* the pool's token-side inventory, which is what anybody buys from.
A pool needs both sides.
What is locked is the **LP position**, not the tokens' tradability.

## Price and value at a 10 ETH graduation

At a 0% dev allocation:

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

## ⚠️ The invariant that must never be broken

This explains why `virtualTokenReserve` is deliberately not tunable through `setCurveParams`:

```
200,000,000 tokens x 5.0e-8 (graduation price) = 10.000000 ETH = exactly the raise
```

The curve's **final marginal price is exactly the pool's opening price**, and the 200M reserve valued at that price is **exactly balanced** against the raised ETH.
So there is no price gap at graduation, no lopsided pool, and no arbitrage gift to the first person to swap.

### What the invariant actually constrains (corrected 2026-08-02)

An earlier version of this document said the 16x multiple and the 5x FDV/raise ratio were "structural, not settings", and that the 800/200 split could not move.
**That was too strong.**
Both were derived numerically across five different splits.

Writing `C` for the curve allocation and `G` for the graduation reserve, the invariant `G x gradPrice == raise` holds for **any** `C` and `G`, provided:

```
V_tok = C^2 / (C - G)
```

which is exactly how `DEFAULT_VIRTUAL_TOKEN_RESERVE` is already defined.
Two exact closed forms fall out:

```
price multiple  =  (C / G)^2            ->  (800M / 200M)^2  =  16.00x
FDV / raise     =  TOTAL_SUPPLY / G     ->  1e27 / 200M      =   5.00x
```

So the FDV/raise ratio depends on **nothing but the pool reserve `G`**, and the price multiple on **nothing but the ratio `C/G`**.
Both are tunable after all.
What remains true is that retuning `virtualEthReserve` alone scales every absolute price and moves **neither** number: `V_eth` is the graduation-target knob and only that.

### Calibration arithmetic

`ETH-to-graduate = 3 x virtualEthReserve` is an **approximation and is off by one wei for most targets**.
Do not size a calibration with it.
The true amount is:

```
ceilDiv(V_eth x V_tok, V_tok - C) - V_eth
```

and to solve for a desired target directly:

```
V_eth = target x G / (C - G)
```

The counter-intuitive result is that **repeating-decimal targets are the exact ones**: `V_eth = target/3` truncates and the `ceilDiv` recovers precisely what the truncation lost.
Both chosen targets land exactly: **1 ETH testnet** and **10 ETH mainnet**.
Rounder-looking targets such as 1.5, 3, 9 or 12 come out one wei over.
Full table in `docs/deployments-testnet.md`.

## The dev allocation

**Free, creator-selected from 0% to 5% of curve supply, carved out of the curve allocation, and vested linearly from graduation.**

Carving it out of `C` (rather than out of the 200M pool reserve, which would thin the pool and move the FDV ratio) means `virtualEthReserve` must be **re-solved per launch** to hold the 10 ETH target:

| dev | curve supply `C` | `virtualEthReserve` for a 10 ETH target | price multiple `(C/G)^2` | FDV/raise |
| --- | --- | --- | --- | --- |
| 0% | 800M | 3333333333333333333 | **16.00x** | 5.00x |
| 1% | 792M | 3378378378378378378 | 15.68x | 5.00x |
| 2% | 784M | 3424657534246575342 | 15.37x | 5.00x |
| 3% | 776M | 3472222222222222222 | 15.05x | 5.00x |
| 4% | 768M | 3521126760563380281 | 14.75x | 5.00x |
| 5% | 760M | 3571428571428571428 | **14.44x** | 5.00x |

Two consequences to design for:

1. **The 16x headline is dev-dependent.** It erodes to 14.44x at a 5% allocation. The FDV/raise ratio is untouched, because it depends only on `G`.
2. **`virtualEthReserve` stops being a fixed owner default.** It becomes a per-launch computed value. It is already emitted in `LaunchCreated`, so consumers must read it per launch rather than assume the factory default. The frontend already does this.

### Why it vests, and why from graduation

If the allocation is later sold into the graduated pool (200M tokens + 10 ETH, full-range approximated as `x*y=k`):

| dev | tokens sold in | ETH out | price move |
| --- | --- | --- | --- |
| 1% | 8M | 0.385 | **-7.5%** |
| 3% | 24M | 1.071 | -20.3% |
| 5% | 40M | 1.667 | **-30.6%** |

⚠️ **Vesting delays this, it does not prevent it.**
At the end of any schedule a 5% dev can still take roughly 30% off the price in one transaction.
The only lever that actually blunts it is a **release rate slow enough that the pool absorbs it**, which is why the schedule is linear rather than a cliff: a cliff concentrates the whole move at one moment.

⚠️ **Vesting starts at graduation, never at creation.**
Most launches never graduate.
Vesting from creation would let a dev on a dying curve claim tokens and sell them back into the curve itself, extracting the very ETH other buyers put in.

The vesting duration is owner-tunable and future-only, like every other curve parameter.

## Liquidity

The graduation position is **full range** (`MIN_TICK` / `MAX_TICK` in `GraduationManager`), and it must stay that way.
A concentrated position that drifts out of range becomes 100% one asset and stops providing liquidity.
Capital-inefficient by design; correct for a long-locked position.

20 ETH of pool TVL at graduation is deep relative to pump.fun's commonly-cited $10-15k migrations.
A genuine differentiator, and it follows from seeding the entire raise.

### ⚠️ The locked LP is not a treasury. It is the counterparty to every trade.

This was the single most consequential misunderstanding surfaced by the discussion, and it governs the whole lock design.
The pool does not *hold* the 10 ETH raise on our behalf: that ETH is what sellers are paid with.
As holders exit, the position's composition shifts from ETH toward tokens.

| % of the curve allocation sold back | ETH paid out to sellers | ETH left in the LP |
| --- | --- | --- |
| 0% (just graduated) | 0.000 | **10.000** |
| 25% | 5.000 | 5.000 |
| 50% | 6.667 | 3.333 |
| 90% | 7.826 | 2.174 |
| 100% (everyone exits) | 8.000 | **2.000** |

So an abandoned project's locked LP holds roughly **2 ETH and a billion worthless tokens**.
It never reaches zero (full-range `x*y=k` is asymptotic), but the ETH is gone because the holders took it, which is the mechanism working correctly.

⚠️ **This inverts the value of any unlock right**: unlocking a healthy pool is worth 10 ETH, unlocking a dead one is worth 2 ETH.
A time-only unlock is therefore worth **5x more when abused than when used as intended**, which is why the reclaim mechanism below is gated on measured inactivity rather than on a calendar.

### The lock, as settled

```
lock         1 year by default (owner-tunable, future-only)
             creator may EXTEND at any time; extension is monotonic and can never shorten
             permanent lock selectable at creation
collect()    permissionless throughout, split 70% creator / 30% treasury, unaffected by any of the above
reclaim(id)  permissionless, and requires BOTH:
               block.timestamp > lockUntil
               AND no swap in the pool for >= 180 days (owner-tunable)
             -> WETH to treasury (NOT unwrapped: every other flow in LPLock moves WETH,
                and unwrapping would add a receive() plus a .call that can fail or reenter)
             -> launch tokens to 0x...dEaD
             -> emits Reclaimed(tokenId, token, ethAmount)
```

**Liveness is read from the pool itself**, not tracked by us: `observations[slot0.observationIndex].blockTimestamp` is the timestamp of the last block in which the pool was swapped.
Cardinality is 1 on every pool we create (`initialize` sets it and we never raise it), so the read is always `observations(0)`.
A pool that has never been swapped reports its initialization time, which is exactly right: inactive since graduation.

⚠️ **Two mechanical traps in that read.** The observation timestamp is a `uint32` that wraps roughly every 136 years and the pool's own comparisons are overflow-safe by construction; subtracting it naively from `block.timestamp` is wrong at the boundary.
And the observation is also written by mints and burns, so a dust liquidity change counts as activity, which is an acceptable definition of "responsive".

**Why the proceeds go to treasury and not to an on-chain charity address.**
A settable on-chain beneficiary looks trustless while being mutable, which is strictly worse than an honest treasury: anyone can deploy a fake charity address.
Reclaimed ETH therefore lands in the publicly known treasury and is donated off-chain with published proof.
The `Reclaimed` event is what makes that auditable rather than merely promised: the total ever reclaimed is computable on-chain by anyone, forever, and donations out of treasury are already public transfers.

⚠️ **`reclaim` must be structurally impossible for third-party positions.**
A public LP-locking service for arbitrary pairs is on the roadmap, which would make `LPLock` a custodian of strangers' assets.
Sweeping one of those to our treasury would be theft, not reclamation, and "we only call it on launch positions" is a policy rather than a guarantee.
So lock records carry an **origin** (`Launch` / `ThirdParty`) fixed at lock time, and `reclaim` requires `origin == Launch`.
Deciding this now costs nothing; discovering it later means rewriting a contract that holds other people's money.

## Anti-snipe economics at 10 ETH

Defaults are `maxBuyPerWallet` 8M (1% of curve supply) and `antiSnipeThreshold` 120M (15% of curve supply).

| | |
| --- | --- |
| Cost for one wallet to max the 8M cap at open | **0.025 ETH** |
| Total ETH to reach the 120M lift threshold | **0.42 ETH** (4.2% of the raise) |
| Minimum distinct wallets to traverse the window | **15** |

✅ **Settled: keep as-is and retune from testnet feedback.**
Both values are already owner-tunable and future-only, so this is the only item on the list requiring no contract change at all.

⚠️ Untested at this calibration.
The friction only bites organic launches: a determined sniper simply uses 15 wallets.

⚠️ `maxBuyPerWallet` is a share of **tokens**, so recalibrating the raise does not change it.
Moving the target from 90 ETH to 10 ETH made that same 1% cost roughly **9x less ETH**, so the economic barrier to sniping fell by the same factor.

---

# Revenue model

Four streams, all routed to `treasury`.

## 1. Creation fee, `0.01 ETH` flat

Charged on every `createLaunch` and forwarded to treasury in the same transaction. Excess is refunded.
Paid by **everyone who launches**, including the overwhelming majority that never graduate. The high-frequency line.

## 2. Curve trade fee, `1%` (100 bps)

On both buys and sells, on gross ETH. Hard-capped at 10% in code (`MAX_TRADE_FEE_BPS = 1000`).
A launch that graduates puts 10 ETH net into the reserve, so buyers pay ~10.101 ETH gross: **~0.101 ETH minimum** per graduation, plus fees on every sell and re-buy along the way.

✅ **100% of this stays with the protocol**, and it is the one stream the 2026-08-02 creator fee share deliberately does NOT touch. See [Settled decisions](#settled-decisions) 1 for why the curve fee is excluded.

## 3. Pool protocol fee, `25%` of swap fees, in perpetuity

Graduated pools use the **1% fee tier** (`POOL_FEE_TIER = 10000`), and `protocolFee = 4` means the protocol takes 1/N = 1/4 of each swap's fee:

```
pool charges     1.00% per swap
  -> protocol     0.25%     via collectProtocolFees
  -> LPs          0.75%
```

This is why the launchpad owns the V3 factory: it is what makes the fee switch ours to flip.

## 4. Locked LP position fees

`LPLock.collect()` routes the locked position's accrued fees **70% to the launch's creator and 30% to treasury** (revised 2026-08-02, see [Settled decisions](#settled-decisions) 1), and stays permissionless for the entire life of the lock.
At graduation **we are the only LP**, so the 0.75% LP share is also ours.

A freshly graduated pool therefore earns the protocol **0.475%** of swap volume (0.25% protocol fee + 30% of the 0.75% LP share) and the creator **0.525%**, both diluting toward the bare 0.25% protocol fee as third-party liquidity joins.

⚠️ **This is the dead-project harvest, and it needs no unlock.**
It captures a share of every swap the whole way down as holders exit, across every pool ever graduated, with no key, no discretion and no trust concession. ⚠️ The protocol's cut of it is now **0.475%, not 1%**, so the ~0.08 ETH per fully-exited pool cited before the creator split is roughly halved.

⚠️ **It is no longer a strict perpetuity.**
Under the 1-year default lock a position can eventually be reclaimed, at which point that pool's stream ends.
It remains a perpetuity for any launch whose creator selects the permanent lock or extends indefinitely.

## Shape of the business

| | per launch |
| --- | --- |
| Launched, never graduates | 0.01 ETH + 1% of whatever churned |
| Graduates | ~0.111 ETH up front, **plus 0.475% of all future pool volume** (the creator takes 0.525%) |
| Graduates then dies | the above, plus ~2 ETH of reclaimed liquidity once the lock expires AND the pool has been inactive for 180 days |

Published research on pump.fun found only **~0.63%** of tokens graduate, so the flat creation fee has to carry most of the business.

## Levers and their guardrails

| Lever | Range | Retroactive? |
| --- | --- | --- |
| `creationFee` | any | future launches |
| `tradeFeeBps` | 0 to 10% | **future launches only** |
| `virtualEthReserve` | any | future launches only |
| `maxBuyPerWallet` / `antiSnipeThreshold` | see code | future launches only |
| default lock duration | 30 days to 100 years | future **launches** (frozen at `createLaunch`) |
| inactivity period for reclaim | lengthen only | ⚠️ applies to existing locks, hence monotonic |
| dev allocation bounds (0-5%) | any | future launches only |
| vesting duration | any | future launches only |
| `protocolFee` | 0, or 4 to 10 (25% down to 10%) | future graduations |
| `setPoolProtocolFee` | per pool | ⚠️ **yes, retroactive on a live pool** |
| creator fee share | 0 to 100% | future launches (frozen at `createLaunch`) |
| `treasury` | any | future collections |

⚠️ **Two retroactive levers, and they deserve governance attention** once `SAFE` is a real multisig.
`setPoolProtocolFee` changes the economics of a pool people are already trading.
The reclaim inactivity period changes the terms of locks that already exist, which is the sharper of the two: shortening it brings forward when existing positions become reclaimable.
✅ **Settled 2026-08-02 and implemented in #33: `setInactivityPeriod` is MONOTONIC (lengthen only).**
A timelock and a fixed immutable value were both considered and declined - the first adds state and a second transaction to audit, the second violates the governing principle that every number stays tunable.
The accepted cost is that a mistake is permanent, which is the same trade `extend` already makes.

## Two honest caveats

**Streams 3 and 4 accrue but do not self-deliver.**
Both `LPLock.collect` and `collectProtocolFees` are permissionless, but somebody has to call them, or fees sit in the pool indefinitely.
No scheduled sweep is built. This is the one concrete use case for a scheduler.

**Only stream 4 is proven on-chain.**
`LPLock.collect` was verified sweeping fees to treasury with principal and ownership untouched.
`applyProtocolFee` is applied at graduation and tested, but `collectProtocolFees` has never been observed sweeping real fees from a live pool.

---

# Settled decisions

Settled 2026-08-02. The governing principle throughout: **every number is owner-tunable and future-only**, so testnet feedback can retune the platform with a transaction rather than a redeploy, and no in-flight launch ever changes under a trader.

### 1. Creator fee share: 70% of the graduated pool's LP fees ✅ REVISED 2026-08-02

⚠️ **This reverses the original decision, which read "No creator fee share - creators are paid in supply, not fees."**
Recorded as a reversal rather than edited away, because the reasoning that follows was weighed against the old position.

Creators are paid in **supply and fees**: the dev allocation stands, and on top of it a graduated launch pays its creator a share of pool fees.

```
graduated pool charges 1.00% per swap
  -> 0.25%  protocol fee   (collectProtocolFees)   100% treasury
  -> 0.75%  our locked LP position (LPLock.collect)
         0.525%  ->  creator   (70%)
         0.225%  ->  treasury  (30%)

treasury keeps 0.475% of volume; creator receives 0.525%
```

Three boundaries on it, each deliberate:

1. **The bonding-curve trade fee is untouched and stays 100% protocol.** Sharing it would need per-trade payment to a creator-controlled address on the hottest path in the protocol, where a creator whose `receive()` reverts would brick every buy and sell on their own curve. Sharing it safely means pull-payment, which is a whole accrual mechanism for the least valuable of the streams.
2. **It is a share of what the position ACTUALLY EARNS, not of raw swap volume.** This is what keeps the promise payable: as third-party liquidity joins, our position earns proportionally less of the LP share, and a fraction of "what we collected" scales down with it while a fraction of volume would not.
3. **The ratio is frozen per position at graduation, not read live at collection.** Read live it would be an owner-controlled retroactive lever over a pool that already graduated.

⚠️ **It applies only to launches created through the launchpad.** A fair launch where someone adds their own LP to an Octopus pool is standard, unmodified Uniswap V3: they hold their own position NFT and earn the stock LP share directly. `LPLock` is not involved, and the split is gated on `origin == Launch` so it cannot reach them.

⚠️ **The benchmark this was weighed against was stale in this document and is now corrected.**
It previously read "pump.fun pays creators 0.05% of all trading fees".
That is the **tail** of their schedule, not the headline. As of 2026:

| | total fee | creator share |
| --- | --- | --- |
| pump.fun bonding curve | 1.25% | **0.30%** (24% of the fee) |
| pump.fun graduated pool, small cap (~$88k-$300k) | 1.25% | **0.95%** |
| pump.fun graduated pool, $20M+ | 0.30% | 0.05% |

Their creator share is **inverse to market cap** by design, paying most where the creator's effort matters.
⚠️ We structurally cannot copy the tiering: our curve parameters are frozen at `createLaunch` and there is no market-cap oracle. Anything we do would be a flat share.

Sources: [Pump.fun fees 2026](https://cryptoslate.com/decentralized-exchanges/pump-fun-review/), [Project Ascend](https://blockworks.com/news/pumpdotfun-fee-model).

Matching their curve split would have paid a creator roughly **0.024 ETH** per 10 ETH graduation.
The dev allocation is worth far more to them and costs us no revenue, which is why it was chosen instead.

### 2. Dev allocation: free, 0-5%, creator-selected, vested ✅

Supersedes the earlier "bundled dev-buy" framing. See [The dev allocation](#the-dev-allocation).

⚠️ **This is a pre-mine, and it retires the "no pre-mine, identical to pump.fun" claim.**
Recorded here so it is a decision rather than a drift. It is reversible on testnet: set the maximum to 0%.
The **protocol** allocation remains zero, so the no-protocol-premine promise is untouched.

⚠️ It also supersedes the anti-snipe question that was being asked about a bundled dev-buy: a free allocation is not a purchase, so `maxBuyPerWallet` is not involved.

### 3. LP lock: 1 year default, extendable, permanent optional, reclaim gated on inactivity ✅

See [The lock, as settled](#the-lock-as-settled).

### 4. Reclaim proceeds go to treasury, donated off-chain with published proof ✅

Not to an on-chain charity address. Reasoning recorded above.

### 5. Zero protocol token allocation ✅

Unchanged. Revenue comes from fees.

### 6. Anti-snipe unchanged, retune from testnet feedback ✅

### 7. Graduation target stays 10 ETH mainnet / 1 ETH testnet ✅

Sanity-checked against the benchmark at an ETH price of roughly **$1,867** (2026-08-02):

| | ETH | USD |
| --- | --- | --- |
| Graduation raise | 10 | ~$18,700 |
| FDV at graduation | 50 | ~$93,000 |
| Pool TVL at graduation | 20 | ~$37,000 |

pump.fun graduates at a **~$69,000 market cap** on roughly 70-85 SOL, so we sit slightly above them on both figures, in the same band.

⚠️ **Our bar is denominated in ETH and theirs is effectively in dollars.**
If ETH doubles, our graduation bar doubles in dollar terms and the graduation rate collapses; if ETH halves, pools get thin.
`setCurveParams` is future-only so retuning is always available, but it needs someone actually watching.
That is an ops commitment, not a contract feature.

### 8. Mainnet calibration takes route (A) ✅

Change `DEFAULT_VIRTUAL_ETH_RESERVE` to **`uint256(10 ether) / 3`**.
Resolved for free: the only argument for route (B) was preserving a contract freeze that these decisions have already ended.

⚠️ The `uint256(...)` cast is required and was verified, not assumed.
Plain `10 ether / 3` **fails to compile**: solc evaluates it as an arbitrary-precision `rational_const` and refuses the implicit conversion.
⚠️ **Never write the literal `3333333333333333333`.** These constants are runs of a single repeating digit and cannot be checked by eye; a 25-digit version was pasted by accident during the discussion, a 10^6 error that would have set graduation at 10,000,000 ETH and made every launch permanently ungraduatable.

---

# What this costs to build

Roughly **7 tickets on top of** the ~9-9.5 already estimated in `CLAUDE.md`, so **~16-17 total, 8-9 days** at the measured cadence of 8 tickets in 4 days.

| Work | Est. tickets |
| --- | --- |
| `LPLock` rewrite: per-position expiry, extend, permanent, origin tag, liveness-gated reclaim, `Reclaimed` event | 1.5 |
| Dev allocation: carve from `C`, per-launch `virtualEthReserve` solve, vesting component, `claim()` | 2 |
| New `LaunchConfig` event + subgraph schema, mappings, matchstick | 1 |
| Frontend: create form (dev %, lock choice), token page (lock status, vesting, reclaim state) | 1.5 |
| Fork tests, full testnet redeploy, Blockscout re-verify, re-seed the board | 1 |

⚠️ **The testnet redeploy is mandatory and repeats the #24 experience.**
Every address in `CLAUDE.md` moves, the subgraph `startBlock` moves, all three contracts need re-verifying, and the board needs re-seeding.
`CALIB` and the other 16 launches become historical.

### Two architectural notes that make it cheaper

**Emit a second event; do not widen `LaunchCreated`.**
That event already carries 12 fields, and `_emitLaunchCreated` exists *purely* because inlining it overflows the EVM's 16-slot reachable stack.
Its own comment records that switching to `viaIR` was rejected as too disruptive pre-audit.
A separate `LaunchConfig` event from the same fixed-address data source has no stack problem and the subgraph handles both identically.

**Beware the same-block dynamic data source.**
Anything the factory triggers on the curve *in the creation transaction* fires before the `BondingCurve` template exists as an indexed source.
Whether graph-node 0.40.2 matches it is unverified, and there is no evidence either way on our own chain because `SeedTestnet.s.sol` uses `--slow` to keep creates and buys in separate blocks.
Emit anything that matters from the **factory**, which is a fixed-address source that is always indexing and cannot miss its own event.

---

# Roadmap items raised but deliberately not scoped

- **Public LP locking service** for arbitrary pairs (Uniswap or elsewhere), not just our own graduation positions. Drives the `origin` tag decision above. Not built now.
- Lending and borrowing, a general DEX surface, loans. All future; the current focus is the exchange and launchpad only.
