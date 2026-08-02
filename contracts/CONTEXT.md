# Launchpad

The on-chain domain, and the source of truth for everything else.
A creator launches a token; it trades on a bonding curve until it has raised a fixed amount of ETH, at which point it moves atomically into a permanently-locked Uniswap V3 pool.

## Language

### The aggregate and its parts

**Launch**:
One creator's token together with the market that prices it, from creation through graduation and beyond. The aggregate everything else is a view of.
_Avoid_: project, coin, listing

**Launch Token**:
The ERC-20 a Launch mints. Fixed supply, no pre-mine, and it outlives the Curve.
_Avoid_: coin, asset

**Curve**:
The bonding-curve market that prices a Launch before graduation. One per Launch, and it stops accepting trades forever once it graduates.
_Avoid_: pool (a pool is what a Curve becomes), market maker, AMM

**Pool**:
The Uniswap V3 TOKEN/WETH pool a Launch graduates into. Distinct from the Curve in every way except purpose.
_Avoid_: curve, pair

**Creator**:
The address that called `createLaunch`. Has no special privileges afterwards - no mint, no setter, no withdrawal.
_Avoid_: owner, deployer, dev

### Pricing

**Virtual Reserve**:
Reserve amounts the Curve prices against but does not hold. They set the opening price and make the curve continuous from its very first buy.
_Avoid_: fake reserve, seed liquidity

**Curve Allocation**:
The share of total supply the Curve will ever sell. Progress toward graduation is measured against this, not against total supply.
_Avoid_: circulating supply, float

**Graduation Reserve**:
The share of total supply held back from the Curve and seeded into the Pool at graduation.
_Avoid_: liquidity allocation, treasury allocation

**Crossing Buy**:
A single buy large enough to take the Curve past its graduation threshold. It is filled up to the threshold, graduates the Launch, and refunds the remainder.
_Avoid_: final buy, overflow buy

### Graduation

**Graduation**:
The atomic transition from Curve to Pool: the Curve closes, the Pool is created and seeded, and the resulting liquidity position is locked forever. It either happens completely or not at all.
_Avoid_: listing, migration, launch (a Launch is created, not graduated)

**LP Lock**:
The permanent custody of a graduated Launch's liquidity position. Fees can be swept to the treasury; the principal and the position itself can never be withdrawn by anyone.
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
The address that receives creation fees, curve trade fees and swept pool fees. Frozen at deployment.
_Avoid_: owner, dev wallet

**Curve Params**:
The pricing and fairness settings a Launch is created with. They are **frozen into each Launch at creation**, so retuning affects only future Launches and can never change a Launch that already exists.
_Avoid_: config, settings, global params (they are per-Launch the moment a Launch exists)

## Naming that is load-bearing, not cosmetic

**Octopus** is the product. The AMM underneath is **unmodified Uniswap V3**, deployed byte-for-byte from the audited artifacts.
Product surfaces may be rebranded freely. References that name real upstream software - dependency names, interface names, artifact paths, licence headers - **must not be renamed**: they identify someone else's software and carry licence obligations.
_Avoid_: calling the AMM "ours", calling Octopus "a Uniswap fork"
