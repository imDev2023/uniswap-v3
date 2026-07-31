// Curve economics mirrored from contracts/src/LaunchpadFactory.sol + LaunchToken.sol. These are
// protocol constants (not per-deployment), safe to hardcode; per-launch tunables (creationFee,
// tradeFeeBps, caps) are always read from the chain, never assumed.

export const TOKEN_DECIMALS = 18

/** Tokens sold on the curve before graduation: 800,000,000 (80% of supply). */
export const CURVE_SUPPLY = 800_000_000n * 10n ** BigInt(TOKEN_DECIMALS)

/** Curve-progress denominator in basis points (matches subgraph progressBps). */
export const PROGRESS_BPS_MAX = 10_000

/** Uniswap V3 fee tier of graduated pools: 1.00% (contracts/src/Constants.sol POOL_FEE_TIER). */
export const POOL_FEE_TIER = 10_000

/**
 * How many trades one token page reads.
 *
 * Lives here rather than beside the query because both ends of the read need it and they must not
 * be coupled to each other: lib/subgraph.ts sizes the page, and the chart has to KNOW it is looking
 * at a window so it can say so instead of letting its left edge pass for the launch of the curve.
 */
export const TRADE_HISTORY_LIMIT = 200
