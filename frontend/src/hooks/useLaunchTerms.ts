import type { Address } from 'viem'
import { useReadContracts } from 'wagmi'
import { devVestingAbi } from '../abi/devVesting'
import { launchpadFactoryAbi } from '../abi/launchpadFactory'
import { FACTORY_ADDRESS, isLaunchpadConfigured } from '../config/contracts'
import { usePeriphery } from './usePeriphery'

/**
 * One launch's frozen terms, read from the CHAIN.
 *
 * ⚠️ **This hook exists because the lock and vesting panels used to vanish during an indexer
 * outage**, which was found by loading the page rather than by any test. Both were gated on the
 * indexed token row, so with graph-node down the page silently dropped the panel a buyer reads to
 * find out whether the liquidity is locked - and dropped the creator's claim button with it, even
 * though `claim` is a plain chain call that never touches the read model.
 *
 * Everything here is frozen at `createLaunch` and can never change, so the indexer was only ever a
 * second route to the same immutable facts. Reading them directly follows the Stage-2 split already
 * used for the trade path: the chain is authoritative and always available, and the read model is
 * for things only it knows.
 *
 * What still comes from the indexer, deliberately: the realised `Lock` record (its `lockUntil`,
 * `extendCount` and reclaim outcome), which is keyed by position-NFT id and only exists after
 * graduation. That panel degrades on its own and says so.
 */

/** All frozen. Fetched once and never refetched - except `claimed`, see below. */
const FROZEN = { staleTime: Infinity, gcTime: Infinity } as const

/** `claimed` moves whenever the creator claims, so the grant is re-read on a slow interval. */
const GRANT_POLL_MS = 15_000

export interface LaunchTerms {
  /** Seconds the LP stays locked from graduation. Undefined until read; meaningless when permanent. */
  lockDuration: bigint | undefined
  /** The creator's share of the graduated position's LP fees, in bps. */
  creatorFeeBps: number | undefined
  /** The creator's permanent-lock CHOICE at creation. Not the realised state - see `Lock.permanent`. */
  permanentLock: boolean | undefined
  /** Tokens carved for the creator. 0n means no carve; undefined means not read yet. */
  devAllocation: bigint | undefined
  /** The grant's own vesting window, frozen at creation. Not the factory's current setting. */
  vestingDuration: bigint | undefined
  /** Cumulative tokens the creator has actually claimed. Exact, not as-of-the-last-indexed-event. */
  devClaimed: bigint | undefined
  /** What `claim` would pay right now. */
  claimable: bigint | undefined
  /**
   * The grant's beneficiary.
   *
   * ⚠️ Taken from the grant rather than from `factory.creatorOf` or the indexed row, because this is
   * the address `claim` will actually pay - it is frozen inside the grant and the function takes no
   * recipient. Deciding who to show a claim button to from any other source is deciding it from
   * something that is merely expected to agree.
   */
  creator: Address | undefined
}

export function useLaunchTerms(token: Address | undefined): LaunchTerms {
  const { devVesting } = usePeriphery()

  const { data: lockCfg } = useReadContracts({
    allowFailure: true,
    contracts: [
      {
        address: FACTORY_ADDRESS,
        abi: launchpadFactoryAbi,
        functionName: 'lockConfigOf',
        args: token ? [token] : undefined,
      },
      {
        address: FACTORY_ADDRESS,
        abi: launchpadFactoryAbi,
        functionName: 'devAllocationOf',
        args: token ? [token] : undefined,
      },
    ],
    query: { enabled: isLaunchpadConfigured && !!token, ...FROZEN },
  })

  const { data: grantData } = useReadContracts({
    allowFailure: true,
    contracts: [
      {
        address: devVesting,
        abi: devVestingAbi,
        functionName: 'grantOf',
        args: token ? [token] : undefined,
      },
      {
        address: devVesting,
        abi: devVestingAbi,
        functionName: 'claimable',
        args: token ? [token] : undefined,
      },
    ],
    query: { enabled: !!devVesting && !!token, refetchInterval: GRANT_POLL_MS },
  })

  const cfg = lockCfg?.[0]
  const alloc = lockCfg?.[1]
  const grantEntry = grantData?.[0]
  const claimableEntry = grantData?.[1]
  const grant = grantEntry?.status === 'success' ? grantEntry.result : undefined

  return {
    // ⚠️ Left `undefined` on a failed read rather than defaulted. A zero lock duration renders as
    // "Term: none" - a claim that the liquidity is not locked, on the panel where that is the
    // single worst thing to get wrong.
    lockDuration: cfg?.status === 'success' ? cfg.result[0] : undefined,
    creatorFeeBps: cfg?.status === 'success' ? Number(cfg.result[1]) : undefined,
    permanentLock: cfg?.status === 'success' ? cfg.result[2] : undefined,
    devAllocation: alloc?.status === 'success' ? alloc.result : undefined,
    // ⚠️ The grant's OWN duration, not `factory.vestingDuration()`. The factory's value is the
    // current owner setting and applies to future launches only; a launch created before a retune
    // keeps the window it was created with, and quoting the new one would misstate a live schedule.
    vestingDuration: grant ? grant.duration : undefined,
    devClaimed: grant ? grant.claimed : undefined,
    claimable: claimableEntry?.status === 'success' ? claimableEntry.result : undefined,
    creator: grant ? grant.creator : undefined,
  }
}
