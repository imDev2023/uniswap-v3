// LP lock state, derived from the indexed `Lock` record plus the chain's own reclaim verdict.
// Pure - no chain access, no indexer.
//
// ⚠️ **The lock is CONDITIONAL, not permanent** (ADR-0005). It is one year by default, the creator
// may extend it, and permanent is a choice made at creation. Any string in this product saying
// "locked forever" is wrong for the default case.

/**
 * `LPLock.PERMANENT` - the `type(uint64).max` sentinel meaning "never expires".
 *
 * ⚠️ There is no permanent flag on-chain; this sentinel IS the flag. Anything that compares
 * `lockUntil` against a clock without checking it first renders a permanent lock as expiring in the
 * year 584942417355. The indexer derives `Lock.permanent` from exactly this value, and every
 * function below branches on that boolean before it looks at any timestamp.
 */
export const PERMANENT_LOCK_UNTIL = 18_446_744_073_709_551_615n

/** The indexed `Lock` fields this module reads. A subset of the schema entity, on purpose. */
export interface LockInput {
  lockUntil: bigint
  /** Derived by the indexer from the {@link PERMANENT_LOCK_UNTIL} sentinel. Terminal once true. */
  permanent: boolean
  reclaimed: boolean
  extendCount: number
}

export type LockState =
  /** Terminal. The position was wound up: tokens burned, WETH to the treasury. */
  | { kind: 'reclaimed' }
  /** Terminal. Can never expire and can never be reclaimed. */
  | { kind: 'permanent' }
  /** Still inside its term. */
  | { kind: 'locked'; lockUntil: bigint; secondsRemaining: bigint }
  /**
   * Past `lockUntil`. ⚠️ NOT the same as reclaimable: `reclaim` also requires the pool to have gone
   * quiet for `inactivityPeriod`, which is not indexed and must be read from the chain.
   */
  | { kind: 'expired'; lockUntil: bigint; secondsSinceExpiry: bigint }

/**
 * @dev Order matters and is not arbitrary. `reclaimed` and `permanent` are terminal states that
 *      make `lockUntil` meaningless, so both are answered before any comparison against the clock.
 *      Reversing the first two would show a reclaimed permanent lock as still locked; moving the
 *      clock comparison up would show a permanent lock counting down to the year 584942417355.
 */
export function lockState(lock: LockInput, nowSeconds: bigint): LockState {
  if (lock.reclaimed) return { kind: 'reclaimed' }
  if (lock.permanent || lock.lockUntil === PERMANENT_LOCK_UNTIL) return { kind: 'permanent' }
  if (nowSeconds <= lock.lockUntil) {
    return { kind: 'locked', lockUntil: lock.lockUntil, secondsRemaining: lock.lockUntil - nowSeconds }
  }
  return {
    kind: 'expired',
    lockUntil: lock.lockUntil,
    secondsSinceExpiry: nowSeconds - lock.lockUntil,
  }
}

/**
 * `LPLock.ReclaimBlocker`, as the contract orders it. The numbering is the ABI's, so these values
 * are read off a `uint8` return and must not be reordered here independently of the enum there.
 */
export enum ReclaimBlocker {
  NoBlocker = 0,
  NotALaunchPosition = 1,
  AlreadyReclaimed = 2,
  PermanentLock = 3,
  NotExpired = 4,
  PoolActive = 5,
}

/**
 * Human copy for a reclaim verdict.
 *
 * ⚠️ The whole reason `LPLock` returns a NAMED enum rather than a boolean is so this surface can say
 * WHICH condition is outstanding. "Not yet reclaimable" is the answer we are deliberately not
 * giving: a creator watching an expired lock needs to know it is the pool's own activity holding it
 * open, and a buyer needs to know that a permanent lock is not merely a long one.
 */
export function reclaimBlockerCopy(blocker: ReclaimBlocker): { label: string; detail: string } {
  switch (blocker) {
    case ReclaimBlocker.NoBlocker:
      return {
        label: 'Reclaimable now',
        detail:
          'The lock has expired and the pool has been inactive long enough. Anyone can wind this position up: the tokens are burned and the ETH goes to the treasury.',
      }
    case ReclaimBlocker.NotALaunchPosition:
      return {
        label: 'Not a launch position',
        detail: 'Only positions created by an Octopus graduation can ever be reclaimed.',
      }
    case ReclaimBlocker.AlreadyReclaimed:
      return {
        label: 'Already reclaimed',
        detail: 'This position has been wound up. The tokens were burned and the ETH went to the treasury.',
      }
    case ReclaimBlocker.PermanentLock:
      return {
        label: 'Locked permanently',
        detail: 'The creator chose a permanent lock at creation. It can never expire and can never be reclaimed.',
      }
    case ReclaimBlocker.NotExpired:
      return {
        label: 'Lock has not expired',
        detail: 'The liquidity stays locked until the term ends. The creator can extend it, but never shorten it.',
      }
    case ReclaimBlocker.PoolActive:
      return {
        label: 'Pool is still active',
        detail:
          'The lock has expired, but the pool has traded too recently to be wound up. Reclaim needs both an expired lock and a quiet pool.',
      }
    default:
      // A value outside the enum means the deployed contract carries a blocker this build does not
      // know about. Saying so is better than mapping it onto a neighbour's copy.
      return {
        label: 'Not reclaimable',
        detail: 'The chain reported a condition this page does not recognise.',
      }
  }
}

/** Whether a numeric value off the chain is a blocker this build understands. */
export function isKnownReclaimBlocker(value: number): value is ReclaimBlocker {
  return Number.isInteger(value) && value >= 0 && value <= ReclaimBlocker.PoolActive
}
