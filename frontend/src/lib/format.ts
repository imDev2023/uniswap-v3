import { formatUnits, type Address } from 'viem'

// Pure formatting helpers — no chain access, fully unit-testable.

/** Format a wei value as an ETH string with a fixed number of significant-ish decimals. */
export function formatEth(wei: bigint, maxDecimals = 4): string {
  const s = formatUnits(wei, 18)
  return trimDecimals(s, maxDecimals)
}

/** Format an 18-decimal token amount compactly (1.2M, 3.4B, 950K, …). */
export function formatTokenAmount(wei: bigint, maxDecimals = 2): string {
  const whole = wei / 10n ** 18n
  const n = Number(whole)
  if (whole >= 1_000_000_000n) return `${trimNumber(n / 1e9, maxDecimals)}B`
  if (whole >= 1_000_000n) return `${trimNumber(n / 1e6, maxDecimals)}M`
  if (whole >= 1_000n) return `${trimNumber(n / 1e3, maxDecimals)}K`
  // sub-1000: show the fractional part too
  return trimDecimals(formatUnits(wei, 18), maxDecimals)
}

/**
 * ETH price per whole token from a priceX18 (ETH-per-token scaled by 1e18). These prices are tiny
 * (e.g. ~3.75e-8 ETH), so render with enough precision or in exponential form.
 */
export function formatPriceX18(priceX18: bigint): string {
  const price = Number(priceX18) / 1e18
  if (price === 0) return '0'
  if (price < 1e-6) return price.toExponential(3)
  return trimNumber(price, 9)
}

export function priceEthPerToken(priceX18: bigint): number {
  return Number(priceX18) / 1e18
}

/** Shorten an address to 0x1234…abcd. */
export function shortAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

export function formatPercent(fraction: number, maxDecimals = 1): string {
  return `${trimNumber(fraction * 100, maxDecimals)}%`
}

/** basis points (0..10000) to a 0..100 progress percentage. */
export function bpsToPercent(bps: number): number {
  return Math.min(100, Math.max(0, bps / 100))
}

export function explorerAddressUrl(baseUrl: string, addr: Address): string {
  return `${baseUrl.replace(/\/$/, '')}/address/${addr}`
}

export function explorerTxUrl(baseUrl: string, txHash: string): string {
  return `${baseUrl.replace(/\/$/, '')}/tx/${txHash}`
}

// --- internal ---

function trimDecimals(s: string, maxDecimals: number): string {
  const [int, frac] = s.split('.')
  if (!frac || maxDecimals === 0) return int
  const trimmed = frac.slice(0, maxDecimals).replace(/0+$/, '')
  return trimmed ? `${int}.${trimmed}` : int
}

function trimNumber(n: number, maxDecimals: number): string {
  if (!isFinite(n)) return '0'
  return Number(n.toFixed(maxDecimals)).toString()
}
