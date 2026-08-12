/// <reference types="vitest/config" />
import { type ProxyOptions, defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { OPT_OUT_VAR, UPSTREAM_VAR, bundleCredentialGuard } from './build/bundleCredentialGuard'
import { securityHeadersPlugin } from './build/securityHeaders'
import { PUBLISHED_SUBGRAPH_URLS } from './src/config/subgraphUrl'
import { parseUpstream } from './src/lib/rpcUpstream'

// Stage 4 key protection.
//
// Vite inlines every `VITE_*` value into the emitted JavaScript, so those variables are published,
// not configured. The credential therefore lives in a variable WITHOUT the prefix and is read only
// here, in the Node process that runs the build and the dev server. Two mechanisms follow:
//
//   1. A proxy. The browser calls a path on our own origin; this server (in dev and in preview) or
//      the host's equivalent (in production) forwards it upstream with the key attached.
//   2. A guard. The build refuses to emit a bundle containing a credential-shaped URL, so the
//      protection cannot be undone by a later change to `.env.local` that nobody re-reads.
//
// The proxy is not a perfect boundary and should not be described as one. It is open to anyone who
// can reach the site, so it moves the exposure from "the key can be extracted and spent anywhere"
// to "our origin can be used as an RPC". Only the second of those is fixable after the fact.

/**
 * Forward the app's proxy path to the keyed upstream, in `dev` and `preview`.
 *
 * The upstream is split into origin and path rather than passed whole, because http-proxy JOINS the
 * target's path with the incoming request path: a target of `https://host/v2/<key>` receiving
 * `/rpc` would produce `/v2/<key>/rpc`. Pointing the target at the bare origin and rewriting the
 * request to the upstream's own path makes the result exact instead of dependent on join semantics.
 *
 * `changeOrigin` rewrites the Host header to the upstream, which managed providers need for TLS SNI
 * and virtual-host routing.
 *
 * ⚠️ The decomposition itself lives in `src/lib/rpcUpstream.ts` and is NOT repeated here, because
 * production serves this same path from `functions/rpc.ts` on entirely different plumbing. Two
 * copies of this rule would diverge silently, and only in production.
 */
const rpcProxy = (path: string, upstream: string): Record<string, ProxyOptions> => {
  const target = parseUpstream(upstream)
  return {
    [path]: {
      target: target.origin,
      changeOrigin: true,
      rewrite: () => target.pathAndSearch,
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // An empty prefix loads EVERY variable, not just the VITE_ ones. This governs only what this
  // config file can read; what reaches the client is still decided by Vite's envPrefix, left at its
  // default. Reading a secret here is safe. Passing one to `define` would not be.
  const env = loadEnv(mode, process.cwd(), '')
  const upstream = (env[UPSTREAM_VAR] ?? '').trim()
  const proxyPath = (env.VITE_RPC_PROXY_PATH ?? '').trim()

  if (upstream !== '' && proxyPath === '') {
    // Half-configured: the credential is present but nothing routes to it, so the app falls through
    // to its public endpoint and looks merely slow rather than misconfigured.
    console.warn(
      `[octopus] ${UPSTREAM_VAR} is set but VITE_RPC_PROXY_PATH is not, so the proxy is unreachable ` +
        `and the app will use its public endpoint. Set VITE_RPC_PROXY_PATH=/rpc.`,
    )
  }
  if (upstream === '' && proxyPath !== '' && mode !== 'production') {
    console.warn(
      `[octopus] VITE_RPC_PROXY_PATH is set but ${UPSTREAM_VAR} is not, so ${proxyPath} has no ` +
        `upstream to forward to. In production the host serves that path instead of Vite.`,
    )
  }

  const proxy = upstream !== '' && proxyPath !== '' ? rpcProxy(proxyPath, upstream) : undefined

  return {
    plugins: [
      react(),
      // ⚠️ A TRACKED CONSTANT, never `env`. This originally passed
      // `subgraphUrlFrom(env.VITE_SUBGRAPH_URL)`, which computed the allowlist from the same value
      // that put the URL in the bundle: it could never fail to match, so any credential placed in
      // that variable shipped to production under a warning saying it was expected. Reading the
      // environment here re-opens that hole, whatever the resolution around it looks like.
      bundleCredentialGuard(env[OPT_OUT_VAR] === '1', PUBLISHED_SUBGRAPH_URLS),
      // Emits `_headers` for Cloudflare Pages. Generated rather than committed because `connect-src`
      // is derived from this same `env` - see `build/securityHeaders.ts`.
      securityHeadersPlugin(env),
    ],
    // `preview` serves the built bundle, so it needs the same route the dev server has. Otherwise
    // the one command that exercises a production build cannot reach the proxy that build assumes.
    server: { proxy },
    preview: { proxy },
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: './src/test/setup.ts',
      // 15 s, not vitest's 5 s default. Measured 2026-08-10: idle, the whole suite finishes in ~20 s
      // and no single test approaches a second; with three suites running concurrently, three to
      // four of the render-heavy page tests (SwapPage, TokenPage, HomePage) fail at 5.0-6.2 s every
      // time. They are CPU-starved, not wrong - the failures are timeouts, never assertions. A
      // shared CI runner is the same condition, and CI has never executed here yet, so this would
      // have been a red first build. A longer ceiling delays a genuine hang; it hides nothing.
      testTimeout: 15_000,
    },
  }
})
