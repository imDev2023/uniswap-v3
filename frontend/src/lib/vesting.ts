// Dev-allocation vesting, computed client-side. Pure - no chain access, no indexer.
//
// ⚠️ **This module exists because the subgraph deliberately has no `devVestedSoFar` field.** The
// vested amount is a continuous function of wall-clock time, and a subgraph only writes when an
// event fires, so any stored figure would be silently stale between trades - worst on a quiet
// launch, which is precisely where a reader would trust it most. See `subgraph/CONTEXT.md`.
//
// So the number is derived here, from three values that are each frozen or single-shot: the grant
// total, the grant's duration, and the graduation timestamp. Feed it a ticking `now` and it tracks
// the contract second by second. All three are read from the chain (`hooks/useLaunchTerms.ts`);
// nothing on this path touches the read model.
//
// ⚠️ Every one of the three has a NOT-KNOWN state distinct from any real value, and each one of
// those distinctions was a bug before it was a comment: an unknown duration read as `0n` announces
// an untouched carve as fully released, and an unknown graduation date read as "not graduated" tells
// a reader that a schedule already running will never start.

/**
 * The three grant terms plus what has already been taken. `allocation` and `claimed` are wei-scaled
 * token amounts; `duration` and `graduatedAt` are seconds.
 */
export interface VestingInput {
  /** The creator's carve. Zero means none was taken and no grant exists. */
  allocation: bigint
  /**
   * The grant's own vesting window in seconds, frozen at creation.
   *
   * ⚠️ `undefined` means NOT KNOWN and is a state of its own - never collapse it to `0n`. A zero
   * duration means "the whole grant has already released", so an unread duration defaulted to zero
   * renders an untouched carve as **100% vested and fully releasable**, which inverts the entire
   * point of ADR-0007. That is reachable today: `DevVesting` has never been deployed, so the vault
   * read fails while `devAllocationOf` on the factory still succeeds.
   *
   * ⚠️ A non-zero duration is never on its own evidence of a grant. The indexer populates its own
   * copy for every launch, including those with no carve, because it records the terms that WOULD
   * have applied. Branch on `allocation > 0` first.
   */
  duration: bigint | undefined
  /**
   * Graduation timestamp: the instant the schedule starts (ADR-0007).
   *
   * ⚠️ **Three states, and they are not interchangeable.** A `bigint` is the graduation time.
   * `null` is a launch still on its curve, which may never graduate. `undefined` is NOT KNOWN,
   * because the `GraduationManager` read is in flight or failed.
   *
   * ⚠️ `undefined` must never collapse into `null`. "Not graduated" renders as the reassurance that
   * nothing can be sold yet and that the creator receives nothing if the curve never graduates -
   * which, said about a launch that graduated a month ago, is a specific and confident lie, and it
   * also withdraws the claim button from the person entitled to press it.
   */
  graduatedAt: bigint | null | undefined
  /** Cumulative tokens the creator has actually taken out of the vault. */
  claimed: bigint
}

export type VestingState =
  /** No carve was taken. There is no grant and no vesting UI to render. */
  | { kind: 'none' }
  /**
   * A carve exists but its terms could not be read, so no schedule can be placed on a timeline.
   *
   * ⚠️ Its own state, and it must stay that way. Folded into `complete` (which is where a `0n`
   * duration lands) it would announce an untouched grant as fully releasable.
   */
  | { kind: 'terms-unknown'; allocation: bigint }
  /**
   * The grant and its terms are known, but whether the launch has graduated is not, so the schedule
   * cannot be placed on a timeline.
   *
   * ⚠️ Its own state rather than a fold into `not-started`, because the two make opposite promises.
   * `not-started` asserts that nothing has vested; this one asserts nothing at all. The amount
   * claimable is still knowable here, since it is read straight from the vault.
   */
  | { kind: 'schedule-unknown'; allocation: bigint; duration: bigint }
  /**
   * A grant exists but the launch has not graduated, so the schedule has not started and nothing
   * has vested. ⚠️ It may never start: most launches never graduate (ADR-0007).
   */
  | { kind: 'not-started'; allocation: bigint; duration: bigint }
  /** Releasing linearly right now. */
  | {
      kind: 'vesting'
      allocation: bigint
      duration: bigint
      /** Seconds since graduation, clamped at `duration`. */
      elapsed: bigint
      /** 0..1, for a progress meter. */
      fraction: number
      vested: bigint
      claimed: bigint
      claimable: bigint
      /** Unix seconds at which the last wei vests. */
      endsAt: bigint
    }
  /** Fully released. `vested === allocation` exactly, to the last wei. */
  | {
      kind: 'complete'
      allocation: bigint
      duration: bigint
      vested: bigint
      claimed: bigint
      claimable: bigint
      endsAt: bigint
    }

/**
 * Tokens released to date, claimed or not.
 *
 * @dev ⚠️ This is a line-for-line mirror of `DevVesting.vestedAmount`, and the two must not drift:
 *      a UI that promises more than `claim` will pay hands the creator a transaction that reverts.
 *      Three details are load-bearing and all three are copied deliberately:
 *
 *      1. **Multiply before divide.** `(total * elapsed) / duration`, so the schedule truncates
 *         exactly once and always downward. Dividing first would round the creator UP, over the
 *         contract, on every second of the schedule.
 *      2. **`elapsed >= duration` returns `total` exactly** rather than letting the final division
 *         decide, which is what makes a grant vest to the last wei instead of stranding dust.
 *      3. **`start == 0` means "not graduated"** and yields 0, not "vested since the epoch".
 *
 *      `contracts/test/DevVesting.t.sol` pins the contract side; `vesting.test.ts` pins this one
 *      against the same worked figures.
 */
export function vestedAmount(input: VestingInput, nowSeconds: bigint): bigint {
  const { allocation, duration, graduatedAt } = input
  if (allocation <= 0n) return 0n
  // ⚠️ An unknown duration vests NOTHING, where a zero duration vests everything. Reading them the
  // same way is how an unread grant announces itself as fully releasable.
  if (duration === undefined) return 0n
  // ⚠️ `undefined` is checked explicitly rather than leaning on `graduatedAt <= 0n`. A comparison
  // against `undefined` is silently false, so an unread date would fall straight through to the
  // arithmetic below and vest against `NaN`.
  if (graduatedAt === undefined || graduatedAt === null || graduatedAt <= 0n) return 0n
  const elapsed = elapsedSince(graduatedAt, nowSeconds)
  if (duration <= 0n) return allocation
  if (elapsed >= duration) return allocation
  return (allocation * elapsed) / duration
}

/**
 * Seconds from `start` to `now`, floored at zero.
 *
 * A browser clock can sit behind a chain timestamp, which would otherwise make the difference
 * negative and vest a negative amount. The contract cannot hit this - its `start` is always in its
 * own past - so the clamp exists purely because this side runs on the reader's clock.
 */
function elapsedSince(start: bigint, nowSeconds: bigint): bigint {
  return nowSeconds > start ? nowSeconds - start : 0n
}

/** Tokens the creator could claim right now: what has vested, less what has already been taken. */
export function claimableAmount(input: VestingInput, nowSeconds: bigint): bigint {
  const vested = vestedAmount(input, nowSeconds)
  // The contract subtracts unguarded because its own invariant holds (`claimed <= vested` always).
  // Here `claimed` arrives from the indexer, which can lag a claim it has not yet seen - and a lag
  // must not render as a negative balance.
  return vested > input.claimed ? vested - input.claimed : 0n
}

/** The whole vesting picture in one discriminated union, for a component to switch on. */
export function vestingState(input: VestingInput, nowSeconds: bigint): VestingState {
  const { allocation, duration, graduatedAt, claimed } = input

  if (allocation <= 0n) return { kind: 'none' }
  if (duration === undefined) return { kind: 'terms-unknown', allocation }
  // ⚠️ Order matters: not-known is resolved BEFORE not-graduated, because the fallthrough is what
  // turned an unreadable graduation date into the claim that this curve had never graduated.
  if (graduatedAt === undefined) return { kind: 'schedule-unknown', allocation, duration }
  if (graduatedAt === null || graduatedAt <= 0n) {
    return { kind: 'not-started', allocation, duration }
  }

  const elapsedRaw = elapsedSince(graduatedAt, nowSeconds)
  const endsAt = graduatedAt + duration
  // ⚠️ `claimableAmount` calls `vestedAmount` itself, so calling both here ran the schedule twice
  // over. Derived from the single figure instead - and it must stay the same subtraction the
  // exported helper performs, including the clamp, or the card and the helper could disagree.
  const vested = vestedAmount(input, nowSeconds)
  const claimable = vested > claimed ? vested - claimed : 0n

  if (duration <= 0n || elapsedRaw >= duration) {
    return { kind: 'complete', allocation, duration, vested, claimed, claimable, endsAt }
  }

  return {
    kind: 'vesting',
    allocation,
    duration,
    elapsed: elapsedRaw,
    // Scaled through basis points rather than Number(bigint)/Number(bigint): the operands are
    // second counts here, but the same shape applied to wei would lose precision, and this keeps
    // one idiom across the file.
    fraction: Number((elapsedRaw * 10_000n) / duration) / 10_000,
    vested,
    claimed,
    claimable,
    endsAt,
  }
}
