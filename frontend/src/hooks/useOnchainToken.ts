import { useMemo } from 'react'
import type { Address } from 'viem'
import { useReadContracts } from 'wagmi'
import { bondingCurveAbi } from '../abi/bondingCurve'
import { erc20Abi } from '../abi/erc20'
import { launchpadFactoryAbi } from '../abi/launchpadFactory'
import { uniswapV3FactoryAbi } from '../abi/uniswapV3Factory'
import { WETH9_ADDRESS } from '../config/chain'
import { POOL_FEE_TIER } from '../config/constants'
import { FACTORY_ADDRESS, isLaunchpadConfigured } from '../config/contracts'
import { resolveOnchainToken, type OnchainToken } from '../lib/onchainToken'

// RPC-first token resolution (Stage 2). Two rounds, because the second round's targets are
// addresses the first round returns:
//
//   round 1 - launchpad.curveOf(token), launchpad.v3Factory(), token.name(), token.symbol()
//   round 2 - curve.graduated(), v3Factory.getPool(token, WETH, POOL_FEE_TIER)
//
// Multicall3 is declared on both chains (config/chain.ts), so each round is one eth_call at a single
// block rather than four then two.

/** Round 1 is all immutable data - never refetch it once it lands. */
const IMMUTABLE = { staleTime: Infinity, gcTime: Infinity } as const

/**
 * `graduated` and the pool address flip exactly once in a token's life, but that flip is the whole
 * point of the page - a live curve becomes a swap. Poll slowly enough to be cheap, fast enough that
 * someone watching a curve fill sees it happen.
 */
const GRADUATION_POLL_MS = 10_000

/**
 * Everything the trade path needs about a token, from RPC alone. Never touches the subgraph, so it
 * keeps working through an indexer outage.
 */
export function useOnchainToken(token: Address | undefined): OnchainToken {
  const canRead = isLaunchpadConfigured && !!token

  const { data: round1, isError: round1Error } = useReadContracts({
    allowFailure: true,
    contracts: [
      {
        address: FACTORY_ADDRESS,
        abi: launchpadFactoryAbi,
        functionName: 'curveOf',
        args: token ? [token] : undefined,
      },
      { address: FACTORY_ADDRESS, abi: launchpadFactoryAbi, functionName: 'v3Factory' },
      { address: token, abi: erc20Abi, functionName: 'name' },
      { address: token, abi: erc20Abi, functionName: 'symbol' },
    ],
    query: { enabled: canRead, ...IMMUTABLE },
  })

  const curveResult = round1?.[0]
  const v3FactoryResult = round1?.[1]
  const curve = curveResult?.status === 'success' ? curveResult.result : undefined
  const v3Factory =
    v3FactoryResult?.status === 'success' ? v3FactoryResult.result : undefined

  const { data: round2, isError: round2Error } = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: curve, abi: bondingCurveAbi, functionName: 'graduated' },
      {
        address: v3Factory,
        abi: uniswapV3FactoryAbi,
        functionName: 'getPool',
        args: token ? [token, WETH9_ADDRESS, POOL_FEE_TIER] : undefined,
      },
    ],
    query: { enabled: canRead && !!curve && !!v3Factory, refetchInterval: GRADUATION_POLL_MS },
  })

  const graduatedResult = round2?.[0]
  const poolResult = round2?.[1]

  return useMemo(
    () =>
      resolveOnchainToken({
        configured: isLaunchpadConfigured,
        curve,
        // Two ways a read fails: viem maps a transport failure onto each entry as `status:
        // 'failure'` (confirmed against a refused connection and against a 503), and react-query
        // surfaces a whole-query rejection as isError. Both are checked so the money path's
        // "unreachable" state does not depend on which of the two a given failure takes.
        curveError: curveResult?.status === 'failure' || round1Error,
        graduated:
          graduatedResult?.status === 'success' ? graduatedResult.result : undefined,
        graduatedError: graduatedResult?.status === 'failure' || round2Error,
        pool: poolResult?.status === 'success' ? poolResult.result : undefined,
        // A failed v3Factory read is a failed pool lookup: round 2 never runs, so without this the
        // graduated path would wait on a `pool` that is never coming.
        poolError:
          poolResult?.status === 'failure' ||
          v3FactoryResult?.status === 'failure' ||
          round2Error,
        name: round1?.[2]?.status === 'success' ? round1[2].result : undefined,
        symbol: round1?.[3]?.status === 'success' ? round1[3].result : undefined,
      }),
    // round1/round2 are the only real inputs; every other value above is derived from them.
    [round1, round2, round1Error, round2Error, curve],
  )
}
