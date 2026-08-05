import { useReadContracts } from 'wagmi'
import type { Address } from 'viem'
import { lpLockAbi } from '../abi/lpLock'
import { isKnownReclaimBlocker, ReclaimBlocker } from '../lib/lock'
import { usePeriphery } from './usePeriphery'

/**
 * A graduated position's reclaim verdict, read live from `LPLock`.
 *
 * ⚠️ **This cannot come from the indexer, which is the whole reason the hook exists.** Two of
 * `reclaim`'s conditions are indexed - the lock term, and whether it has already been reclaimed -
 * but the decisive one is not. `reclaim` also requires the POOL to have gone without activity for
 * `inactivityPeriod`, which `LPLock` reads live out of the pool's own oracle observation. No event
 * carries it, so no subgraph can know it, and a page that showed only the indexed half would tell a
 * reader an expired lock is reclaimable when the pool is still trading every block.
 *
 * `inactivityPeriod` is likewise read rather than assumed: it is the one lock term NOT frozen per
 * position, its setter is monotonic, and an owner may lengthen it at any time.
 */

/** Poll slowly. None of these values move on a human timescale - the fastest is a 180-day counter. */
const RECLAIM_POLL_MS = 60_000

export interface ReclaimStatus {
  /** Undefined until the read lands, or when it fails. Never guessed. */
  blocker: ReclaimBlocker | undefined
  /** Seconds since the pool last recorded a swap, mint or burn. */
  secondsSinceActivity: number | undefined
  /** Seconds of quiet `reclaim` requires. Read live, never cached across launches. */
  inactivityPeriod: number | undefined
  /** True when the chain answered with a blocker value this build does not recognise. */
  unknownBlocker: boolean
  isError: boolean
}

export function useReclaimStatus(
  tokenId: bigint | undefined,
  pool: Address | undefined,
): ReclaimStatus {
  const { lpLock } = usePeriphery()
  const enabled = !!lpLock && tokenId !== undefined && !!pool

  const { data, isError } = useReadContracts({
    allowFailure: true,
    contracts: [
      {
        address: lpLock,
        abi: lpLockAbi,
        functionName: 'reclaimBlocker',
        args: tokenId !== undefined ? [tokenId] : undefined,
      },
      {
        address: lpLock,
        abi: lpLockAbi,
        functionName: 'secondsSincePoolActivity',
        args: pool ? [pool] : undefined,
      },
      { address: lpLock, abi: lpLockAbi, functionName: 'inactivityPeriod' },
    ],
    query: { enabled, refetchInterval: RECLAIM_POLL_MS },
  })

  const blockerEntry = data?.[0]
  const rawBlocker = blockerEntry?.status === 'success' ? Number(blockerEntry.result) : undefined
  // A value outside the enum means the deployed LPLock carries a condition this build predates.
  // Reported as its own state rather than mapped onto a neighbour's copy - the neighbour's copy
  // would be a confident, specific, wrong explanation of why locked liquidity cannot be released.
  const known = rawBlocker !== undefined && isKnownReclaimBlocker(rawBlocker)

  const activity = data?.[1]
  const period = data?.[2]

  return {
    blocker: known ? (rawBlocker as ReclaimBlocker) : undefined,
    secondsSinceActivity: activity?.status === 'success' ? Number(activity.result) : undefined,
    inactivityPeriod: period?.status === 'success' ? Number(period.result) : undefined,
    unknownBlocker: rawBlocker !== undefined && !known,
    isError: isError || blockerEntry?.status === 'failure',
  }
}
