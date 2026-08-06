import { useReadContracts } from 'wagmi'
import type { Address } from 'viem'
import { uniswapV3PoolAbi } from '../abi/uniswapV3Pool'

/**
 * Whether a launch token is its pool's `token0`.
 *
 * V3 sorts a pool's pair by address, so the launch token is `token0` on some launches and `token1`
 * on others. Any `amount0`/`amount1` pair coming off a pool or off `LPLock` is meaningless until
 * this is known: reading it backwards reports WETH amounts as launch tokens, which is the right
 * shape, the wrong asset, and wrong by many orders of magnitude.
 *
 * ⚠️ **This deliberately lives on the client rather than in the subgraph, and that is a scar.** The
 * #39 mapping originally called `token0()` from `handleLockRegistered`. Against the real chain that
 * DEADLOCKED the whole subgraph: our RPC prunes state, so a historical `eth_call` came back
 * `missing trie node`, and graph-node retried it forever while still reporting `healthy` with no
 * `fatalError` and `synced: false`. Read at the chain head, which is all a client ever needs, the
 * same call is cheap and reliable. Anything a handler would have to ask an archive node belongs
 * here instead.
 *
 * ⚠️ `undefined` means the read has not landed. There is no safe default: guessing `token0` would be
 * right about half the time and confidently wrong the rest.
 */

/** A pool's pair can never change, so this is fetched once and never refetched. */
const IMMUTABLE = { staleTime: Infinity, gcTime: Infinity } as const

export function usePoolTokenOrder(
  pool: Address | undefined,
  token: Address | undefined,
): boolean | undefined {
  const { data } = useReadContracts({
    allowFailure: true,
    contracts: [{ address: pool, abi: uniswapV3PoolAbi, functionName: 'token0' }],
    query: { enabled: !!pool && !!token, ...IMMUTABLE },
  })

  const token0 = data?.[0]?.status === 'success' ? data[0].result : undefined
  if (token0 === undefined || !token) return undefined

  // ⚠️ Case-insensitive: viem returns checksummed addresses from a contract read, while a token
  // address taken from a route param arrives lowercased. A strict comparison would silently take
  // the token1 branch and swap both assets.
  return token0.toLowerCase() === token.toLowerCase()
}
