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
 * A price broken into renderable pieces. `subzero` is the compact leading-zero notation used across
 * DEX UIs: 0.0₁₀3125 means "0.", then ten zeros, then the significant digits - far easier to compare
 * at a glance than 3.125e-11, and it keeps prices sortable by eye down a column.
 */
export type PriceParts =
  | { kind: 'plain'; text: string }
  | { kind: 'subzero'; zeros: number; digits: string; text: string }

/** Significant digits kept in the compact form. Four is enough to distinguish adjacent curve steps. */
const PRICE_SIG_DIGITS = 4

/**
 * Minimum run of leading zeros before switching to subscript notation. Below this the plain decimal
 * is still short enough to read, and 0.00042 is clearer than 0.0₃42.
 */
const SUBZERO_MIN_ZEROS = 4

/**
 * Format a priceX18 for display.
 *
 * @dev Works on the decimal STRING rather than converting to a JS number. `Number(priceX18) / 1e18`
 *      loses precision on large values and reintroduces the exponential formatting this replaces -
 *      the whole point is to control the digits ourselves. Significant digits are TRUNCATED, not
 *      rounded, so a displayed price never overstates what the curve would actually charge.
 */
export function formatPriceParts(priceX18: bigint): PriceParts {
  if (priceX18 <= 0n) return { kind: 'plain', text: '0' }

  // Split into integer and 18-decimal fractional halves without touching floating point.
  const raw = priceX18.toString().padStart(19, '0')
  const intPart = raw.slice(0, -18).replace(/^0+(?=\d)/, '')
  const fracPart = raw.slice(-18)

  if (intPart !== '0') {
    const frac = fracPart.slice(0, PRICE_SIG_DIGITS).replace(/0+$/, '')
    return { kind: 'plain', text: frac ? `${intPart}.${frac}` : intPart }
  }

  const zeros = fracPart.length - fracPart.replace(/^0+/, '').length
  const digits = fracPart.slice(zeros, zeros + PRICE_SIG_DIGITS).replace(/0+$/, '') || '0'

  if (zeros < SUBZERO_MIN_ZEROS) {
    return { kind: 'plain', text: `0.${'0'.repeat(zeros)}${digits}` }
  }
  // `text` is the expanded form, for tooltips, copy-paste and screen readers - the subscript is a
  // visual compression, so the accessible name must still be the real number.
  return { kind: 'subzero', zeros, digits, text: `0.${'0'.repeat(zeros)}${digits}` }
}

export function priceEthPerToken(priceX18: bigint): number {
  return Number(priceX18) / 1e18
}

/** Shorten an address to 0x1234…abcd. */
export function shortAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

const SUBSCRIPT_DIGITS = '₀₁₂₃₄₅₆₇₈₉'

/**
 * The same compact price as {@link formatPriceParts}, but as a single plain string using Unicode
 * subscript digits: "0.0₁₀3124".
 *
 * For contexts that cannot hold markup - chart axis ticks, tooltips, `title` attributes - where the
 * alternative is falling back to exponential notation and reintroducing the problem in exactly the
 * places a reader is trying to compare values.
 */
export function formatPriceCompactText(priceX18: bigint): string {
  const parts = formatPriceParts(priceX18)
  if (parts.kind === 'plain') return parts.text
  const zeros = String(parts.zeros)
    .split('')
    .map((d) => SUBSCRIPT_DIGITS[Number(d)])
    .join('')
  return `0.0${zeros}${parts.digits}`
}

/**
 * Compact relative age, e.g. "12s", "5m", "3h", "2d".
 *
 * @dev `now` is injected rather than read from Date.now() inside, so ages are testable and so every
 *      row in one render shares a single clock. See {@link useNowSeconds} for why that matters.
 *
 *      Chain timestamps can sit slightly ahead of the browser clock (block timestamps have ~1s of
 *      slack, and users' clocks are not synchronised), which would otherwise render as a negative
 *      age. Future timestamps clamp to "now" instead.
 */
export function formatAge(timestampSeconds: number | string, nowSeconds: number): string {
  const then = Number(timestampSeconds)
  if (!Number.isFinite(then)) return '-'

  const secs = Math.max(0, Math.floor(nowSeconds - then))
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
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

/**
 * A duration in seconds as human copy: "30 days", "1 year", "18 months".
 *
 * Deliberately coarse. These are policy terms a reader compares at a glance ("is this the standard
 * year, or something short?"), not countdowns - so "1 year" beats "365 days 0 hours".
 */
export function formatDuration(seconds: bigint): string {
  if (seconds <= 0n) return 'none'
  const days = seconds / 86_400n
  if (days === 0n) {
    const hours = seconds / 3_600n
    if (hours === 0n) return `${seconds} seconds`
    return hours === 1n ? '1 hour' : `${hours} hours`
  }
  if (days < 60n) return days === 1n ? '1 day' : `${days} days`
  if (days < 730n) {
    const years = days / 365n
    const rem = days % 365n
    if (years >= 1n && rem === 0n) return years === 1n ? '1 year' : `${years} years`
    const months = days / 30n
    return `${months} months`
  }
  const years = days / 365n
  return `${years} years`
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
