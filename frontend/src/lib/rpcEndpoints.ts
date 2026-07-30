// Stage 4: RPC is the only component in the stack with no graceful degradation. The indexer can go
// down and trading survives (Stage 2); if RPC goes down there is nothing left to fall back to.
//
// So the frontend takes an ordered LIST of endpoints rather than a single URL, and wires them into
// viem's `fallback` transport. This module owns the ordering decision as a pure function, so the
// policy is testable without a browser, a chain, or import.meta.env.

/** Ordered inputs for endpoint resolution. Any of them may be missing or blank. */
export interface RpcEndpointInput {
  /** VITE_RPC_URL - the dedicated/paid endpoint a production build should prefer. */
  primary?: string
  /** VITE_RPC_URL_2 - an independent second provider, for failover. */
  secondary?: string
  /** The chain's documented public endpoint. Always known, never a secret. */
  publicDefault: string
}

const clean = (u: string | undefined): string | null => {
  const trimmed = (u ?? '').trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Resolve the ordered endpoint list for a chain.
 *
 * Order is strict preference, not a race: primary, then secondary, then the public endpoint. viem's
 * `fallback` only advances when the one before it fails, so a healthy primary serves every request
 * and the others cost nothing.
 *
 * The public endpoint is always appended as a last resort. It is rate limited and explicitly "not
 * recommended for production" by Robinhood, but RPC has no graceful degradation - a throttled app
 * beats a dead one. Callers that genuinely want to pin a single endpoint can pass it as
 * `publicDefault` with no primary or secondary.
 *
 * Duplicates are removed so that leaving VITE_RPC_URL unset (or pointing it at the public endpoint)
 * does not produce a list that retries the same URL twice and calls it redundancy.
 */
export function resolveRpcUrls({ primary, secondary, publicDefault }: RpcEndpointInput): string[] {
  const ordered = [clean(primary), clean(secondary), clean(publicDefault)]
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
