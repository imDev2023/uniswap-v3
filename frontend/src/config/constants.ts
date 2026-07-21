// Curve economics mirrored from contracts/src/LaunchpadFactory.sol + LaunchToken.sol. These are
// protocol constants (not per-deployment), safe to hardcode; per-launch tunables (creationFee,
// tradeFeeBps, caps) are always read from the chain, never assumed.

export const TOKEN_DECIMALS = 18

/** Tokens sold on the curve before graduation: 800,000,000 (80% of supply). */
export const CURVE_SUPPLY = 800_000_000n * 10n ** BigInt(TOKEN_DECIMALS)

/** Curve-progress denominator in basis points (matches subgraph progressBps). */
export const PROGRESS_BPS_MAX = 10_000
