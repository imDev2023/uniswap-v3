import { describe, expect, it } from 'vitest'
import {
  isKnownReclaimBlocker,
  lockState,
  PERMANENT_LOCK_UNTIL,
  ReclaimBlocker,
  reclaimBlockerCopy,
  type LockInput,
} from './lock'

const NOW = 1_800_000_000n
const YEAR = 31_536_000n

function lock(over: Partial<LockInput> = {}): LockInput {
  return { lockUntil: NOW + YEAR, permanent: false, reclaimed: false, extendCount: 0, ...over }
}

describe('lockState', () => {
  it('answers "permanent" without ever comparing the sentinel to a clock', () => {
    // ⚠️ The whole reason this function exists. There is no permanent flag on-chain: `LPLock`
    // encodes it as `lockUntil == type(uint64).max`. Anything that subtracts `now` from that
    // sentinel renders a permanent lock as unlocking in the year 584942417355.
    const state = lockState(lock({ permanent: true, lockUntil: PERMANENT_LOCK_UNTIL }), NOW)
    expect(state.kind).toBe('permanent')
    expect(JSON.stringify(state)).not.toContain('584942417355')
  })

  it('recognises the sentinel even if the indexed permanent flag is missing', () => {
    // Defence in depth: `permanent` is DERIVED by the indexer, so a mapping bug or an older schema
    // could serve it false while the sentinel is present. The sentinel is the on-chain truth.
    expect(lockState(lock({ permanent: false, lockUntil: PERMANENT_LOCK_UNTIL }), NOW).kind).toBe(
      'permanent',
    )
  })

  it('reports a reclaimed permanent lock as reclaimed, not as locked', () => {
    // Order matters: reclaimed is checked before permanent. Reversed, a wound-up position would
    // still read "locked permanently" - the strongest possible reassurance about liquidity that
    // has already been burned and swept.
    expect(lockState(lock({ permanent: true, reclaimed: true }), NOW).kind).toBe('reclaimed')
  })

  it('counts down while inside the term', () => {
    const state = lockState(lock({ lockUntil: NOW + 100n }), NOW)
    expect(state.kind).toBe('locked')
    if (state.kind !== 'locked') throw new Error('unreachable')
    expect(state.secondsRemaining).toBe(100n)
  })

  it('flips to expired one second after the term, matching the contract boundary', () => {
    // `LPLock` uses `block.timestamp <= r.lockUntil` for NotExpired, so `lockUntil` itself is still
    // locked. An off-by-one here would show a position as reclaimable a second before it is.
    expect(lockState(lock({ lockUntil: NOW }), NOW).kind).toBe('locked')
    expect(lockState(lock({ lockUntil: NOW - 1n }), NOW).kind).toBe('expired')
  })
})

describe('reclaimBlockerCopy', () => {
  it('gives every blocker its own words', () => {
    // ⚠️ `LPLock` returns a NAMED enum rather than a boolean precisely so this surface can say WHICH
    // condition is outstanding. Two blockers sharing copy collapses that back into "not yet",
    // which is the answer the enum exists to avoid.
    const all = [
      ReclaimBlocker.NoBlocker,
      ReclaimBlocker.NotALaunchPosition,
      ReclaimBlocker.AlreadyReclaimed,
      ReclaimBlocker.PermanentLock,
      ReclaimBlocker.NotExpired,
      ReclaimBlocker.PoolActive,
    ]
    const labels = all.map((b) => reclaimBlockerCopy(b).label)
    const details = all.map((b) => reclaimBlockerCopy(b).detail)
    expect(new Set(labels).size).toBe(all.length)
    expect(new Set(details).size).toBe(all.length)
  })

  it('distinguishes a permanent lock from a term that has not expired', () => {
    // These are the two a reader most needs kept apart: one ends, the other never does.
    expect(reclaimBlockerCopy(ReclaimBlocker.PermanentLock).detail).toMatch(/never/i)
    expect(reclaimBlockerCopy(ReclaimBlocker.NotExpired).detail).not.toMatch(/never expire/i)
  })

  it('says the pool itself is what holds an expired lock open', () => {
    expect(reclaimBlockerCopy(ReclaimBlocker.PoolActive).detail).toMatch(/pool/i)
    expect(reclaimBlockerCopy(ReclaimBlocker.PoolActive).detail).toMatch(/expired/i)
  })

  it('does not claim a specific reason for a blocker it does not know', () => {
    // A future LPLock could add a condition. Mapping it onto a neighbour's copy would be a
    // confident, specific, wrong explanation of why locked liquidity cannot be released.
    const copy = reclaimBlockerCopy(99 as ReclaimBlocker)
    expect(copy.detail).toMatch(/does not recognise/i)
  })
})

describe('isKnownReclaimBlocker', () => {
  it('accepts exactly the six the contract defines', () => {
    for (let i = 0; i <= 5; i++) expect(isKnownReclaimBlocker(i)).toBe(true)
    expect(isKnownReclaimBlocker(6)).toBe(false)
    expect(isKnownReclaimBlocker(-1)).toBe(false)
    expect(isKnownReclaimBlocker(1.5)).toBe(false)
  })

  it('pins NoBlocker to zero, which is the value reclaim treats as "go"', () => {
    expect(ReclaimBlocker.NoBlocker).toBe(0)
  })
})
