/**
 * The creator/treasury split of a locked position's LP fees (#39, settled decision 1).
 *
 * ⚠️ This mirrors arithmetic that `LPLock.collect` performs on-chain, so it has to round the way
 * Solidity does: integer division truncates, and the remainder therefore falls to the TREASURY by
 * construction. Computing the treasury side as `gross * (10000 - bps) / 10000` instead would round
 * the other way and quote a creator up to one base unit more than they will actually receive, on
 * both assets, on every collection.
 */

/** `MAX_CREATOR_FEE_BPS` in `LPLock`. The denominator for `creatorFeeBps`. */
export const BPS_DENOMINATOR = 10_000n

export interface FeeSplit {
  creatorToken: bigint
  creatorWeth: bigint
  treasuryToken: bigint
  treasuryWeth: bigint
}

/**
 * Split gross collected fees into the creator's and the treasury's shares.
 *
 * @param grossToken Gross fees in the launch token's base units, before the split.
 * @param grossWeth  Gross fees in wei, before the split.
 * @param creatorFeeBps The creator's share in basis points, frozen per position at lock time.
 */
export function splitCreatorFees(
  grossToken: bigint,
  grossWeth: bigint,
  creatorFeeBps: number,
): FeeSplit {
  const bps = BigInt(creatorFeeBps)
  // Floor, matching Solidity. The treasury takes the remainder rather than its own rounded share.
  const creatorToken = (grossToken * bps) / BPS_DENOMINATOR
  const creatorWeth = (grossWeth * bps) / BPS_DENOMINATOR

  return {
    creatorToken,
    creatorWeth,
    treasuryToken: grossToken - creatorToken,
    treasuryWeth: grossWeth - creatorWeth,
  }
}

/**
 * Resolve a pool-ordered `(amount0, amount1)` pair into `(launch token, WETH)`.
 *
 * ⚠️ V3 sorts a pool's pair by address, so which side the launch token is on is a per-launch fact.
 * `tokenIsToken0` comes from `usePoolTokenOrder`, and its `undefined` must be handled by the caller
 * before this is reached: there is no safe default, because guessing is right about half the time
 * and confidently wrong the rest.
 */
export function byPoolOrder(
  amount0: bigint,
  amount1: bigint,
  tokenIsToken0: boolean,
): { token: bigint; weth: bigint } {
  return tokenIsToken0 ? { token: amount0, weth: amount1 } : { token: amount1, weth: amount0 }
}
