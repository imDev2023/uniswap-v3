import { describe, expect, it } from 'vitest'
import { splitCreatorFees } from './fees'

describe('splitCreatorFees', () => {
  it('splits the settled 70/30 across both assets', () => {
    const s = splitCreatorFees(1000n, 500n, 7000)

    expect(s.creatorToken).toBe(700n)
    expect(s.treasuryToken).toBe(300n)
    expect(s.creatorWeth).toBe(350n)
    expect(s.treasuryWeth).toBe(150n)
  })

  it('⚠️ rounds the creator DOWN and gives the remainder to the treasury, as Solidity does', () => {
    // 7 * 7000 / 10000 = 4.9, and the contract's integer division truncates to 4. Computing the
    // treasury side independently as `7 * 3000 / 10000` would floor to 2, which loses a wei and
    // quotes a total that does not add up to what was collected.
    const s = splitCreatorFees(7n, 7n, 7000)

    expect(s.creatorToken).toBe(4n)
    expect(s.treasuryToken).toBe(3n)
    expect(s.creatorToken + s.treasuryToken).toBe(7n)
  })

  it('⚠️ the two shares always sum to the gross, at every remainder', () => {
    // The property the rounding rule exists to preserve. A split that rounded both sides would
    // silently create or destroy base units on most collections.
    for (let gross = 0n; gross < 50n; gross++) {
      for (const bps of [0, 1, 2500, 7000, 9999, 10000]) {
        const s = splitCreatorFees(gross, gross, bps)
        expect(s.creatorToken + s.treasuryToken).toBe(gross)
        expect(s.creatorWeth + s.treasuryWeth).toBe(gross)
      }
    }
  })

  it('a zero fee share sends everything to the treasury', () => {
    const s = splitCreatorFees(1000n, 1000n, 0)

    expect(s.creatorToken).toBe(0n)
    expect(s.treasuryToken).toBe(1000n)
  })

  it('a full fee share sends everything to the creator', () => {
    const s = splitCreatorFees(1000n, 1000n, 10000)

    expect(s.creatorToken).toBe(1000n)
    expect(s.treasuryToken).toBe(0n)
  })

  it('handles amounts far beyond 2^53 without losing precision', () => {
    // Fees are wei-denominated, so the naive number-typed version of this would have been wrong on
    // every realistic input while passing every small-number test above.
    const gross = 123456789012345678901234567890n
    const s = splitCreatorFees(gross, gross, 7000)

    expect(s.creatorToken).toBe((gross * 7000n) / 10000n)
    expect(s.creatorToken + s.treasuryToken).toBe(gross)
  })
})
