import { usePublicClient } from 'wagmi'
import { useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import { lpLockAbi } from '../abi/lpLock'
import { usePeriphery } from './usePeriphery'
import { usePoolTokenOrder } from './usePoolTokenOrder'
import { byPoolOrder, splitCreatorFees } from '../lib/fees'

/**
 * What a locked position has accrued but NOT yet collected, read live from the chain.
 *
 * ⚠️ **The indexer cannot answer this, and the reason is the whole point of the hook.** A subgraph
 * can only report collections that have happened, and `LPLock.collect` is PERMISSIONLESS - nobody is
 * obliged to call it, and on a quiet launch nobody will. A creator whose position has earned fees
 * for a year would be shown a lifetime total of zero, which is indistinguishable from having earned
 * nothing. That is the same defect as every other unread-value-defaulted-to-zero in this app, except
 * the zero here is produced by an honest indexer reporting real history.
 *
 * The figure comes from SIMULATING `collect`. It is nonpayable, so an `eth_call` runs the real
 * collection path - including the position manager's own fee accounting - and returns the gross
 * amounts without moving anything. `positions().tokensOwed0/1` is deliberately not used: it is stale
 * until the position is poked, so it reads zero on exactly the untouched positions this is for.
 *
 * ⚠️ **Simulated through the PUBLIC client, deliberately not through `useSimulateContract`.** That
 * hook simulates as the connected account and throws `ConnectorNotConnectedError` when there is no
 * wallet, which silently blanked this whole panel for every visitor who had not connected - the
 * creator checking their earnings very much included. `collect` is permissionless and its
 * destinations are hardcoded, so the caller is irrelevant to the answer and no account is needed.
 * Found by loading the page; every test passed with the panel dark.
 *
 * ⚠️ Every field is `undefined` until its read lands. Zero is a real answer here - a position that
 * genuinely has no accrued fees - so "not known" needs its own state and the caller must branch on
 * it before rendering or doing arithmetic.
 */

/** Fees accrue with trading, so this moves faster than the lock terms but is still not urgent. */
const FEES_POLL_MS = 30_000

export interface ClaimableFees {
  /** The creator's share of accrued fees, in the launch token's base units. */
  creatorToken: bigint | undefined
  /** The creator's share of accrued fees, in wei. */
  creatorWeth: bigint | undefined
  /** The treasury's share, the other side of the same split. */
  treasuryToken: bigint | undefined
  treasuryWeth: bigint | undefined
  /**
   * True when the simulation itself failed.
   *
   * ⚠️ Distinct from "zero accrued". A reverted simulation means we do not know, and the card must
   * not render it as nothing owed.
   */
  isError: boolean
}

const UNKNOWN: ClaimableFees = {
  creatorToken: undefined,
  creatorWeth: undefined,
  treasuryToken: undefined,
  treasuryWeth: undefined,
  isError: false,
}

export function useClaimableFees(
  tokenId: bigint | undefined,
  pool: Address | undefined,
  token: Address | undefined,
  creatorFeeBps: number | undefined,
): ClaimableFees {
  const { lpLock } = usePeriphery()

  // ⚠️ Which of amount0/amount1 is the launch token is read from the POOL, never assumed. See
  // `usePoolTokenOrder` for why this read cannot live in the subgraph.
  const tokenIsToken0 = usePoolTokenOrder(pool, token)

  const publicClient = usePublicClient()

  const { data: gross, isError } = useQuery({
    queryKey: ['claimable-fees', lpLock, tokenId?.toString()],
    enabled: !!publicClient && !!lpLock && tokenId !== undefined,
    refetchInterval: FEES_POLL_MS,
    // A simulation is a question about right now, so a cached answer is a stale one.
    staleTime: 0,
    queryFn: async () => {
      const { result } = await publicClient!.simulateContract({
        address: lpLock!,
        abi: lpLockAbi,
        functionName: 'collect',
        args: [tokenId!],
      })
      return result
    },
  })

  if (gross === undefined || tokenIsToken0 === undefined || creatorFeeBps === undefined) {
    return { ...UNKNOWN, isError }
  }

  const grossByAsset = byPoolOrder(gross[0], gross[1], tokenIsToken0)

  return { ...splitCreatorFees(grossByAsset.token, grossByAsset.weth, creatorFeeBps), isError }
}
