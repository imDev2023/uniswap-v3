/**
 * Resolve a token's on-chain `metadataURI` to fetchable HTTP URLs.
 *
 * `LaunchToken.metadataURI` is set at creation and has no setter, for anyone (build #24). That
 * immutability is the whole design of this module:
 *
 *  - **A broken URI is permanent.** A typo, an unpinned CID or a dead host can never be corrected,
 *    so the failure path is the common path rather than an edge case. On testnet today NONE of the
 *    twelve launches resolves to usable metadata: nine carry no URI at all, two point at CIDs that
 *    are structurally valid but were never pinned, and `META`'s CID resolves 200 with a zero-byte
 *    body. Every one of those must land on the identicon without drama.
 *  - **Content can be cached forever.** The bytes behind a CID cannot change, so callers set
 *    `staleTime: Infinity` rather than re-fetching on the board's 5s poll.
 *
 * ⚠️ **A per-attempt timeout is mandatory, and is the real fix here - not the choice of gateway.**
 * Measured against the seeded testnet CIDs: an unpinned CID hangs `dweb.link` for **28 seconds**
 * before it answers 504, because the gateway walks the DHT looking for a provider that does not
 * exist. `w3s.link` refuses the same CID in 0.13s. Without our own deadline a board of forty cards
 * would sit on dozens of half-minute requests; with one, gateway ORDER stops mattering for latency,
 * since either ordering costs about the same on an unresolvable URI.
 */

/**
 * Gateways to try, in order.
 *
 * Deliberately operated by **different organisations**: the only reason a fallback exists is an
 * outage, so a fallback sharing an operator with the primary is barely a fallback at all. This is
 * why the two most famous gateways are not paired - `ipfs.io` and `dweb.link` are both Protocol
 * Labs, and one incident takes out both. `w3s.link` is Storacha.
 *
 * `dweb.link` leads because it walks the DHT and so has the broadest view of what is pinned
 * anywhere, which is the case that matters when a creator pins their own image on a small service.
 * Both are keyless (v1 is bring-your-own-URI, with no account and no pinning service), and both
 * were measured serving `Access-Control-Allow-Origin: *`, without which the browser could not read
 * the JSON at all.
 *
 * Path form rather than `<cid>.ipfs.<gateway>` subdomain form: both gateways redirect path to
 * subdomain themselves, `fetch` follows that transparently, and path form is the one spelling that
 * works for CIDv0 (`Qm…`, base58 and case-sensitive) as well as CIDv1.
 */
export const IPFS_GATEWAYS = ['https://dweb.link', 'https://w3s.link'] as const

/**
 * Deadline for a single gateway attempt.
 *
 * Above the ~0.1-0.3s a warm hit takes by two orders of magnitude, and far below the 28s an
 * unpinned CID otherwise costs. Two gateways means an unresolvable URI settles on the identicon in
 * ~16s worst case while a real one paints almost immediately.
 */
export const GATEWAY_TIMEOUT_MS = 8_000

/** CIDv0: base58btc, always 46 chars starting `Qm`. */
const CID_V0 = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/
/** CIDv1 in base32 (the `baf…` spelling every modern tool emits): lowercase base32, `b` multibase. */
const CID_V1_B32 = /^b[a-z2-7]{20,}$/

function looksLikeCid(s: string): boolean {
  return CID_V0.test(s) || CID_V1_B32.test(s)
}

/**
 * Build one gateway URL, or `null` if the result would escape the gateway's `/ipfs/` namespace.
 *
 * The origin and prefix assertions are the security boundary, and they are cheap because `URL`
 * normalises for us: a URI of `ipfs://cid/../../admin` resolves to `/admin`, fails the prefix check
 * and is dropped. Building the string by concatenation instead would have happily produced it.
 */
function ipfsGatewayUrl(gateway: string, rest: string): string | null {
  try {
    const base = new URL(gateway)
    const url = new URL(`/ipfs/${rest}`, base)
    if (url.origin !== base.origin) return null
    if (!url.pathname.startsWith('/ipfs/')) return null
    return url.toString()
  } catch {
    return null
  }
}

/**
 * Every URL worth trying for a `metadataURI`, best first. Empty when the URI is unusable, which
 * callers treat as "no metadata" and render the identicon for - no request is made.
 *
 * `http://` is rejected rather than tried. The app is served over HTTPS, so the browser blocks
 * mixed content before the request leaves; returning nothing fails immediately instead of after a
 * console error and a wait. `https://` and `data:` pass through untouched - a creator may host
 * metadata anywhere, and a small JSON inlined as a data URI needs no network at all.
 */
export function gatewayUrls(uri: string | undefined | null): string[] {
  const raw = (uri ?? '').trim()
  if (!raw) return []

  if (raw.startsWith('data:')) return [raw]
  if (raw.startsWith('https://')) return [raw]
  if (raw.startsWith('http://')) return []

  let rest: string | null = null
  if (raw.startsWith('ipfs://')) {
    // `ipfs://ipfs/<cid>` is a common malformed spelling; the duplicated segment would otherwise
    // become a path component and 404 on every gateway.
    rest = raw.slice('ipfs://'.length).replace(/^ipfs\//, '')
  } else if (looksLikeCid(raw.split('/')[0])) {
    // A bare CID with no scheme is unambiguous, and is a mistake worth absorbing rather than
    // punishing with a permanently blank avatar.
    rest = raw
  }

  if (!rest) return []
  rest = rest.replace(/^\/+/, '')
  if (!rest) return []

  return IPFS_GATEWAYS.map((g) => ipfsGatewayUrl(g, rest as string)).filter(
    (u): u is string => u !== null,
  )
}

/**
 * Rewrite a URI found INSIDE a metadata document (its `image` or `banner`) to something an `<img>`
 * can load. Returns `undefined` when nothing usable can be built.
 *
 * Needed because metadata routinely nests one IPFS URI inside another: the widely-pinned NFT JSON
 * used to validate this path holds `"image": "ipfs://Qm…"`, so resolving the document is only half
 * the job. Only the first gateway is used - an `<img>` has one `src`, and its own `onError` already
 * falls through to the identicon.
 */
export function resolveMediaUrl(uri: string | undefined | null): string | undefined {
  return gatewayUrls(uri)[0]
}
