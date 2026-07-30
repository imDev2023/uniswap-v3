import { describe, expect, it } from 'vitest'
import { parseEther } from 'viem'
import {
  bpsToPercent,
  explorerTxUrl,
  formatEth,
  formatPercent,
  formatPriceParts,
  formatPriceX18,
  formatTokenAmount,
  priceEthPerToken,
  shortAddress,
} from './format'

describe('formatEth', () => {
  it('formats wei to an ETH string, trimming trailing zeros', () => {
    expect(formatEth(parseEther('1.5'))).toBe('1.5')
    expect(formatEth(parseEther('2'))).toBe('2')
    expect(formatEth(0n)).toBe('0')
  })
  it('respects the decimal cap', () => {
    expect(formatEth(parseEther('0.123456'), 4)).toBe('0.1234')
  })
})

describe('formatTokenAmount', () => {
  it('abbreviates large 18-decimal amounts', () => {
    expect(formatTokenAmount(800_000_000n * 10n ** 18n)).toBe('800M')
    expect(formatTokenAmount(1_000_000_000n * 10n ** 18n)).toBe('1B')
    expect(formatTokenAmount(2_500n * 10n ** 18n)).toBe('2.5K')
  })
  it('shows small amounts directly', () => {
    expect(formatTokenAmount(42n * 10n ** 18n)).toBe('42')
  })
})

describe('formatPriceX18', () => {
  it('renders tiny prices in exponential form', () => {
    // 3.75e-8 ETH per token expressed as priceX18
    const priceX18 = 37_500_000_000n // 3.75e-8 * 1e18
    expect(formatPriceX18(priceX18)).toBe('3.750e-8')
  })
  it('renders zero as 0', () => {
    expect(formatPriceX18(0n)).toBe('0')
  })
})

describe('formatPriceParts', () => {
  it('uses subscript notation for the tiny prices launches actually trade at', () => {
    // 3.125e-11 ETH - QUIET's opening price on live testnet. Was rendered "3.125e-11".
    expect(formatPriceParts(31_249_999n)).toEqual({
      kind: 'subzero',
      zeros: 10,
      digits: '3124',
      text: '0.00000000003124',
    })
  })

  it('truncates rather than rounds, so a shown price never overstates the curve', () => {
    // 31_249_999 -> "3124", not "3125": a buyer must never be quoted better than reality.
    const parts = formatPriceParts(31_249_999n)
    expect(parts.kind === 'subzero' && parts.digits).toBe('3124')
  })

  it('counts zeros from the decimal point, not from the first significant digit', () => {
    // 5e-10 ETH (META / SEND at graduation) => 0.0₉5
    expect(formatPriceParts(499_999_999n)).toMatchObject({ kind: 'subzero', zeros: 9, digits: '4999' })
  })

  it('stays plain when there are few enough leading zeros to read directly', () => {
    // 0.00042 ETH - three zeros, below the subscript threshold.
    expect(formatPriceParts(420_000_000_000_000n)).toEqual({ kind: 'plain', text: '0.00042' })
  })

  it('handles prices at or above 1 ETH', () => {
    expect(formatPriceParts(10n ** 18n)).toEqual({ kind: 'plain', text: '1' })
    expect(formatPriceParts(2n * 10n ** 18n + 5n * 10n ** 17n)).toEqual({
      kind: 'plain',
      text: '2.5',
    })
  })

  it('renders zero and negatives as plain 0 rather than an infinite zero run', () => {
    expect(formatPriceParts(0n)).toEqual({ kind: 'plain', text: '0' })
    expect(formatPriceParts(-1n)).toEqual({ kind: 'plain', text: '0' })
  })

  it('does not lose precision on large values the way Number() would', () => {
    // Number(priceX18)/1e18 goes through a double here; the string path must not.
    const parts = formatPriceParts(123_456_789_012_345_678_901n)
    expect(parts).toEqual({ kind: 'plain', text: '123.4567' })
  })

  it('keeps the expanded text usable as an accessible label', () => {
    const parts = formatPriceParts(31_249_999n)
    expect(Number(parts.text)).toBeCloseTo(3.124e-11, 20)
  })
})

describe('priceEthPerToken', () => {
  it('divides the X18 price by 1e18', () => {
    expect(priceEthPerToken(10n ** 18n)).toBe(1)
  })
})

describe('shortAddress', () => {
  it('truncates the middle', () => {
    expect(shortAddress('0x1234567890abcdef1234567890abcdef12345678')).toBe('0x1234…5678')
  })
})

describe('formatPercent + bpsToPercent', () => {
  it('formats a fraction as a percentage', () => {
    expect(formatPercent(0.5)).toBe('50%')
    expect(formatPercent(0.1234, 1)).toBe('12.3%')
  })
  it('converts bps to a clamped percent', () => {
    expect(bpsToPercent(5000)).toBe(50)
    expect(bpsToPercent(20000)).toBe(100)
  })
})

describe('explorer urls', () => {
  it('builds a tx url without double slashes', () => {
    expect(explorerTxUrl('https://explorer.test/', '0xabc')).toBe('https://explorer.test/tx/0xabc')
  })
})
