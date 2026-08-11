// The one rule the RPC proxy has to get right, in one place.
//
// Two different servers answer `VITE_RPC_PROXY_PATH` in this project: `vite.config.ts` in `dev` and
// `preview`, and `functions/rpc.ts` on Cloudflare Pages in production. They are built on completely
// different plumbing - http-proxy in one, the Workers `fetch` in the other - and if their idea of
// "where does this request actually go" ever diverges, the difference shows up only in production,
// only as a 404 from a provider, and only for whoever deployed last.
//
// So neither of them decides it. Both ask this module, which is pure, has no Node and no Workers
// dependency, and is tested on its own.
//
// ⚠️ THE RULE: the incoming request path contributes NOTHING to the outgoing URL.
//
// That is not the obvious behaviour, and getting it wrong is the mistake this module exists to
// prevent. A proxy that JOINS paths - which is http-proxy's default, and the natural way to write a
// `fetch` forwarder by hand - turns an upstream of `https://host/v2/<key>` plus an incoming `/rpc`
// into `https://host/v2/<key>/rpc`, which every managed provider answers with a 404. The key is a
// PATH SEGMENT at Alchemy, QuickNode and Infura alike, so the upstream URL is already complete and
// the only correct thing to do with the request path is discard it.

/** An upstream endpoint, decomposed for the two servers that have to forward to it. */
export interface UpstreamTarget {
  /** Scheme + host + port. What http-proxy is pointed at, since it insists on joining paths. */
  origin: string
  /**
   * Path and query of the upstream, including the credential.
   *
   * What http-proxy's `rewrite` returns, REPLACING the incoming path rather than appending to it.
   */
  pathAndSearch: string
  /**
   * The complete URL to request, credential included.
   *
   * Exactly `origin + pathAndSearch`, which is what makes the two servers provably equivalent -
   * see the round-trip test. A `fetch`-based forwarder wants this and needs no rewriting at all.
   */
  href: string
}

/**
 * Decompose a configured upstream endpoint.
 *
 * Throws rather than returning a fallback. A misconfigured upstream is not a degraded mode: there
 * is nothing sensible to forward to, and the alternative - quietly proxying to some default - would
 * send the app's traffic somewhere nobody chose. The message never contains the input, because the
 * input is the credential.
 *
 * @param upstream The value of `RPC_UPSTREAM_URL`.
 */
export function parseUpstream(upstream: string): UpstreamTarget {
  const raw = upstream.trim()
  if (raw === '') throw new Error('RPC upstream is empty')

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('RPC upstream is not a valid absolute URL')
  }

  // A `file:` or `ws:` upstream is a configuration mistake that would otherwise surface as an
  // obscure runtime failure inside whichever forwarder happened to receive it first.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`RPC upstream must be http or https, not ${url.protocol}`)
  }

  const pathAndSearch = `${url.pathname}${url.search}`
  return {
    origin: url.origin,
    pathAndSearch,
    // Built by concatenation on purpose rather than read from `url.href`, so that `href` is the
    // composition of the two fields above BY CONSTRUCTION. `url.href` would also carry a fragment,
    // which is meaningless to a server and is never sent, and the two would then disagree.
    href: `${url.origin}${pathAndSearch}`,
  }
}
