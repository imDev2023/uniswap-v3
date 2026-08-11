import type { Plugin } from 'vite'
import { PUBLIC_RPC_BY_CHAIN, activeChainIdFrom } from '../src/config/publicRpc'
import { subgraphUrlFrom } from '../src/config/subgraphUrl'
import { IPFS_GATEWAYS } from '../src/lib/ipfs'
import { connectSources, renderHeadersFile, securityHeaders } from '../src/lib/securityHeaders'

// Emits Cloudflare Pages' `_headers` file into the build output.
//
// It lives outside src/ for the same reason as `bundleCredentialGuard`: it is build tooling that
// runs in the Node process performing the build, and must never be reachable from a browser bundle.
// The policy it emits is decided in `src/lib/securityHeaders.ts`, which is pure and tested; this
// file only supplies the environment.
//
// ⚠️ Generated rather than committed, because `connect-src` is build configuration. A static
// `_headers` file would be correct on the day it was written and silently wrong the first time
// `VITE_SUBGRAPH_URL` or `VITE_CHAIN_ID` changed - and a blocked `fetch` renders as an empty panel,
// not as an error, which is the same failure shape as a lagging indexer.

/** Cloudflare Pages reads this filename from the root of the deployed directory. */
export const HEADERS_FILE = '_headers'

/**
 * Attach the security headers to the built output.
 *
 * @param env Every variable, as `vite.config.ts` already loads it with an empty prefix. Read here
 *        rather than from `process.env` so the plugin sees exactly what the app was built with,
 *        including values that came from `.env.local`.
 */
export const securityHeadersPlugin = (env: Record<string, string>): Plugin => ({
  name: 'octopus:security-headers',
  apply: 'build',
  // After the credential guard has had its say. A build that leaks a key writes no output at all,
  // and emitting headers for output that will never exist would only confuse the failure.
  enforce: 'post',
  generateBundle() {
    const chainId = activeChainIdFrom(env.VITE_CHAIN_ID)
    const sources = connectSources({
      // ⚠️ RESOLVED, not read raw. `src/config/contracts.ts` falls back to a localhost default when
      // the variable is unset, so passing the bare env value here would emit a CSP that omits an
      // origin the app still fetches from - and a blocked fetch renders as an empty panel.
      subgraphUrl: subgraphUrlFrom(env.VITE_SUBGRAPH_URL),
      directRpcUrls: [env.VITE_RPC_URL, env.VITE_RPC_URL_2],
      publicRpcUrl: PUBLIC_RPC_BY_CHAIN[chainId],
      // Contributes an origin only when it is absolute. The ordinary `/rpc` is same-origin and is
      // already covered by `'self'`.
      proxyPath: env.VITE_RPC_PROXY_PATH,
      ipfsGateways: IPFS_GATEWAYS,
    })

    this.emitFile({
      type: 'asset',
      fileName: HEADERS_FILE,
      // ⚠️ `/*` covers the STATIC ASSETS ONLY. It looks like it covers `/rpc` and it does not:
      // `_headers` is applied by Pages' asset layer and a Function's response bypasses it entirely.
      // Measured under `wrangler pages dev` - the app shell came back carrying all eight headers
      // and `/rpc` came back with none. `functions/rpc.ts` therefore sets its own, via
      // `apiSecurityHeaders`. Do not "simplify" by assuming this rule reaches the Function.
      source: renderHeadersFile([{ path: '/*', headers: securityHeaders(sources) }]),
    })
  },
})
