import { describe, expect, it } from 'vitest'
import { heatColor, heatPercent, meterWidthPercent } from './heat'

describe('heatColor', () => {
  it('warms as the curve approaches graduation', () => {
    expect(heatColor(0)).toBe('var(--heat-0)')
    expect(heatColor(2_400)).toBe('var(--heat-0)')
    expect(heatColor(2_500)).toBe('var(--heat-1)')
    expect(heatColor(5_000)).toBe('var(--heat-2)')
    expect(heatColor(7_500)).toBe('var(--heat-3)')
    expect(heatColor(9_000)).toBe('var(--heat-4)')
    expect(heatColor(10_000)).toBe('var(--heat-4)')
  })

  it('clamps out-of-range values rather than falling off the ramp', () => {
    expect(heatColor(-500)).toBe('var(--heat-0)')
    expect(heatColor(99_999)).toBe('var(--heat-4)')
    expect(heatColor(Number.NaN)).toBe('var(--heat-0)')
  })
})

describe('heatPercent', () => {
  it('converts bps to a clamped percentage', () => {
    expect(heatPercent(10_000)).toBe(100)
    expect(heatPercent(2_635)).toBe(26.35)
    expect(heatPercent(20_000)).toBe(100)
  })
})

describe('meterWidthPercent', () => {
  it('keeps a genuinely-zero bar empty', () => {
    // "Never traded" and "traded a tiny amount" are different states and must not look identical.
    expect(meterWidthPercent(0)).toBe(0)
  })

  it('widens a tiny-but-real position to something visible', () => {
    // RUGPRF sits at 3% on live testnet; 0.3% would otherwise render as an empty track.
    expect(meterWidthPercent(30)).toBe(1.5)
    expect(meterWidthPercent(300)).toBe(3)
  })

  it('passes normal values through untouched', () => {
    expect(meterWidthPercent(5_800)).toBe(58)
    expect(meterWidthPercent(10_000)).toBe(100)
  })
})
