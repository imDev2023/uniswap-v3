import { parseEther } from 'viem'

// Curve economics mirrored from contracts/src/LaunchpadFactory.sol + LaunchToken.sol. These are
// protocol constants (not per-deployment), safe to hardcode; per-launch tunables (creationFee,
// tradeFeeBps, caps) are always read from the chain, never assumed.

/** Fixed total supply of every LaunchToken: 1,000,000,000 (18 decimals). */
export const TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n

/** Tokens sold on the curve before graduation: 800,000,000 (80% of supply). */
export const CURVE_SUPPLY = 800_000_000n * 10n ** 18n

/** Tokens reserved to seed the graduation pool: 200,000,000 (20% of supply). */
export const GRADUATION_RESERVE = 200_000_000n * 10n ** 18n

export const TOKEN_DECIMALS = 18

/** Curve-progress denominator in basis points (matches subgraph progressBps). */
export const PROGRESS_BPS_MAX = 10_000

/** UI-only preview cushion for the on-chain creationFee refund of excess. */
export const CREATION_FEE_FALLBACK = parseEther('0.01')
