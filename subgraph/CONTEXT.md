# Indexing

The read model, derived entirely from Launchpad events with no on-chain calls.
Nothing here is authoritative: the chain is the source of truth and this is a cache that happens to be queryable.
That framing is load-bearing - losing this database is an availability incident, not data loss.

## Language

### The model

**Trade**:
One buy or sell against a Curve. Immutable once recorded.
_Avoid_: transaction (one transaction may contain several), swap (a swap happens in a Pool, after graduation, and is **not** indexed here)

**Curve Position**:
An address's net stake in one Curve, netted from its own buys and sells. Blind to transfers, and frozen forever once the Launch graduates.
_Avoid_: **holder**, holding, balance, ownership - a Curve Position is not a claim about who holds the token

**Rollup**:
A running total across every Launch - counts, cumulative volume, cumulative ETH raised.
_Avoid_: stats, aggregate, factory

**Progress**:
How far a Curve has moved toward graduation, measured as tokens sold against the Curve Allocation.
_Avoid_: completion, fill, percent sold

### Trust and freshness

These exist because the read model can be confidently wrong, and every term here was learned from an incident.

**Lag**:
How far behind the chain the read model actually is. The only honest measure is the difference between two chain timestamps, or between two block heights - never a self-reported status flag.
_Avoid_: sync status, delay

⚠️ Express Lag in **seconds**, not blocks, anywhere a human or an alert reads it. Block counts are not comparable across chains with different block times, so the same real staleness reads ~3x larger on a faster chain.

**Canonicity**:
Whether the block the read model believes is the head is the block the chain actually has at that height. A read model can be perfectly healthy, fully caught up by its own account, and building on a chain that no longer exists.
_Avoid_: validity, correctness

**Orphaned**:
The state of a read model whose head is on a discarded branch. It outranks Lag as a diagnosis, because an orphaned model is also far behind, and reporting only the Lag describes a permanent deadlock as a temporary delay.
_Avoid_: stale, behind, desynced

**Stale** / **Down**:
Two different failures with two different remedies. Stale means reachable and answering, but behind - it returns successful, empty, wrong answers. Down means unreachable and erroring.
_Avoid_: unavailable, offline, broken

⚠️ **Stale is the more dangerous of the two and the harder to notice.** A Down read model produces errors that surfaces already handle. A Stale one answers `[]` cheerfully, which then gets rendered as the assertion "nobody has traded".

## Resolved

### ✅ `Holder` does not mean holder - **settled 2026-08-01: the word was wrong, not the model**

The model records **Curve Positions** - net tokens bought from a Curve, minus tokens sold back to it - and both the schema and the UI called this a `Holder`, with a `holderCount`.

It is not a holder of the token:

- A Curve Position ignores ERC-20 transfers entirely. Buy on the Curve, send the tokens to someone else, and the model still names **you** as the holder and them as nobody.
- It ignores the Pool. After graduation the Curve stops accepting trades forever, so every Curve Position freezes permanently - while the actual holders change with every swap. A graduated Launch's "Holders" panel was a snapshot of who once bought on the curve, presented as current fact.
- ⚠️ Since #34 it ignores the **Dev Allocation**. A creator's 0-5% carve is free, not a Curve buy, so it emits no `Bought` and the creator reads as **0% concentration while holding up to 40M tokens**. This is the sharpest of the three, because creator concentration is precisely what the panel exists to disclose. Fixed in #36, which indexes the allocation from the factory.
  ⚠️ Since #35 the carve is also **held by `DevVesting`, not by the creator**, and releases linearly from graduation ([ADR-0007](../docs/adr/0007-vesting-runs-from-graduation.md)). **Settled 2026-08-05: concentration is TWO numbers**, `devAllocation` (granted, the headline) and `devClaimed` (actually released), shown together. They diverge for the whole vesting window.
  ⚠️ **There is deliberately no `devVestedSoFar` field.** Vested-so-far is a continuous function of wall-clock time and this context only writes when an event fires, so any stored figure is silently stale between trades - worst on a quiet launch, where it would be most trusted. Clients compute it from `devAllocation`, `vestingDuration` and `graduatedAtTimestamp`.
  ⚠️ **Log order is load-bearing.** `LaunchCreated` → `LaunchConfig` → `GrantRegistered` inside the one creation transaction, because the first handler creates the entity the others load. Pinned by `contracts/test/LaunchConfig.t.sol`, not by the manifest - handler order in `subgraph.yaml` does not control dispatch order.
  ⚠️ **`GrantRegistered` is NOT indexed**, though `DevVesting` is a fixed-address source and indexing it would be free. It duplicated fields `LaunchConfig` already owns, could not act as a fallback (a zero carve emits no grant), and was untestable - the handler could be gutted to a no-op with the whole suite green. See `src/dev-vesting.ts`.

**Decision: keep the model, change the words.** Indexing ERC-20 transfers to make "holder" literally true was considered and declined - it is a new data source, new mappings and new tests, a subproject rather than a ticket, and it buys accuracy on a panel that is not on the trade path.

✅ **Complete.** #36 shipped the schema rename - `Holder` is now `CurvePosition`, `holderCount` is `curvePositionCount` - and #37 finished the job on the frontend: the identifiers (`CurvePositionRow`, `CURVE_POSITIONS_QUERY`, `fetchCurvePositions`, `useCurvePositions`, `CurvePositionsCard`), the visible copy, and the FINAL-versus-current distinction a graduated launch's panel now states outright.

⚠️ **The dev allocation is no longer read from here.** #37 moved it, and the lock terms with it, to direct chain reads: every one of those values is frozen at `createLaunch` and can never change, so this context was only ever a second route to the same immutable facts - and gating the panels on it meant an outage removed them from the page entirely. What this context still uniquely owns is the realised `Lock` record, which exists only after graduation.

## Open questions

### The aggregate has no name

The Launchpad calls it a **Launch** (`createLaunch`, `launchCount`, `LaunchCreated`). This context calls it a `Token` and keys it by the token address. The UI calls it a **curve**.

`Token` is the weakest of the three: the entity carries curve reserves, progress, trade counts and graduation state, none of which are properties of an ERC-20.

### `amountEth` means two different things

On a buy it is gross ETH paid; on a sell it is net ETH received. One field, two definitions selected by a sibling field.
Anything that sums it across mixed trade types is adding incomparable quantities - a mistake this context has already made once and corrected.
