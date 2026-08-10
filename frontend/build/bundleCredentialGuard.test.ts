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
const run = (bundle: OutputBundle, acknowledged = false) => {
  const warn = vi.fn()
  const error = vi.fn((message: string) => {
    throw new Error(message)
  })
  const plugin = bundleCredentialGuard(acknowledged)
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
})
