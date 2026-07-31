import { useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import { useReadContract } from 'wagmi'
import { launchTokenAbi } from '../abi/launchToken'
import { gatewayUrls } from '../lib/ipfs'
import { isImageSuppressed } from '../lib/denylist'
import { fetchTokenMetadata, type TokenMetadata } from '../lib/tokenMetadata'

/**
 * Resolve a token's `metadataURI` to renderable metadata.
 *
 * The caching policy is the substance of this hook, and it follows from the contract rather than
 * from taste. `metadataURI` has no setter and a CID addresses exactly one document, so the answer
 * for a given URI **cannot change** - which makes `staleTime: Infinity` not merely an optimisation
 * but the correct semantics. It is also load-bearing: the board polls every 5 seconds, and without
 * it every poll would refire a fetch per card, each able to burn the full gateway timeout on the
 * unpinned CIDs that are the common case. That is the difference between a quiet page and a
 * permanent stream of doomed requests.
 *
 * `retry: false` for the same reason. react-query's default retries assume a transient fault, but
 * the overwhelmingly likely cause here is a CID nobody ever pinned, where a retry is guaranteed to
 * fail again after another timeout. The cost is that a genuine gateway blip sticks until the page
 * is reloaded; that is the right trade when the alternative is tripling the load on free public
 * infrastructure to chase a permanent failure.
 */
export function useTokenMetadata(
  address: string | undefined,
  uri: string | undefined,
): TokenMetadata | null {
  // A suppressed token's picture is never rendered, so fetching it would be pure waste - and would
  // put a request for content we have judged abusive onto a third-party gateway on every page view.
  const suppressed = isImageSuppressed(address)
  const urls = suppressed ? [] : gatewayUrls(uri)

  const { data } = useQuery({
    // Keyed on the URI, not the address: two launches pointing at the same CID are the same
    // document and should share one fetch and one cache entry.
    queryKey: ['tokenMetadata', uri],
    queryFn: () => fetchTokenMetadata(uri!),
    // An empty URI, an `http://` one, or anything that is not a CID produces no candidate URLs, and
    // must resolve to the identicon without a request ever being made.
    enabled: urls.length > 0,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  })

  return suppressed ? null : (data ?? null)
}

/**
 * Read `metadataURI` straight from the token contract.
 *
 * Deliberately its own read rather than an extra entry in `useOnchainToken`'s round-1 multicall,
 * even though that would have cost no additional round trip. `useOnchainToken` resolves to a union
 * that is the trade path's decision table, and metadata is cosmetic: a token whose `metadataURI`
 * read fails still trades perfectly well. Threading it through that union would put a decorative
 * field into the one type whose states each mean something about whether it is safe to spend money,
 * which is a seam worth one cached `eth_call` to keep clean.
 *
 * `staleTime: Infinity` because the value is immutable on-chain, exactly as in `useOnchainToken`'s
 * round 1.
 */
export function useOnchainMetadataUri(token: Address | undefined): string | undefined {
  const { data } = useReadContract({
    address: token,
    abi: launchTokenAbi,
    functionName: 'metadataURI',
    query: { enabled: !!token, staleTime: Infinity, gcTime: Infinity, retry: false },
  })
  return data
}
