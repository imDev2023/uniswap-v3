import { CURVE_SUPPLY, PROGRESS_BPS_MAX } from '../config/constants'

// Pure curve helpers — bonding-curve arithmetic and slippage, matching the on-chain semantics in
// contracts/src/BondingCurve.sol. No chain access, fully unit-testable.

/**
 * Curve progress toward graduation as a 0..1 fraction, from cumulative tokens sold.
 *
 * ⚠️ `curveAllocation` is a REAL per-launch value since #34, not a constant. A dev allocation carves
 * the curve supply down to as little as 760M, and a curve that sells out at 760M would otherwise
 * render as 95% and never reach 100%. It defaults to the 800M no-dev-allocation case so existing
 * callers are correct for every launch created without one.
 */
export function progressFraction(tokensSold: bigint, curveAllocation: bigint = CURVE_SUPPLY): number {
  if (tokensSold <= 0n) return 0
  if (curveAllocation <= 0n) return 0
  if (tokensSold >= curveAllocation) return 1
  // scale to bps then divide, to match the integer subgraph value without precision loss on big ints
  const bps = (tokensSold * BigInt(PROGRESS_BPS_MAX)) / curveAllocation
  return Number(bps) / PROGRESS_BPS_MAX
}

/** Curve progress from the subgraph's integer basis-points value. */
export function progressFractionFromBps(progressBps: number): number {
  return Math.min(1, Math.max(0, progressBps / PROGRESS_BPS_MAX))
}

/** Tokens still available on the curve before it sells out and graduates. */
export function tokensRemaining(tokensSold: bigint, curveAllocation: bigint = CURVE_SUPPLY): bigint {
  const remaining = curveAllocation - tokensSold
  return remaining > 0n ? remaining : 0n
}

/**
 * Apply a downward slippage tolerance to a quoted output (min-out for buy/sell). `slippageBps` is
 * in basis points (e.g. 500 = 5%). Rounds down, never returning more than `quoted`.
 */
export function applySlippage(quoted: bigint, slippageBps: number): bigint {
  if (quoted <= 0n) return 0n
  const clamped = Math.max(0, Math.min(10_000, Math.floor(slippageBps)))
  return (quoted * BigInt(10_000 - clamped)) / 10_000n
}

/** Whether a would-be buy of `tokensOut` keeps a wallet within the anti-snipe cap. */
export function withinBuyCap(
  alreadyPurchased: bigint,
  tokensOut: bigint,
  maxBuyPerWallet: bigint,
  capActive: boolean,
): boolean {
  if (!capActive) return true
  return alreadyPurchased + tokensOut <= maxBuyPerWallet
}

/**
 * Fraction of the curve allocation a single address holds (for creator-concentration display).
 * `balance` is that address's net curve position; the denominator is this launch's own curve
 * allocation, which since #34 is 760M to 800M depending on the dev allocation.
 */
export function shareOfCurveSupply(balance: bigint, curveAllocation: bigint = CURVE_SUPPLY): number {
  if (balance <= 0n || curveAllocation <= 0n) return 0
  const bps = (balance * 10_000n) / curveAllocation
  return Number(bps) / 10_000
}
