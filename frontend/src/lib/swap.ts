import type { Address } from 'viem'
import { POOL_FEE_TIER, TOKEN_DECIMALS } from '../config/constants'

// Pure swap-pricing helpers for graduated TOKEN/WETH pools. Both the LaunchToken and WETH9 are
// 18-decimal, so the decimal adjustment between token0/token1 cancels and price ratios are direct.
//
// No Quoter is deployed with the platform's V3 stack (see contracts/script/DeployLaunchpad), so the
// UI prices off the pool's live slot0 spot price and estimates output as amountIn * spot. This
// ignores price impact — fine as a labelled estimate for a "simple swap page" (spec #8); execution
// is protected on-chain by the slippage-derived amountOutMinimum, computed with applySlippage.

const Q96 = 2 ** 96

/** True when `token` sorts before `weth` — i.e. token is token0 in the V3 pool (tokens sort ascending). */
export function tokenIsToken0(token: Address, weth: Address): boolean {
  return token.toLowerCase() < weth.toLowerCase()
}

export interface SpotPrice {
  /** WETH received per 1 whole TOKEN. */
  wethPerToken: number
  /** TOKEN received per 1 whole WETH. */
  tokenPerWeth: number
}

/**
 * Spot price from a pool's sqrtPriceX96. `sqrtPriceX96` encodes sqrt(token1/token0) * 2^96, so
 * (sqrtPriceX96 / 2^96)^2 is token1-per-token0.
 */
export function spotPriceFromSqrtX96(sqrtPriceX96: bigint, tokenIs0: boolean): SpotPrice {
  const sqrt = Number(sqrtPriceX96) / Q96
  const token1PerToken0 = sqrt * sqrt
  if (token1PerToken0 <= 0) return { wethPerToken: 0, tokenPerWeth: 0 }
  // token0 = TOKEN  → token1 = WETH → token1PerToken0 is WETH per TOKEN
  // token0 = WETH   → token1 = TOKEN → token1PerToken0 is TOKEN per WETH
  if (tokenIs0) {
    return { wethPerToken: token1PerToken0, tokenPerWeth: 1 / token1PerToken0 }
  }
  return { wethPerToken: 1 / token1PerToken0, tokenPerWeth: token1PerToken0 }
}

/**
 * Estimate output amount (18-decimal wei) for `amountIn` (18-decimal wei) at a given
 * output-per-input price. Scales the float price to 1e18 fixed-point to stay in bigint space.
 */
export function estimateAmountOut(amountIn: bigint, outPerIn: number): bigint {
  if (amountIn <= 0n || !isFinite(outPerIn) || outPerIn <= 0) return 0n
  const scaled = BigInt(Math.round(outPerIn * 1e18))
  return (amountIn * scaled) / 10n ** BigInt(TOKEN_DECIMALS)
}

export interface ExactInputSingleParams {
  tokenIn: Address
  tokenOut: Address
  fee: number
  recipient: Address
  deadline: bigint
  amountIn: bigint
  amountOutMinimum: bigint
  sqrtPriceLimitX96: bigint
}

/**
 * Build the `SwapRouter.exactInputSingle` params tuple for a graduated pool trade. Always the 1%
 * graduated-pool fee tier and no price limit; kept here (not inline in the component) so the router
 * calldata shape is unit-testable.
 */
export function buildExactInputSingle(args: {
  tokenIn: Address
  tokenOut: Address
  recipient: Address
  deadline: bigint
  amountIn: bigint
  amountOutMinimum: bigint
}): ExactInputSingleParams {
  return {
    tokenIn: args.tokenIn,
    tokenOut: args.tokenOut,
    fee: POOL_FEE_TIER,
    recipient: args.recipient,
    deadline: args.deadline,
    amountIn: args.amountIn,
    amountOutMinimum: args.amountOutMinimum,
    sqrtPriceLimitX96: 0n,
  }
}
