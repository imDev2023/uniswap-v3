# Launchpad

The on-chain domain, and the source of truth for everything else.
A creator launches a token; it trades on a bonding curve until it has raised a fixed amount of ETH, at which point it moves atomically into a locked Uniswap V3 pool.

## Language

### The aggregate and its parts

**Launch**:
One creator's token together with the market that prices it, from creation through graduation and beyond. The aggregate everything else is a view of.
_Avoid_: project, coin, listing

**Launch Token**:
The ERC-20 a Launch mints. Fixed supply, zero protocol allocation, and it outlives the Curve.
⚠️ Not "no pre-mine" since #34: a creator may take 0-5% of the curve supply as a free **Dev Allocation**, vested from Graduation.
_Avoid_: coin, asset

**Curve**:
The bonding-curve market that prices a Launch before graduation. One per Launch, and it stops accepting trades forever once it graduates.
_Avoid_: pool (a pool is what a Curve becomes), market maker, AMM

**Pool**:
The Uniswap V3 TOKEN/WETH pool a Launch graduates into. Distinct from the Curve in every way except purpose.
_Avoid_: curve, pair

**Creator**:
The address that called `createLaunch`. Has no privilege over supply or pricing - no mint, no curve setter, no withdrawal of anyone's funds. Since #33 the Creator does hold two rights over their own graduated position: `LPLock.extend` (which can only ever lengthen the lock) and a 70% share of that position's LP fees, frozen at graduation.
_Avoid_: owner, deployer, dev

### Pricing

**Virtual Reserve**:
Reserve amounts the Curve prices against but does not hold. They set the opening price and make the curve continuous from its very first buy.
_Avoid_: fake reserve, seed liquidity

**Curve Allocation**:
The share of total supply the Curve will ever sell. Progress toward graduation is measured against this, not against total supply.
⚠️ Since #34 it is **per Launch**, not a constant: the Dev Allocation is carved out of it, so it ranges from 760M to 800M. Read it off the Launch, never from a constant.
_Avoid_: circulating supply, float

**Dev Allocation**:
The Creator's free share of the Curve Allocation, 0% to 5%, chosen once at creation.
Carved out of the Curve Allocation and never out of the Graduation Reserve, so the Pool is never thinned.
Vested linearly from Graduation, never from creation.
⚠️ Not yet visible as a Holder: the read model derives holders from Curve trades only, so a Dev Allocation shows as 0% concentration until #36 indexes it.
_Avoid_: pre-sale, team tokens, creator buy (it is not a purchase, so the anti-snipe cap is not involved)

**Graduation Reserve**:
The share of total supply held back from the Curve and seeded into the Pool at graduation.
_Avoid_: liquidity allocation, treasury allocation

**Crossing Buy**:
A single buy large enough to take the Curve past its graduation threshold. It is filled up to the threshold, graduates the Launch, and refunds the remainder.
_Avoid_: final buy, overflow buy

### Graduation

**Graduation**:
The atomic transition from Curve to Pool: the Curve closes, the Pool is created and seeded, and the resulting liquidity position is locked. It either happens completely or not at all.
_Avoid_: listing, migration, launch (a Launch is created, not graduated)

**LP Lock**:
The custody of a graduated Launch's liquidity position. Fees can be swept at any time, split 70/30 to the Creator and the Treasury.

⚠️ **Not permanent any more, and the change is load-bearing.** Before #33 the principal could never be withdrawn by anyone, and that was verifiable by reading the bytecode and finding no capability to do it. Since #33 the lock runs 1 year by default (Creator-selectable as permanent at creation, and extendable but never shortenable), and an expired lock on a Pool with no activity for `inactivityPeriod` can be wound up by anyone via `reclaim`. The guarantee is now **conditional** - enforced by guards rather than by absence - so say "locked", never "locked forever", unless the specific position chose the permanent sentinel.
_Avoid_: liquidity lock (ambiguous - a Pool also holds third-party liquidity, which is **not** locked), vesting

⚠️ **"Locked liquidity" is a claim about our position only.** A graduated Pool also accepts third-party liquidity that its providers can pull at will. Say **launch liquidity** when the distinction matters, which is anywhere a person is deciding whether to trust the Pool.

### Fairness guarantees

**Anti-snipe**:
A per-wallet cap on how much of a Curve one address may buy, which lifts automatically once the Curve has sold past a set level. Measured on lifetime tokens bought, so selling and re-buying does not reset it.
_Avoid_: whale limit, rate limit, cooldown

**Metadata URI**:
A pointer, stored on the Launch Token at creation, to an off-chain JSON document describing the Launch. It has **no setter, for anyone, ever**.
_Avoid_: image URL, token URI, metadata (the metadata is the document; this is only the pointer)

⚠️ Immutability is the point, not an oversight: it rules out a bait-and-switch where clean art at launch is swapped after people buy. The cost is that a typo or an unpinned document is permanent and uncorrectable.

### Roles

**Treasury**:
The address that receives creation fees, curve trade fees, the pool protocol fee, its 30% share of swept LP fees, and the proceeds of any `reclaim`. Owner-updatable, forward-looking only.
_Avoid_: owner, dev wallet

**Curve Params**:
The pricing and fairness settings a Launch is created with. They are **frozen into each Launch at creation**, so retuning affects only future Launches and can never change a Launch that already exists.
_Avoid_: config, settings, global params (they are per-Launch the moment a Launch exists)

## Naming that is load-bearing, not cosmetic

**Octopus** is the product. The AMM underneath is **unmodified Uniswap V3**, deployed byte-for-byte from the audited artifacts.
Product surfaces may be rebranded freely. References that name real upstream software - dependency names, interface names, artifact paths, licence headers - **must not be renamed**: they identify someone else's software and carry licence obligations.
_Avoid_: calling the AMM "ours", calling Octopus "a Uniswap fork"
