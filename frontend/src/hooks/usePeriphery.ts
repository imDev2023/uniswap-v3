import { useReadContracts } from 'wagmi'
import type { Address } from 'viem'
import { zeroAddress } from 'viem'
import { launchpadFactoryAbi } from '../abi/launchpadFactory'
import { FACTORY_ADDRESS, isLaunchpadConfigured } from '../config/contracts'

/**
 * The addresses of the three periphery contracts the token page reads directly.
 *
 * ⚠️ Read from the factory, not from env vars, and that is an ADR-0003 decision rather than a
 * convenience: `LPLock`, `DevVesting` and `GraduationManager` are all deployed by the factory's own
 * constructor, so the factory is the only source that cannot disagree with itself. Three more
 * `VITE_*` variables would be three more things to forget at the #38 redeploy, and a stale
 * `DevVesting` address does not error - it reads zero and renders as "this launch has no carve",
 * which is a lie that looks like data.
 *
 * Immutable once deployed, so this is fetched once and never refetched.
 */
const IMMUTABLE = { staleTime: Infinity, gcTime: Infinity } as const

export interface PeripheryAddresses {
  devVesting: Address | undefined
  lpLock: Address | undefined
  graduationManager: Address | undefined
}

export function usePeriphery(): PeripheryAddresses {
  const { data } = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: FACTORY_ADDRESS, abi: launchpadFactoryAbi, functionName: 'devVesting' },
      { address: FACTORY_ADDRESS, abi: launchpadFactoryAbi, functionName: 'lpLock' },
      { address: FACTORY_ADDRESS, abi: launchpadFactoryAbi, functionName: 'graduationManager' },
    ],
    query: { enabled: isLaunchpadConfigured, ...IMMUTABLE },
  })

  return {
    devVesting: usable(data?.[0]),
    lpLock: usable(data?.[1]),
    graduationManager: usable(data?.[2]),
  }
}

/**
 * A successful read of the zero address is treated as "not available", not as an address.
 *
 * ⚠️ This is the guard that keeps a misconfigured deployment from rendering as a factual absence.
 * Calling a view on the zero address does not throw - it returns empty data that decodes to zero -
 * so without this a page would confidently show "no dev allocation" and "not reclaimable" for every
 * launch on the chain.
 */
function usable(entry: { status: 'success'; result: Address } | { status: 'failure' } | undefined) {
  if (!entry || entry.status !== 'success') return undefined
  return entry.result === zeroAddress ? undefined : entry.result
}
