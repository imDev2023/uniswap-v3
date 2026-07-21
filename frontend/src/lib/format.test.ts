import { describe, expect, it } from 'vitest'
import { parseEther } from 'viem'
import {
  bpsToPercent,
  explorerTxUrl,
  formatEth,
  formatPercent,
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
