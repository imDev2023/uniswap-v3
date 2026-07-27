# Audit scope — Octopus launchpad contracts

Prepared at the end of build #24 (Build 11 / Stage 1), when the contract surface was frozen for review.

Everything here is under `contracts/src/`. The AMM underneath is **unmodified Uniswap V3**, deployed
byte-for-byte from the audited upstream artifacts via `vm.getCode`. We run our own instance and own
the factory, but we did not write an AMM and it is not what needs reviewing.

## What we wrote (the actual review surface)

| Contract | Runtime size | Role |
|---|---:|---|
| `LaunchpadFactory.sol` | 15,942 B | Entry point. Deploys the token + curve, escrows the graduation reserve, owns the tunable params and the V3 protocol-fee switch. |
| `BondingCurve.sol` | 4,623 B | Constant-product curve over virtual reserves. Buy/sell, anti-snipe cap, and the graduation trigger. |
| `periphery/GraduationManager.sol` | 3,651 B | The atomic curve → V3 pool handoff. |
| `periphery/LPLock.sol` | 1,056 B | Permanent custodian for graduated LP NFTs. |
| `LaunchToken.sol` | 2,086 B | Fixed-supply ERC-20. No mint, no owner, no setters. |

Test suite: `cd contracts && forge test` — 84 tests, including fork tests against live testnet 46630.

> **Build settings are part of what you are reviewing.** `solc 0.8.24`, `evm_version = paris`
> (Robinhood Chain is an Arbitrum L2; our bytecode is kept PUSH0-free), **optimizer on, 200 runs**.
> The optimizer was switched on in build #24: without it `LaunchpadFactory` was 27,594 B, over the
> EIP-170 24,576 B limit and deployable only because Orbit relaxes it. Changing any of these changes
> the deployed bytecode, and Blockscout verification must be given the same values.

## Where to spend the most time: the graduation transition

**This is the highest-value target in the codebase and the one place no upstream audit covers.** It
is where our custom curve math meets Uniswap V3, it is irreversible, and it moves 100% of a launch's
raised ETH in a single atomic step inside somebody's ordinary buy transaction.

The path: `BondingCurve.buy()` detects the crossing buy → `_graduate()` → `GraduationManager.graduate()`
→ creates + initializes the V3 pool, mints a full-range position straight into `LPLock`, applies the
protocol fee. All in one transaction. If any of it is wrong, the failure is permanent — the LP is
locked by design and there is no recovery path.

Three specific things we would most like challenged:

### 1. Refund arithmetic on the crossing buy

`BondingCurve.buy()`, the `crossing` branch. The buy that completes the 800M allocation is capped at
exactly the remaining allocation, charged only the ETH needed to drive reserves to their calibrated
final values, and refunded the rest.

The subtle part is the fee gross-up:

```solidity
uint256 netNeeded  = finalEthReserve - ethReserve;
uint256 grossNeeded = Math.ceilDiv(netNeeded * BPS, BPS - tradeFeeBps);
if (grossNeeded > msg.value) grossNeeded = msg.value;   // clamp
fee    = grossNeeded - netNeeded;
refund = msg.value - grossNeeded;
```

`previewTokens >= remaining` guarantees `msg.value >= netNeeded`, but the fee floor and this `ceilDiv`
gross-up may not compose to the wei — hence the clamp, so an honest buy sized to exactly complete the
curve cannot underflow-revert on the refund.

**We probed this ourselves and the clamp IS reachable — please verify our characterisation rather
than re-deriving it.** `grossNeeded` is a `ceilDiv` and the fee is a floor division; between them
there is a sliver of slack, so sending `grossNeeded - 1` still yields enough tokens to cross and the
crossing branch runs with `msg.value < grossNeeded`. What we believe matters is *where the missing
wei comes from*:

- the **raise is untouched** — the GraduationManager still receives exactly `finalEthReserve -
  virtualEthReserve`, so the pool is seeded at the intended price and no buyer is short-changed;
- the **protocol's own fee** absorbs the shortfall, coming out one wei lighter;
- the slack is a rounding sliver, not a discount — underpaying by 1000 wei does not cross at all, so
  nobody can graduate a launch (and seize the whole remaining allocation) below calibration.

Pinned in `test/CrossingBuyBoundary.t.sol`, which brackets the boundary from both sides and fuzzes
the invariant across every overpayment size. **The questions we would most like answered: is the
shortfall genuinely bounded at one wei, or can it be widened — by a different `tradeFeeBps`, a
retuned `virtualEthReserve`, or a partially-filled curve where `ethReserve` is not virgin? And is
there any sequence that makes it repeatable rather than once-per-launch?**

Also note the ordering: the refund is sent **before** `_graduate()`, specifically so refunded ETH is
never seeded into the pool.

### 2. Curve rounding direction

`_previewBuy` / `_previewSell` both round the *new* reserve up (`Math.ceilDiv`) so the trader's output
rounds down. The intent is that rounding never favours extraction, in either direction, at any size.
We would like this confirmed adversarially rather than assumed — particularly whether a long sequence
of dust trades can accumulate value against the curve.

Related: `finalEthReserve = ceilDiv(k, finalTokenReserve)` makes the graduation target 3 × `V_eth`
**plus up to one wei**. We believe that direction is correct (favours the protocol). Pinned in
`test_LaunchCreated_CapAndGraduationTargetDerivableFromLog`.

### 3. Price continuity and seed integrity at the handoff

`GraduationManager.graduate()` initializes the pool at `sqrt(amount1/amount0) * 2**96`, which is
exactly the ratio of the two seeded amounts — and the curve's calibration
(`DEFAULT_VIRTUAL_TOKEN_RESERVE = CURVE_SUPPLY² / (CURVE_SUPPLY − GRADUATION_RESERVE)`) is what makes
that equal the curve's final marginal price. **Does continuity actually hold for every reachable
`virtualEthReserve`**, including the retuned testnet calibration, and is `uint160` truncation of the
sqrt ever lossy enough to matter?

Two deliberate anti-donation choices to sanity-check:
- the curve forwards the **calibrated** raised amount (`finalEthReserve - virtualEthReserve`), not its
  balance, so ETH force-fed via `selfdestruct` cannot inflate the seed;
- the manager seeds the factory's `GRADUATION_RESERVE` **constant**, not `balanceOf`, so donated
  tokens cannot skew the initial price.

Both leave surplus stranded on purpose. Confirm stranding is the worst outcome.

## Also worth review

- **`LPLock` is a lock by structure, not policy.** It holds no function that transfers, burns,
  approves, or calls `decreaseLiquidity`. Please verify there is genuinely no path — including via
  `onERC721Received` or the position manager — to move principal or the NFT.
- **Anti-snipe (`decision #7`).** The cap window is snapshotted *before* `tokensSold` is mutated, so a
  single buy cannot cross the threshold to escape its own cap. `purchasedOf` is gross and is **not**
  decremented on sell, blocking buy-sell-rebuy evasion. Exercised on-chain across six wallets.
- **`Ownable2Step` + future-only params.** `setCurveParams` / `setCreationFee` / `setProtocolFee` bind
  only at `createLaunch` time and are frozen into curve immutables. Confirm no path lets an owner
  change an in-flight launch's economics.
- **`applyProtocolFee` is best-effort by design** — if the launchpad does not own the V3 factory it
  emits `ProtocolFeeSkipped` rather than reverting, so a fee-switch misconfiguration can never brick a
  graduation.
- **`LaunchToken.launchpad`** records the deploying factory (`msg.sender`), so a token can be resolved
  to its curve from the token address alone. The launchpad is a factory and the intended way to change
  how launches work is to deploy a v2 rather than upgrade in place, so more than one factory may exist
  and a token address alone would otherwise not imply which one made it.

## Known and accepted (please confirm, don't re-report)

- **`BondingCurve.treasury` is `immutable` and the fee send reverts on failure.** It is on every buy
  and sell path, so a treasury that cannot receive ETH would brick trading for every curve created
  while it was set — and because the value is frozen per-curve, `setTreasury` could not repair them.
  Accepted as an **owner operational constraint**: the treasury must always be a plain-ETH-receiving
  address (on mainnet, a Safe multisig). We chose not to add accrual logic to the hot trading path,
  on the grounds that it adds more audit surface than it removes. Note `LPLock` deliberately does the
  opposite and reads the treasury live, because it is not on a hot path.
- **`metadataURI` is permanent with no setter, and unvalidated.** A mistyped or unpinned URI can never
  be corrected, and abusive imagery cannot be removed on-chain. Both are intentional (it is the same
  no-rug guarantee the locked LP makes); moderation is a frontend denylist.
- **No pause, no emergency stop, anywhere.** Deliberate.
- **`collectProtocolFees` and `LPLock.collect` are permissionless.** Funds can only ever reach the
  treasury, so anyone triggering them is harmless.

## Coverage of the two historically-thin areas

Both are now covered by tests; the caveat is *where* they are covered.

- **Production-scale (~90 ETH) graduation** — covered in `test/Graduation.t.sol`
  (`test_FullLifecycle_AtomicGraduation`), which runs the full production calibration against a real
  Robinhood Chain fork with our own unmodified V3 deployment, and asserts price continuity, the
  ~200M/~90 WETH seed, and the locked position NFT. **Not** exercised on live testnet: every on-chain
  testnet graduation ran the retuned 0.1 ETH calibration, because funding 90 ETH of testnet buys is
  impractical. The arithmetic is identical; the magnitudes are not.
- **Same-block races** — covered in `test/SameBlockRaces.t.sol`: two wallets buying in one block, the
  anti-snipe cap counting cumulatively within a block, buy-sell-rebuy inside a single block failing to
  refresh the cap, and both a buy and a sell losing the race to the crossing buy. **Not** exercised on
  live testnet, because you cannot reliably force two wallets into a chosen block on demand. Note
  Robinhood Chain's ~0.3s blocks make same-block contention the normal case, not an exotic one.

## Not exercised anywhere

- **Real adversarial MEV** — reordering, sandwiching, or censoring within a block. The anti-snipe cap
  is a per-wallet accumulation limit, not an MEV defence, and does not claim to be one.
