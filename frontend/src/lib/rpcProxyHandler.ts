import { parseUpstream } from './rpcUpstream'
import { redactCredentials } from './rpcCredentials'
import { apiSecurityHeaders } from './securityHeaders'

// The production half of Stage 4 key protection, as a plain function of a Request.
//
// `vite.config.ts` serves `VITE_RPC_PROXY_PATH` in `dev` and `preview` only. A deployed static host
// serves nothing there, which is why a production build previously had to run on the public
// endpoint or ship an allowlisted key in the bundle. This is the route that removes that choice.
//
// It lives here, and not in `functions/rpc.ts`, so that the behaviour is testable in the ordinary
// frontend suite rather than only by deploying. `functions/rpc.ts` is a five-line adapter that
// supplies Cloudflare's calling convention and nothing else - there is no logic there to get wrong,
// and therefore nothing there that only production can falsify.
//
// ⚠️ THE BUILD-TIME / RUN-TIME SPLIT, which is the thing most easily got wrong:
//
//   VITE_RPC_PROXY_PATH=/rpc   BUILD environment. Vite inlines it into the bundle, and it is
//                              public by construction - it names a route, not a secret.
//   RPC_UPSTREAM_URL           RUN-TIME secret on the Function, via `wrangler pages secret put`.
//                              It must NEVER be a build variable. Nothing needs it to be: Vite
//                              reads it only to run its own dev proxy, and a production build has
//                              no dev proxy to run.
//
// ⚠️ WHAT THIS DOES NOT BUY. A proxy is a boundary against THEFT, not against USE. Anyone who can
// reach the site can send JSON-RPC through this route, so the exposure moves from "the key can be
// extracted and spent anywhere" to "our origin can be used as an RPC". Only the second is fixable
// after the fact, which is what makes it the better position rather than a solved problem. Capping
// USE is a platform concern - a Cloudflare rate-limiting rule on this path - deliberately not
// attempted in application code, where it could only be a worse version of the same thing.
//
// No CORS headers are sent, on purpose. The route is same-origin with the app, so it needs none,
// and adding them would invite every other site to spend the quota.
//
// ⚠️ A SEPARATE-ORIGIN PROXY IS THEREFORE NOT SERVED BY THIS FUNCTION. `resolveProxyUrl` accepts an
// absolute `VITE_RPC_PROXY_PATH`, so the CLIENT can be pointed at another origin, but this handler
// answers such a deployment with 403 (`crossSite`) and would, even without that, send no
// `Access-Control-Allow-Origin` for the browser to accept. Both halves have to be added
// deliberately, together, by whoever wants that topology. Pinned by a test so it is a known
// limitation rather than a surprise.
//
// ⚠️ ABSENT CORS IS NOT ABSENT ACCESS, and the deployed edge proved it. A cross-site page cannot
// READ this route's response without `Access-Control-Allow-Origin` - measured against Cloudflare on
// 2026-08-11, which adds one to static assets and leaves this Function clean - but a request whose
// content-type is CORS-simple is never preflighted, so it still arrives, is still forwarded, and
// still costs a metered upstream call. Verified in production: a `content-type: text/plain` POST
// carrying `Origin: https://evil.example` returned 200 and a real `eth_chainId` result. Blind to the
// caller, billed to us. `Sec-Fetch-Site` closes exactly that, and nothing wider - see `crossSite`.

/** The runtime binding the proxy needs. Named for the variable, so a misconfiguration is greppable. */
export interface RpcProxyEnv {
  /** The keyed endpoint. A runtime secret, never a build variable. */
  RPC_UPSTREAM_URL?: string
}

/**
 * Largest JSON-RPC request body accepted.
 *
 * Real traffic is tiny - `src/lib/wagmi.ts` builds its transports with a bare `http(url)` and no
 * batching, so viem sends one call per request. A megabyte is far above anything the app produces
 * and far below anything worth forwarding to a metered provider on a stranger's behalf.
 */
export const MAX_BODY_BYTES = 1_000_000

/**
 * Headers every reply from this route carries.
 *
 * ⚠️ `_headers` does NOT reach a Pages Function - it is applied by the static asset layer, measured
 * against `wrangler pages dev`. Without this, the one dynamic route on the site would be the only
 * unhardened response it serves.
 */
const baseHeaders = (): Record<string, string> => ({
  // RPC answers are point-in-time chain state. Nothing between here and the browser should ever
  // serve one caller a cached copy of another caller's response.
  'cache-control': 'no-store',
  ...apiSecurityHeaders(),
})

/** JSON-RPC-shaped error, so a client that only parses JSON-RPC still receives a message. */
const rpcError = (status: number, message: string, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message } }), {
    status,
    headers: { 'content-type': 'application/json', ...baseHeaders(), ...extra },
  })

/**
 * Whether this request is a browser fetch initiated by a page on somebody else's site.
 *
 * `Sec-Fetch-Site` is set by the user agent and is a forbidden header name, so a hostile page cannot
 * forge it. It is preferred over `Origin` for a different reason than the obvious one: `Origin` is
 * equally unforgeable and IS sent on every cross-origin POST, so it would work as a signal - but
 * acting on it means comparing it to our own deployed origin, which this Function does not reliably
 * know (it is behind Cloudflare, serves several hostnames, and gets `*.pages.dev` plus any custom
 * domain). `Sec-Fetch-Site` states the RELATIONSHIP directly and needs no such comparison.
 *
 * ⚠️ Do not "simplify" this to an `Origin` check on the belief that a page can omit `Origin`. It
 * cannot, and the measurement in the header comment above shows the browser sending it.
 *
 * ⚠️ `same-site` is ALLOWED, which is a real gap on a custom apex: a sibling subdomain is same-site
 * and would pass. It costs nothing today because the deployment is `octopus-68a.pages.dev`, where
 * every other `*.pages.dev` name is cross-site. Revisit this the moment a custom apex with other
 * subdomains is chosen - the same decision that governs the HSTS `preload` directive.
 *
 * ⚠️ A MISSING header is deliberately ALLOWED, and that is the whole judgement here. Non-browser
 * clients (curl, a wallet, a server) send nothing, and refusing them would break legitimate callers
 * to stop an attacker who is not actually stopped: anyone willing to run a server can already call
 * the public endpoint directly and gains nothing by routing through us. What this does close is the
 * case that scales without the attacker paying for it - a page that spends OUR quota using OTHER
 * people's browsers. Treat it as removing the free, drive-by version of the abuse, not as an
 * authorization boundary; the platform-level cap in the header comment above is still the real one.
 */
const crossSite = (request: Request): boolean =>
  request.headers.get('sec-fetch-site') === 'cross-site'

/**
 * Forward one JSON-RPC request to the keyed upstream and return its answer.
 *
 * @param request The browser's request to the proxy path.
 * @param env The runtime bindings, carrying `RPC_UPSTREAM_URL`.
 */
export async function handleRpc(request: Request, env: RpcProxyEnv): Promise<Response> {
  // JSON-RPC is POST. Refusing everything else keeps the route from being usable as a general open
  // proxy by anything that only knows how to issue a GET, and makes the shape of legitimate traffic
  // explicit rather than incidental.
  if (request.method !== 'POST') {
    return rpcError(405, 'This endpoint accepts JSON-RPC over POST only.', { allow: 'POST' })
  }

  // Checked before the body is read and before the configuration is consulted, so a cross-site
  // caller costs one header comparison and learns nothing about whether the route is configured.
  if (crossSite(request)) {
    return rpcError(403, 'This endpoint serves same-origin requests only.')
  }

  let target
  try {
    target = parseUpstream(env.RPC_UPSTREAM_URL ?? '')
  } catch {
    // The thrown message is discarded rather than logged. `parseUpstream` keeps the input out of it,
    // but the input here IS the credential, and there is no benefit to narrowing that promise to a
    // single module. What the operator can act on is the variable name, which is in the reply.
    return rpcError(
      500,
      'The RPC proxy is not configured. Set the RPC_UPSTREAM_URL secret on this Pages project.',
    )
  }

  // Buffered rather than streamed, so the cap is enforceable: a chunked body carries no
  // Content-Length to check, and JSON-RPC bodies are small enough that buffering costs nothing.
  const body = await request.arrayBuffer()
  if (body.byteLength > MAX_BODY_BYTES) {
    return rpcError(413, 'Request body too large.')
  }

  // Headers are built from nothing rather than copied and filtered. An allowlist that forgets an
  // entry sends one header too FEW, which fails visibly; a denylist that forgets one sends the
  // visitor's cookies, Authorization or Referer to a third-party provider, which fails silently.
  //
  // Host is absent on purpose: the runtime derives it from the URL being fetched, which is what the
  // upstream needs for TLS SNI and virtual-host routing. Copying the inbound Host - our own domain -
  // is exactly the mistake `changeOrigin` exists to prevent on the Vite side.
  const upstreamRequest = new Request(target.href, {
    method: 'POST',
    headers: {
      'content-type': request.headers.get('content-type') ?? 'application/json',
      accept: 'application/json',
      'user-agent': 'octopus-rpc-proxy',
    },
    body,
  })

  let upstream: Response
  try {
    upstream = await fetch(upstreamRequest)
  } catch {
    // A network-level failure. Reported as 502 so viem's `fallback` treats it as a transport error
    // and advances to the next endpoint, rather than as a successful response carrying a body it
    // cannot parse - which is the failure mode `resolveProxyUrl` warns about for an unserved path.
    return rpcError(502, 'The upstream RPC endpoint could not be reached.')
  }

  const headers = new Headers({
    'content-type': upstream.headers.get('content-type') ?? 'application/json',
    ...baseHeaders(),
  })

  if (upstream.ok) {
    return new Response(upstream.body, { status: upstream.status, headers })
  }

  // ⚠️ An error body is the one place the credential can come BACK. A provider rejecting a key
  // quotes it - "invalid api key ..." - and streaming that through would publish the key to every
  // visitor, from inside the route built to hide it. Buffered and redacted rather than dropped, so
  // a misconfigured upstream stays diagnosable. Error bodies are rare, so the hot path never pays.
  return new Response(redactCredentials(await upstream.text()), {
    status: upstream.status,
    headers,
  })
}
