import { describe, expect, it } from 'vitest'
import { claimableAmount, vestedAmount, vestingState, type VestingInput } from './vesting'
import { formatDuration } from './format'

// `vestedAmount` is a mirror of `DevVesting.vestedAmount`, and the tests that matter are the ones
// that pin the mirror rather than the arithmetic. A UI that promises more than `claim` will pay
// hands the creator a transaction that reverts; one that promises less quietly understates the
// concentration a buyer is reading the panel to find out about.

const GRAD = 1_800_000_000n
const THIRTY_DAYS = 2_592_000n
/** 5% of an 800M curve supply - the largest carve the contract permits. */
const FIVE_PERCENT = 40_000_000n * 10n ** 18n

function grant(over: Partial<VestingInput> = {}): VestingInput {
  // Built fresh per case rather than spread from a shared object: a `const c = base` alias is how
  // one mutated case silently corrupts every later one (see CLAUDE.md's struct-aliasing trap).
  return { allocation: FIVE_PERCENT, duration: THIRTY_DAYS, graduatedAt: GRAD, claimed: 0n, ...over }
}

describe('vestedAmount mirrors the contract', () => {
  it('vests nothing before graduation, however long the curve has been open', () => {
    // ⚠️ The decisive property of ADR-0007. A schedule running from creation would let a creator on
    // a dying curve claim and sell back into the curve, extracting what other buyers put in. A
    // null graduation is not "vesting since the epoch", it is "not started, and possibly never".
    const g = grant({ graduatedAt: null })
    expect(vestedAmount(g, GRAD + 10n * THIRTY_DAYS)).toBe(0n)
    expect(vestingState(g, GRAD + 10n * THIRTY_DAYS).kind).toBe('not-started')
  })

  it('treats a zero graduation timestamp as not graduated, not as the epoch', () => {
    // The subgraph serves `graduatedAtTimestamp: null`, but the contract encodes the same fact as a
    // zero `uint64`. Both spellings reach this function; both must mean the same thing.
    expect(vestedAmount(grant({ graduatedAt: 0n }), GRAD)).toBe(0n)
  })

  it('releases exactly half at the midpoint', () => {
    expect(vestedAmount(grant(), GRAD + THIRTY_DAYS / 2n)).toBe(FIVE_PERCENT / 2n)
  })

  it('multiplies before dividing, so the schedule truncates DOWN and never over the contract', () => {
    // A grant and a duration chosen so divide-first loses the whole answer: `allocation / duration`
    // floors to 0, and 0 * elapsed is 0 forever. Multiply-first gives the real figure.
    const g = grant({ allocation: 1000n, duration: 1_000_000n })
    expect(vestedAmount(g, GRAD + 500_000n)).toBe(500n)
    // And at a point where the true value is fractional, it rounds toward the vault, not the creator.
    expect(vestedAmount(g, GRAD + 1n)).toBe(0n)
  })

  it('vests to the LAST WEI at the end rather than stranding dust', () => {
    // ⚠️ `elapsed >= duration` returns the total exactly instead of letting the final division
    // decide. With a total that does not divide evenly, a division-only implementation strands
    // remainder in the vault permanently. Chosen so `total * duration / duration` is lossy en route.
    const g = grant({ allocation: 999_999_999_999_999_999_999n, duration: 7n })
    expect(vestedAmount(g, GRAD + 7n)).toBe(g.allocation)
    expect(vestedAmount(g, GRAD + 10_000n)).toBe(g.allocation)
  })

  it('vests nothing when there is no grant, whatever the terms say', () => {
    // ⚠️ `vestingDuration` is populated even when the allocation is zero - it records the terms that
    // would have applied. A schedule keyed off the duration would vest a grant that does not exist.
    expect(vestedAmount(grant({ allocation: 0n }), GRAD + THIRTY_DAYS)).toBe(0n)
    expect(vestingState(grant({ allocation: 0n }), GRAD + THIRTY_DAYS).kind).toBe('none')
  })

  it('does not vest backwards when the browser clock trails the chain', () => {
    // Block timestamps carry ~1s of slack and users' clocks are not synchronised, so `now` can sit
    // behind `graduatedAt`. The contract cannot hit this; a browser can, on every fresh graduation.
    expect(vestedAmount(grant(), GRAD - 30n)).toBe(0n)
  })
})

describe('claimableAmount', () => {
  it('is what has vested less what has been taken', () => {
    const g = grant({ claimed: FIVE_PERCENT / 4n })
    expect(claimableAmount(g, GRAD + THIRTY_DAYS / 2n)).toBe(FIVE_PERCENT / 4n)
  })

  it('floors at zero when the indexer has not yet seen a claim', () => {
    // ⚠️ The contract subtracts unguarded because its own invariant holds. Here `claimed` comes from
    // the indexer, which lags: a claim confirmed one block ago is already reflected in nothing else.
    // Underflowing that into a negative would render as a nonsense balance on a live claim button.
    const g = grant({ claimed: FIVE_PERCENT })
    expect(claimableAmount(g, GRAD + 1n)).toBe(0n)
  })
})

describe('vestingState', () => {
  it('reports progress as a fraction while releasing', () => {
    const state = vestingState(grant(), GRAD + THIRTY_DAYS / 4n)
    expect(state.kind).toBe('vesting')
    if (state.kind !== 'vesting') throw new Error('unreachable')
    expect(state.fraction).toBeCloseTo(0.25, 4)
    expect(state.endsAt).toBe(GRAD + THIRTY_DAYS)
  })

  it('becomes complete exactly at the end, not one second after', () => {
    expect(vestingState(grant(), GRAD + THIRTY_DAYS).kind).toBe('complete')
    expect(vestingState(grant(), GRAD + THIRTY_DAYS - 1n).kind).toBe('vesting')
  })
})

describe('an UNKNOWN duration is not a zero duration', () => {
  // ⚠️ The sharpest defect this module can produce, and it is reachable today. `DevVesting` has
  // never been deployed, so the vault read fails while the factory's `devAllocationOf` still
  // succeeds - a carve with no readable schedule. Collapsed to `0n` that lands in the `duration <= 0`
  // branch, which means "the whole grant has already released", and a graduated 5% launch announces
  // itself as 100% VESTED AND FULLY RELEASABLE. That inverts ADR-0007 on the panel built to disclose it.
  it('vests nothing rather than everything', () => {
    const g = grant({ duration: undefined })
    expect(vestedAmount(g, GRAD + 10n * THIRTY_DAYS)).toBe(0n)
    expect(claimableAmount(g, GRAD + 10n * THIRTY_DAYS)).toBe(0n)
  })

  it('gets its own state rather than reading as complete', () => {
    const state = vestingState(grant({ duration: undefined }), GRAD + THIRTY_DAYS)
    expect(state.kind).toBe('terms-unknown')
  })

  it('still reads as complete for a genuine zero duration', () => {
    // The two must stay distinguishable in BOTH directions: a real zero means fully released.
    const state = vestingState(grant({ duration: 0n }), GRAD + 1n)
    expect(state.kind).toBe('complete')
    if (state.kind !== 'complete') throw new Error('unreachable')
    expect(state.vested).toBe(FIVE_PERCENT)
  })

  it('reports no carve before it reports unknown terms', () => {
    // A launch with no allocation has nothing to say about vesting, whatever the duration reads.
    expect(vestingState(grant({ allocation: 0n, duration: undefined }), GRAD).kind).toBe('none')
  })
})

describe('an UNKNOWN graduation date is not an ungraduated launch', () => {
  // ⚠️ The mirror of the unknown-duration defect above, and it shipped for a whole ticket because
  // `graduatedAt` was the one value on the card still taken from the indexer. With graph-node down,
  // `undefined` fell through to the `null` branch and a launch that graduated a month ago rendered
  // as "the schedule starts at graduation - so if this curve never graduates, the creator never
  // receives any of it". A statement about the future, made confidently, about the past.
  it('gets its own state rather than reading as not-started', () => {
    const state = vestingState(grant({ graduatedAt: undefined }), GRAD + THIRTY_DAYS)
    expect(state.kind).toBe('schedule-unknown')
  })

  it('still reads as not-started for a launch genuinely on its curve', () => {
    // Both directions again: `null` is a real answer and must keep its own, different copy.
    expect(vestingState(grant({ graduatedAt: null }), GRAD + THIRTY_DAYS).kind).toBe('not-started')
  })

  it('vests nothing, and does not fall through to arithmetic against undefined', () => {
    // `undefined <= 0n` is silently false, so an unchecked date would reach the elapsed-time maths
    // and vest against NaN rather than returning zero.
    const g = grant({ graduatedAt: undefined })
    expect(vestedAmount(g, GRAD + 10n * THIRTY_DAYS)).toBe(0n)
    expect(claimableAmount(g, GRAD + 10n * THIRTY_DAYS)).toBe(0n)
  })

  it('reports unknown TERMS before an unknown graduation date', () => {
    // With neither known there is even less to say, and the terms branch says the less specific
    // thing. Pinned so the two unknown states cannot silently swap priority.
    const state = vestingState(grant({ duration: undefined, graduatedAt: undefined }), GRAD)
    expect(state.kind).toBe('terms-unknown')
  })
})

describe('formatDuration', () => {
  it('names the two terms this product actually ships', () => {
    expect(formatDuration(THIRTY_DAYS)).toBe('30 days')
    expect(formatDuration(31_536_000n)).toBe('1 year')
  })

  it('never renders a real duration as "none"', () => {
    // "none" on a lock term is a claim that there is no lock, so only a genuine zero may produce it.
    expect(formatDuration(0n)).toBe('none')
    expect(formatDuration(1n)).not.toBe('none')
    expect(formatDuration(86_399n)).not.toBe('none')
  })

  it('handles the four-year vesting ceiling', () => {
    expect(formatDuration(1460n * 86_400n)).toBe('4 years')
  })
})
