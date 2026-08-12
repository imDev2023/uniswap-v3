// @vitest-environment node
//
// Build tooling, so the build's own environment is the right one to test it in. It is also
// required: importing vite.config.ts pulls in esbuild, which asserts that
// `new TextEncoder().encode('') instanceof Uint8Array`, and under jsdom that is false.
import { describe, expect, it, vi } from 'vitest'
import type { OutputBundle } from 'rollup'
import { GUARD_PLUGIN_NAME, OPT_OUT_VAR, bundleCredentialGuard } from './bundleCredentialGuard'

const KEYED = 'https://robinhood-testnet.g.alchemy.com/v2/aB3dEf6hIj9lMn0pQr3tUv6xYz9bCd2e'
const SECRET = 'aB3dEf6hIj9lMn0pQr3tUv6xYz9bCd2e'
const PUBLIC = 'https://rpc.testnet.chain.robinhood.com'

// The managed-subgraph shape, with filler in place of the tenant id. Credential-SHAPED - an opaque
// mixed-alphanumeric path segment well over the 20-character threshold - and not a credential.
const SUBGRAPH = 'https://api.goldsky.com/api/public/project_aaaa1111bbbb2222cccc3333/subgraphs/octopus/1.0.0/gn'
/** A second endpoint at the SAME host, which the build never declared published. */
const OTHER_TENANT = 'https://api.goldsky.com/api/public/project_dddd4444eeee5555ffff6666/subgraphs/octopus/1.0.0/gn'
/** A credential carried in the QUERY STRING, which no allowlist entry may exempt. */
const QUERY_KEYED = 'https://lb.drpc.org/ogrpc?network=ethereum&dkey=Ai8xK2mQ0pR4sT7vW1yB'

/** A bundle shaped like Rollup's, carrying one JS chunk and index.html. */
const bundleOf = (js: string, html = '<!doctype html><div id="root"></div>'): OutputBundle =>
  ({
    'assets/index-abc123.js': { type: 'chunk', fileName: 'assets/index-abc123.js', code: js },
    'index.html': { type: 'asset', fileName: 'index.html', source: html },
    // Rollup emits binary assets with a Uint8Array source. Scanning must skip rather than throw.
    'assets/logo.png': { type: 'asset', fileName: 'assets/logo.png', source: new Uint8Array([1, 2]) },
  }) as unknown as OutputBundle

/**
 * Run the plugin's generateBundle hook with a stubbed Rollup plugin context.
 *
 * `this.error` throws in Rollup, which is what aborts the build, so the stub throws too. Anything
 * gentler would let a test pass while the real build carried on and wrote the leaking bundle.
 */
const run = (bundle: OutputBundle, acknowledged = false, publishedUrls: string[] = []) => {
  const warn = vi.fn()
  const error = vi.fn((message: string) => {
    throw new Error(message)
  })
  const plugin = bundleCredentialGuard(acknowledged, publishedUrls)
  const hook = plugin.generateBundle
  if (typeof hook !== 'function') throw new Error('generateBundle is not a function')
  const invoke = () => hook.call({ warn, error } as never, {} as never, bundle, false)
  return { invoke, warn, error }
}

describe('bundleCredentialGuard', () => {
  it('fails the build when a credential reached a chunk', () => {
    const { invoke, error } = run(bundleOf(`const u="${KEYED}";`))
    expect(invoke).toThrow(/credential-shaped URL reached the production bundle/)
    expect(error).toHaveBeenCalledOnce()
  })

  it('fails the build when a credential reached the HTML', () => {
    const { invoke } = run(bundleOf('const u="ok";', `<link rel="preconnect" href="${KEYED}">`))
    expect(invoke).toThrow(/credential-shaped URL/)
  })

  it('NEVER prints the secret it caught', () => {
    // A build error goes to a terminal, to CI output and into logs. A guard that published the key
    // as it fired would leak it to a strictly wider audience than the bundle did.
    const { invoke } = run(bundleOf(`const u="${KEYED}";`))
    expect(invoke).toThrow(expect.not.stringContaining(SECRET) as unknown as string)
  })

  it('names the file, so the fix does not start with a search', () => {
    const { invoke } = run(bundleOf(`const u="${KEYED}";`))
    expect(invoke).toThrow(/assets\/index-abc123\.js/)
  })

  it('says how to fix it, including the variable to move the key into', () => {
    const { invoke } = run(bundleOf(`const u="${KEYED}";`))
    expect(invoke).toThrow(/RPC_UPSTREAM_URL/)
    expect(invoke).toThrow(/VITE_RPC_PROXY_PATH/)
  })

  it('passes a bundle that only names public endpoints', () => {
    const { invoke, warn, error } = run(bundleOf(`const u="${PUBLIC}";`))
    expect(invoke).not.toThrow()
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('does not throw on a binary asset', () => {
    const { invoke } = run(bundleOf(`const u="${PUBLIC}";`))
    expect(invoke).not.toThrow()
  })

  it('scans a chunk SOURCEMAP, not just its code', () => {
    // With build.sourcemap on, the map is emitted next to the chunk and its sourcesContent is a
    // second published copy of the source. A guard that read only `code` would pass a build that
    // shipped the key in the file beside it.
    const bundle = {
      'assets/index-abc123.js': {
        type: 'chunk',
        fileName: 'assets/index-abc123.js',
        code: `const u="${PUBLIC}";`,
        map: { version: 3, sources: ['chain.ts'], sourcesContent: [`const u="${KEYED}"`] },
      },
    } as unknown as OutputBundle
    const { invoke } = run(bundle)

    expect(invoke).toThrow(/credential-shaped URL/)
  })

  it(`warns instead of failing when ${OPT_OUT_VAR} was acknowledged`, () => {
    const { invoke, warn, error } = run(bundleOf(`const u="${KEYED}";`), true)
    expect(invoke).not.toThrow()
    expect(error).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledOnce()
  })

  it('still refuses to print the secret in the acknowledged path', () => {
    const { invoke, warn } = run(bundleOf(`const u="${KEYED}";`), true)
    invoke()
    expect(warn.mock.calls[0][0]).not.toContain(SECRET)
  })

  it('never silences the finding, even when acknowledged', () => {
    // An allowlist is a provider-side control this build cannot verify, so the acknowledged path
    // downgrades the severity and nothing else. Silence would make a real leak indistinguishable
    // from a correctly proxied build.
    const { invoke, warn } = run(bundleOf(`const u="${KEYED}";`), true)
    invoke()
    expect(warn.mock.calls[0][0]).toMatch(/domain allowlist/)
  })

  it('only applies to builds, so `vite dev` is untouched', () => {
    expect(bundleCredentialGuard(false).apply).toBe('build')
  })
})

describe('endpoints published by construction', () => {
  it('does not fail the build for a URL the build declared published', () => {
    // The subgraph endpoint. The browser fetches it directly, so it is in the bundle by design and
    // the guard's remedy - move it behind the RPC proxy - does not apply to it.
    const { invoke, error } = run(bundleOf(`const u="${SUBGRAPH}";`), false, [SUBGRAPH])
    expect(invoke).not.toThrow()
    expect(error).not.toHaveBeenCalled()
  })

  it('still REPORTS it, so the exemption is never silent', () => {
    const { invoke, warn } = run(bundleOf(`const u="${SUBGRAPH}";`), false, [SUBGRAPH])
    invoke()
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0][0]).toMatch(/published by construction/)
  })

  it('⚠️ exempts the EXACT url, not the origin', () => {
    // The assertion that stops this becoming a provider allowlist. A different tenant at the same
    // host has to be judged on its own, or declaring one endpoint published would quietly bless
    // every future URL from that provider - including a genuinely keyed one.
    const { invoke } = run(bundleOf(`const u="${OTHER_TENANT}";`), false, [SUBGRAPH])
    expect(invoke).toThrow(/credential-shaped URL reached the production bundle/)
  })

  it('still fails on a real key that shares the bundle with a published URL', () => {
    // The exemption must not become a blanket pass for the file it appears in.
    const { invoke } = run(bundleOf(`const a="${SUBGRAPH}",b="${KEYED}";`), false, [SUBGRAPH])
    expect(invoke).toThrow(/credential-shaped URL reached the production bundle/)
  })

  it('names only the leak in the failure, not the published URL', () => {
    // The reader is being asked to act on one of the two. Listing both under "reached the
    // production bundle" would send them to move an endpoint that is supposed to be there.
    const { invoke } = run(bundleOf(`const a="${SUBGRAPH}",b="${KEYED}";`), false, [SUBGRAPH])
    let message = ''
    try {
      invoke()
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain('g.alchemy.com')
    expect(message).not.toContain('api.goldsky.com')
  })

  it('exempts nothing when the build declares no published urls', () => {
    // The default. A build that never passes the argument behaves exactly as it did before.
    const { invoke } = run(bundleOf(`const u="${SUBGRAPH}";`))
    expect(invoke).toThrow(/credential-shaped URL reached the production bundle/)
  })

  it('⚠️ still fails on a QUERY-string credential that is explicitly listed as published', () => {
    // The exemption is for an opaque path segment naming a tenant. A key under a parameter called
    // `dkey` is a secret whatever the list says, so listing it must not help - this passes the URL
    // as its own published entry and still requires the build to fail.
    const { invoke } = run(bundleOf(`const u="${QUERY_KEYED}";`), false, [QUERY_KEYED])
    expect(invoke).toThrow(/credential-shaped URL reached the production bundle/)
  })
})

describe('the shipped vite config', () => {
  it('actually installs the guard', async () => {
    // The behaviour above is worth nothing if the plugin is not in the config. This is the
    // assertion that notices somebody deleting it from the plugins array.
    const config = (await import('../vite.config')).default
    const resolved = await (typeof config === 'function'
      ? config({ command: 'build', mode: 'production' })
      : config)
    // Widened before flattening. Vite's PluginOption is a deeply recursive union, and `.flat` over
    // it makes tsc give up with TS2589 - which fails `npm run build` while vitest, which never
    // typechecks, stays green.
    const plugins = (resolved.plugins ?? []) as unknown as { name?: string }[]
    const names = plugins.flat(Infinity).map((p) => p?.name)

    expect(names).toContain(GUARD_PLUGIN_NAME)
  })

  it('⚠️ the ENVIRONMENT cannot widen the exemption', async () => {
    // The regression test for the defect this whole exemption nearly shipped with. `publishedUrls`
    // was originally `subgraphUrlFrom(env.VITE_SUBGRAPH_URL)` - computed from the same variable that
    // puts the URL into the bundle, so the allowlist moved with the endpoint and could never fail to
    // match. A real key pasted into that variable built successfully and was written to `dist` in
    // plaintext, under a warning saying it was expected.
    //
    // Stated as behaviour, not as mechanism: whatever `VITE_SUBGRAPH_URL` holds, a credential in the
    // output is fatal. Any fix that keeps that true passes; reading env here again does not.
    vi.stubEnv('VITE_SUBGRAPH_URL', KEYED)
    try {
      const config = (await import('../vite.config')).default
      const resolved = await (typeof config === 'function'
        ? config({ command: 'build', mode: 'production' })
        : config)
      const plugins = (resolved.plugins ?? []) as unknown as {
        name?: string
        generateBundle?: (o: never, b: OutputBundle, w: boolean) => void
      }[]
      const guard = plugins.flat(Infinity).find((p) => p?.name === GUARD_PLUGIN_NAME)
      if (guard?.generateBundle === undefined) throw new Error('guard plugin has no generateBundle')

      const error = vi.fn((message: string) => {
        throw new Error(message)
      })
      const call = () =>
        guard.generateBundle?.call(
          { warn: vi.fn(), error } as never,
          {} as never,
          bundleOf(`const u="${KEYED}";`),
          false,
        )

      expect(call).toThrow(/credential-shaped URL reached the production bundle/)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
