import { describe, expect, it } from 'vitest'
import { parseEther } from 'viem'
import {
  applySlippage,
  progressFraction,
  progressFractionFromBps,
  shareOfCurveSupply,
  tokensRemaining,
  withinBuyCap,
} from './curve'
import { CURVE_SUPPLY } from '../config/constants'

describe('progressFraction', () => {
  it('is 0 at the start and 1 when the curve is sold out', () => {
    expect(progressFraction(0n)).toBe(0)
    expect(progressFraction(CURVE_SUPPLY)).toBe(1)
  })

  it('is 0.5 at half the curve supply', () => {
    expect(progressFraction(CURVE_SUPPLY / 2n)).toBeCloseTo(0.5, 4)
  })

  it('clamps values beyond the allocation to 1', () => {
    expect(progressFraction(CURVE_SUPPLY * 2n)).toBe(1)
  })

  // ⚠️ #34: a dev allocation carves the curve supply down per launch. A curve that sells out at
  // 760M must read 100%, not 95% - the meter would otherwise never fill on any launch with a dev
  // allocation, and would keep showing room to buy on a curve that has already graduated.
  it('reaches 1 at a carved curve allocation, not only at the 800M constant', () => {
    const carved = 760_000_000n * 10n ** 18n
    expect(progressFraction(carved, carved)).toBe(1)
    expect(progressFraction(carved)).toBeCloseTo(0.95, 4)
    expect(progressFraction(carved / 2n, carved)).toBeCloseTo(0.5, 4)
  })

  it('treats a zero allocation as no progress rather than dividing by zero', () => {
    expect(progressFraction(100n, 0n)).toBe(0)
  })
})

describe('progressFractionFromBps', () => {
  it('maps basis points to a 0..1 fraction', () => {
    expect(progressFractionFromBps(0)).toBe(0)
    expect(progressFractionFromBps(5000)).toBe(0.5)
    expect(progressFractionFromBps(10000)).toBe(1)
  })
  it('clamps out-of-range bps', () => {
    expect(progressFractionFromBps(-100)).toBe(0)
    expect(progressFractionFromBps(20000)).toBe(1)
  })
})

describe('tokensRemaining', () => {
  it('returns the unsold allocation', () => {
    expect(tokensRemaining(0n)).toBe(CURVE_SUPPLY)
    expect(tokensRemaining(CURVE_SUPPLY)).toBe(0n)
  })
  it('never goes negative', () => {
    expect(tokensRemaining(CURVE_SUPPLY + 1n)).toBe(0n)
  })
  it('measures against a carved per-launch allocation (#34)', () => {
    const carved = 760_000_000n * 10n ** 18n
    expect(tokensRemaining(0n, carved)).toBe(carved)
    expect(tokensRemaining(carved, carved)).toBe(0n)
  })
})

describe('applySlippage', () => {
  it('reduces a quote by the tolerance in bps', () => {
    expect(applySlippage(parseEther('100'), 500)).toBe(parseEther('95'))
    expect(applySlippage(parseEther('100'), 100)).toBe(parseEther('99'))
  })
  it('returns the full amount at 0 slippage', () => {
    expect(applySlippage(1000n, 0)).toBe(1000n)
  })
  it('never returns more than the quote and handles zero', () => {
    expect(applySlippage(0n, 500)).toBe(0n)
    expect(applySlippage(1000n, 500)).toBeLessThanOrEqual(1000n)
  })
  it('clamps slippage above 100%', () => {
    expect(applySlippage(1000n, 20000)).toBe(0n)
  })
})

describe('withinBuyCap', () => {
  const cap = 8_000_000n * 10n ** 18n
  it('always passes when the cap is inactive', () => {
    expect(withinBuyCap(cap, cap, cap, false)).toBe(true)
  })
  it('passes when total stays within the cap', () => {
    expect(withinBuyCap(cap / 2n, cap / 2n, cap, true)).toBe(true)
  })
  it('fails when the cap would be exceeded', () => {
    expect(withinBuyCap(cap, 1n, cap, true)).toBe(false)
  })
})

describe('shareOfCurveSupply', () => {
  it('reports the fraction of the 800M curve supply held', () => {
    expect(shareOfCurveSupply(CURVE_SUPPLY / 100n)).toBeCloseTo(0.01, 5)
    expect(shareOfCurveSupply(0n)).toBe(0)
  })

  // Concentration is read by someone deciding whether to buy, so a denominator that is too large
  // understates exactly the number they are checking.
  it('uses the launch\'s own allocation, which understates concentration if left at 800M', () => {
    const carved = 760_000_000n * 10n ** 18n
    const balance = carved / 10n
    expect(shareOfCurveSupply(balance, carved)).toBeCloseTo(0.1, 5)
    expect(shareOfCurveSupply(balance)).toBeCloseTo(0.095, 5)
  })

  it('treats a zero allocation as zero share rather than dividing by zero', () => {
    expect(shareOfCurveSupply(100n, 0n)).toBe(0)
  })
})
