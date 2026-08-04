# 7. Dev vesting runs from graduation, and the vault reads that date rather than being told it

Date: 2026-08-04
Status: Accepted (implements settled decision 2 of [`docs/tokenomics.md`](../tokenomics.md#settled-decisions))

## Context

[ADR-0006](0006-the-curve-allocation-is-per-launch.md) carved the Creator's dev allocation out of the curve supply and left it custodied in `LaunchpadFactory` with no withdrawal path at all.
Build #35 has to give it one, which means choosing when the schedule starts, where the tokens sit, and how the vault learns that a launch has graduated.

The spec settled that the release is linear and owner-tunable but named no duration.
30 days was chosen by the user on 2026-08-04.

## Decision

**The schedule starts at graduation, never at creation.**
`DevVesting` releases a grant linearly over `duration` seconds measured from `GraduationManager.graduatedAt(token)`, which #35 widened from a `bool` to a `uint64` timestamp.
A launch that never graduates never vests anything.

**The tokens move to the vault at `createLaunch`**, not at graduation and not on demand.
The factory's three transfers - curve, graduation reserve, vesting vault - move the entire 1B supply out of it in the creation transaction.

**The vault reads the graduation date; nothing pushes it.**

## Consequences

**Most launches never graduate, and that is the whole reason for the start date.**
A schedule running from creation would let the Creator of a dying curve claim tokens and sell them straight back into the curve, extracting the very ETH other buyers put in - value taken from the people still holding, at the moment the project has already failed.
Running from graduation makes that unrepresentable rather than merely discouraged.
The cost is accepted deliberately: a grant on a launch that stalls is stranded in the vault permanently, which is the same thing as those tokens never having entered circulation.

⚠️ **Vesting delays the price impact; it does not prevent it.**
`docs/tokenomics.md` measures a full 5% allocation sold into a freshly graduated pool at roughly **-30.6%**, and no schedule changes that number - only the earliest moment it can arrive.
At the chosen 30-day default a 5% allocation is fully liquid a month after graduation, releasing about 1.33M tokens a day.
That is the shortest schedule the contract permits, and it is a live candidate for the testnet retune.
Linear rather than a cliff, because a cliff concentrates the entire move into one transaction.

**The factory gains no token-moving capability, which is why custody moved rather than the path being added.**
The alternative - keeping the carve in the factory and adding a vault-only withdrawal - would put a token transfer into the contract that also owns the V3 factory and receives every creation fee.
Moving the tokens out instead means the factory holds no launch tokens and needs no such function, so the property is verifiable by finding the capability absent rather than by auditing a guard.
`Calibration.t.sol` and `DevVesting.t.sol` both assert the absence, on the factory and on the vault.

⚠️ **`DevVesting` reads the graduation date rather than being notified of it, and this is a safety decision, not a style one.**
Calling into the vault from inside `graduate()` would place a revertable external call on the one path in the protocol that must never fail.
A bug in the callee would strand a launch mid-migration with its curve already closed and no pool created.
Reading the date makes the vault's correctness irrelevant to whether a launch can graduate.

**Grant terms are frozen at creation and there is no setter, for anyone.**
The duration is an owner parameter on the factory, bounded to `[30 days, 4 years]` and future-only, so retuning it can never reach a grant that already exists.
The default sits exactly on the floor, so from here the owner can only lengthen - the holder-favouring direction.
⚠️ Unlike `MAX_LOCK_DURATION`, the vesting ceiling is **policy and not load-bearing**: `DevVesting` compares elapsed time against the duration and never adds it to anything, so no value can overflow or divide by zero.
The bound exists so an owner cannot set a schedule longer than a creator would outlive.

**The allocation is still not visible to buyers.**
[ADR-0006](0006-the-curve-allocation-is-per-launch.md) recorded that a free carve emits no `Bought`, so a Creator holding up to 40M tokens reads as 0% concentration on the panel that exists to disclose exactly that.
#35 does not change this; it adds `GrantRegistered` and `Claimed` as the events #36 will index.
⚠️ `LaunchCreated` is emitted **before** `GrantRegistered` in the creation transaction, so an indexer processing logs in order has the `Launch` entity in hand by the time the grant arrives.
Closed by #36 and #37.
