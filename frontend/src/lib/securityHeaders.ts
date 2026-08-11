// SlowMist's frontend-hardening list, as a generated artifact rather than a file somebody maintains.
//
// The headers themselves are static, with one exception that decides whether the app works at all:
// `connect-src`. It has to name every origin the app may open a connection to, and those origins
// are BUILD CONFIGURATION - the subgraph endpoint, the direct RPC endpoints, the proxy when it sits
// on a separate origin. A hand-written `_headers` file would be a list of hostnames with no way to
// fail: correct on the day it was written, wrong the first time `VITE_SUBGRAPH_URL` moved, and
// wrong in the specific way a CSP is worst at reporting - the app loads, renders, and quietly shows
// nothing, because a blocked `fetch` is indistinguishable from an empty result.
//
// So this module derives the policy from the same values `src/config/chain.ts` and
// `src/lib/subgraph.ts` read, and `build/securityHeaders.ts` emits it at build time.
//
// ⚠️ A CSP cannot be reasoned into correctness. Every directive here was checked against the
// running app, because the failure mode is silence - see build #29's chart that never painted.

/** One `_headers` stanza: a path pattern and the headers Cloudflare should attach to matches. */
export interface HeaderRule {
  path: string
  headers: Record<string, string>
}

/**
 * The origin of an absolute URL, or `null` for anything relative, blank or unparseable.
 *
 * CSP matches on origin, not on path, so `https://host/subgraphs/name/octopus/octopus` and
 * `https://host/rpc` are one source. Returning `null` rather than throwing is deliberate: a blank
 * `VITE_RPC_URL_2` is the ordinary case, not an error, and a relative `VITE_RPC_PROXY_PATH` is
 * already covered by `'self'`.
 */
export function originOf(url: string | undefined): string | null {
  const raw = (url ?? '').trim()
  if (raw === '') return null
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    return parsed.origin
  } catch {
    return null
  }
}

/**
 * A gateway origin plus its wildcard subdomain form.
 *
 * Both are required, and the second is the one that is easy to miss. The IPFS gateways are
 * addressed in path form (`https://dweb.link/ipfs/<cid>`) because that is the only spelling that
 * works for CIDv0, but both gateways answer with a REDIRECT to subdomain form
 * (`https://<cid>.ipfs.dweb.link`). CSP re-checks the redirect target against `connect-src`, so a
 * policy naming only the path-form origin blocks every metadata fetch at the redirect - after the
 * request has already succeeded once, which makes it look like a gateway problem.
 *
 * `https://*.dweb.link` does not match `https://dweb.link`, so neither entry substitutes for the
 * other.
 */
export function gatewaySources(gateway: string): string[] {
  const origin = originOf(gateway)
  if (origin === null) return []
  const { protocol, host } = new URL(origin)
  return [origin, `${protocol}//*.${host}`]
}

/** Everything the app is configured to talk to, for `connect-src`. */
export interface ConnectSourceInput {
  /** `VITE_SUBGRAPH_URL`. */
  subgraphUrl?: string
  /** `VITE_RPC_URL` and `VITE_RPC_URL_2`, the direct endpoints. */
  directRpcUrls?: (string | undefined)[]
  /** The chain's documented public endpoint, always in the app's transport list as a last resort. */
  publicRpcUrl?: string
  /** `VITE_RPC_PROXY_PATH`, which contributes an origin only when it is absolute. */
  proxyPath?: string
  /** `IPFS_GATEWAYS`, expanded to cover the path-to-subdomain redirect. */
  ipfsGateways?: readonly string[]
}

/**
 * The `connect-src` list, `'self'` first.
 *
 * `'self'` is what serves the proxy path in production, so it is never optional. Everything else is
 * derived; blanks drop out, and duplicates are removed so a deployment that points `VITE_RPC_URL`
 * at the public endpoint does not name it twice.
 */
export function connectSources(input: ConnectSourceInput): string[] {
  const candidates = [
    ...(input.directRpcUrls ?? []),
    input.publicRpcUrl,
    input.subgraphUrl,
    input.proxyPath,
  ]
  const sources = ["'self'"]
  const push = (value: string) => {
    if (!sources.includes(value)) sources.push(value)
  }

  for (const candidate of candidates) {
    const origin = originOf(candidate)
    if (origin !== null) push(origin)
  }
  for (const gateway of input.ipfsGateways ?? []) {
    for (const source of gatewaySources(gateway)) push(source)
  }
  return sources
}

/**
 * The Content-Security-Policy, given the resolved `connect-src` list.
 *
 * Each directive carries the reason it is what it is, because the next person to read this file
 * will be reading it while something is broken, and "why is this not stricter" is the question.
 */
export function contentSecurityPolicy(sources: string[]): string {
  const directives: string[] = [
    // Everything not named below falls back to same-origin, so a directive nobody thought of is
    // restrictive rather than open.
    "default-src 'self'",

    // No 'unsafe-inline' and no 'unsafe-eval'. Measured against this project's own output: Vite
    // emits ONE external module script and no inline script at all, so the strict form costs
    // nothing here. It is also the directive that carries the whole weight of the policy - with
    // script-src strict, the looser img-src below cannot be reached by an injected script.
    "script-src 'self'",

    // Likewise external-only. Vite emits a single stylesheet; React's `style` props are applied
    // through CSSOM, which CSP does not govern, so they need no allowance.
    "style-src 'self'",

    // ⚠️ Deliberately broad, and the one place this policy gives ground. Token images are
    // creator-supplied and may legitimately live on any host: an IPFS gateway, a pinning service,
    // or a plain HTTPS URL a creator chose at launch and can never change, because `metadataURI`
    // has no setter. Narrowing this to the gateways would silently blank a real token's artwork.
    // An image source can leak the fact of a request but cannot read a response, which is why the
    // same latitude is NOT given to connect-src.
    "img-src 'self' data: blob: https:",

    "font-src 'self' data:",

    // The strict half of the trade above: an exact allowlist, so an injected script has nowhere to
    // send what it reads.
    `connect-src ${sources.join(' ')}`,

    // No plugins, and no injected <base> able to re-point every relative URL on the page.
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",

    // Clickjacking. A wallet-signing UI framed by a hostile page is the concrete attack, and this
    // is the modern half of the X-Frame-Options pair below.
    "frame-ancestors 'none'",

    // Belt and braces alongside HSTS: rewrites any stray http:// subresource rather than letting
    // the browser block it as mixed content.
    'upgrade-insecure-requests',
  ]
  return directives.join('; ')
}

/**
 * Every security header the deployment sets, for the resolved `connect-src` list.
 */
export function securityHeaders(sources: string[]): Record<string, string> {
  return {
    'Content-Security-Policy': contentSecurityPolicy(sources),

    // Two years, subdomains included, and preload-eligible. The app is HTTPS-only in production and
    // has no http:// deployment to strand.
    // ⚠️ `preload` is a claim about EVERY subdomain of the apex and it is not easily reversible.
    // It is safe on a *.pages.dev deployment (Cloudflare already preloads pages.dev) and needs a
    // deliberate decision on a custom apex domain before submission to hstspreload.org.
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',

    // Stops a response being re-interpreted as a script or stylesheet on the strength of its bytes.
    'X-Content-Type-Options': 'nosniff',

    // The pre-CSP half of the clickjacking pair, for anything that does not honour frame-ancestors.
    'X-Frame-Options': 'DENY',

    // A token page URL names the token being viewed. Sending the full path to a third-party image
    // host would tell it what the visitor is looking at; the origin alone is enough.
    'Referrer-Policy': 'strict-origin-when-cross-origin',

    // Nothing in this app uses any of these, and a compromised dependency asking for them should be
    // refused by the platform rather than by a permission prompt the user has to read.
    'Permissions-Policy':
      'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',

    // Severs the window.opener relationship, so a page this app opens cannot navigate it.
    'Cross-Origin-Opener-Policy': 'same-origin',

    // Explicitly 0, not 1. The legacy XSS auditor is deprecated, and its filter introduced
    // vulnerabilities of its own; CSP is what does this job now, and a stale `1` here is worse than
    // nothing.
    'X-XSS-Protection': '0',
  }
}

/**
 * The subset that belongs on the JSON-RPC route, set by the Function itself.
 *
 * ⚠️ MEASURED, not assumed: `_headers` is applied by Pages' STATIC ASSET layer, and a Function's
 * response bypasses it entirely. Verified against `wrangler pages dev` - the app shell came back
 * carrying all eight headers and `/rpc` came back with none of them. A deployment that set the
 * headers only in `_headers` would look hardened and leave its one dynamic route bare.
 *
 * Deliberately not the document set. `Referrer-Policy` governs requests a DOCUMENT makes and means
 * nothing on a JSON response, and a full CSP would be noise; what matters for an API reply is that
 * it can never be sniffed into something executable, framed, or treated as a document at all.
 */
export function apiSecurityHeaders(): Record<string, string> {
  const document = securityHeaders([])
  return {
    'X-Content-Type-Options': document['X-Content-Type-Options'],
    'Strict-Transport-Security': document['Strict-Transport-Security'],
    'X-Frame-Options': document['X-Frame-Options'],
    // The lockdown form: a JSON body that some browser is talked into treating as a document can
    // load nothing and run nothing.
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  }
}

/**
 * Render Cloudflare Pages' `_headers` format.
 *
 * A path pattern on its own line, then one indented `Name: value` per header. Cloudflare applies
 * every matching rule to the STATIC ASSETS it serves. ⚠️ It does not reach a Pages Function - see
 * `apiSecurityHeaders` above, which is why that exists.
 */
export function renderHeadersFile(rules: HeaderRule[]): string {
  const blocks = rules.map(
    ({ path, headers }) =>
      `${path}\n` +
      Object.entries(headers)
        .map(([name, value]) => `  ${name}: ${value}`)
        .join('\n'),
  )
  return `${blocks.join('\n\n')}\n`
}
