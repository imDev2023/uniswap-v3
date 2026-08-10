// Stage 4: RPC is the only component in the stack with no graceful degradation. The indexer can go
// down and trading survives (Stage 2); if RPC goes down there is nothing left to fall back to.
//
// So the frontend takes an ordered LIST of endpoints rather than a single URL, and wires them into
// viem's `fallback` transport. This module owns the ordering decision as a pure function, so the
// policy is testable without a browser, a chain, or import.meta.env.

/** Ordered inputs for endpoint resolution. Any of them may be missing or blank. */
export interface RpcEndpointInput {
  /**
   * A same-origin proxy that holds the credential SERVER-side, resolved by `resolveProxyUrl`.
   *
   * First preference when it exists, because it is the only entry that can be both a metered
   * provider and free of key material in the bundle. See `resolveProxyUrl` for why the app must be
   * told explicitly that a proxy exists rather than assuming one.
   */
  proxy?: string
  /**
   * VITE_RPC_URL - the preferred DIRECT endpoint.
   *
   * Inlined into the bundle by Vite, so it is public by construction and must never carry a
   * credential. `vite.config.ts` fails the build over one that does.
   */
  primary?: string
  /** VITE_RPC_URL_2 - an independent second provider, for failover. Public, exactly like primary. */
  secondary?: string
  /** The chain's documented public endpoint. Always known, never a secret. */
  publicDefault: string
}

const clean = (u: string | undefined): string | null => {
  const trimmed = (u ?? '').trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Resolve the configured proxy path against the page's own origin, or `null` if there is no proxy.
 *
 * The app has to be TOLD that a proxy exists (`VITE_RPC_PROXY_PATH`) rather than assuming one,
 * because assuming is unrecoverable in the case that matters: on a static host with no `/rpc` route
 * the request returns an HTML 404, which is a perfectly successful HTTP response carrying a body
 * viem cannot parse. That is not a transport error, so it is not obviously something `fallback`
 * advances past, and every read in the app would pay for the round trip. An explicit flag makes the
 * unconfigured case byte-for-byte the behaviour we already ship.
 *
 * Resolution is to an ABSOLUTE URL rather than leaving the path relative, so the transport does not
 * depend on how any given HTTP client treats a relative target.
 *
 * An absolute `path` is honoured as-is, which is what lets a deployment put the proxy on a separate
 * origin from the app. ⚠️ That case is no longer same-origin, so the proxy has to send CORS headers
 * the app's origin satisfies, and the browser will preflight. Same origin needs none of that, which
 * is why `/rpc` is the documented default.
 */
export function resolveProxyUrl(
  path: string | undefined,
  origin: string | undefined,
): string | null {
  const configured = clean(path)
  if (configured === null) return null

  try {
    return new URL(configured).toString()
  } catch {
    // Relative, which is the ordinary case: it needs the page's origin to become absolute.
  }

  const base = clean(origin)
  if (base === null) return null
  try {
    return new URL(configured, base).toString()
  } catch {
    return null
  }
}

/**
 * Resolve the ordered endpoint list for a chain.
 *
 * Order is strict preference, not a race: proxy, then primary, then secondary, then the public
 * endpoint. viem's `fallback` only advances when the one before it fails, so a healthy first entry
 * serves every request and the others cost nothing.
 *
 * The proxy leads because it is the only entry that can be a metered, dedicated provider without
 * publishing its credential: the key stays on the server that answers the path, and the browser
 * only ever knows an origin it was already talking to.
 *
 * The public endpoint is always appended as a last resort. It is rate limited and explicitly "not
 * recommended for production" by Robinhood, but RPC has no graceful degradation - a throttled app
 * beats a dead one. Callers that genuinely want to pin a single endpoint can pass it as
 * `publicDefault` with no primary or secondary.
 *
 * Duplicates are removed so that leaving VITE_RPC_URL unset (or pointing it at the public endpoint)
 * does not produce a list that retries the same URL twice and calls it redundancy.
 */
export function resolveRpcUrls({
  proxy,
  primary,
  secondary,
  publicDefault,
}: RpcEndpointInput): string[] {
  const ordered = [clean(proxy), clean(primary), clean(secondary), clean(publicDefault)]
  const seen = new Set<string>()
  const urls: string[] = []
  for (const url of ordered) {
    if (url === null || seen.has(url)) continue
    seen.add(url)
    urls.push(url)
  }
  // publicDefault is a compile-time constant per chain, so this can only be empty if a caller
  // passes junk. Failing loudly beats handing viem an empty transport list, which throws later and
  // further from the cause.
  if (urls.length === 0) throw new Error('resolveRpcUrls: no usable RPC endpoint')
  return urls
}
