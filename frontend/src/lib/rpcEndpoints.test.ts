import { describe, expect, it } from 'vitest'
import { resolveProxyUrl, resolveRpcUrls } from './rpcEndpoints'

const PUBLIC = 'https://rpc.mainnet.chain.robinhood.com'
const ALCHEMY = 'https://robinhood-mainnet.g.alchemy.com/v2/key'
const QUICKNODE = 'https://x.robinhood-mainnet.quiknode.pro/token'
const PROXY = 'https://octopus.example/rpc'

describe('resolveRpcUrls', () => {
  it('works with nothing configured, using the public endpoint alone', () => {
    // The app must run out of the box - an unconfigured build still has a chain to talk to.
    expect(resolveRpcUrls({ publicDefault: PUBLIC })).toEqual([PUBLIC])
  })

  it('prefers the dedicated primary and keeps the public endpoint as last resort', () => {
    expect(resolveRpcUrls({ primary: ALCHEMY, publicDefault: PUBLIC })).toEqual([ALCHEMY, PUBLIC])
  })

  it('orders primary, then secondary, then public', () => {
    // Strict preference, not a race: viem's fallback only advances on failure, so a healthy
    // primary serves every request and the rest cost nothing.
    expect(
      resolveRpcUrls({ primary: ALCHEMY, secondary: QUICKNODE, publicDefault: PUBLIC }),
    ).toEqual([ALCHEMY, QUICKNODE, PUBLIC])
  })

  it('allows a secondary without a primary', () => {
    expect(resolveRpcUrls({ secondary: QUICKNODE, publicDefault: PUBLIC })).toEqual([
      QUICKNODE,
      PUBLIC,
    ])
  })

  it('treats blank and whitespace-only env values as unset', () => {
    // Vite hands through an empty string for a declared-but-empty var, which must not become an
    // endpoint - viem would try to POST to "" on every read.
    expect(resolveRpcUrls({ primary: '', secondary: '   ', publicDefault: PUBLIC })).toEqual([
      PUBLIC,
    ])
  })

  it('trims surrounding whitespace off a configured URL', () => {
    expect(resolveRpcUrls({ primary: `  ${ALCHEMY}\n`, publicDefault: PUBLIC })).toEqual([
      ALCHEMY,
      PUBLIC,
    ])
  })

  it('does not list the same endpoint twice when the primary IS the public one', () => {
    // Otherwise the list would retry one URL and present it as redundancy.
    expect(resolveRpcUrls({ primary: PUBLIC, publicDefault: PUBLIC })).toEqual([PUBLIC])
  })

  it('deduplicates a primary and secondary that are identical', () => {
    expect(
      resolveRpcUrls({ primary: ALCHEMY, secondary: ALCHEMY, publicDefault: PUBLIC }),
    ).toEqual([ALCHEMY, PUBLIC])
  })

  it('throws rather than returning an empty list', () => {
    // An empty transport list fails inside viem, far from the misconfiguration that caused it.
    expect(() => resolveRpcUrls({ publicDefault: '  ' })).toThrow(/no usable RPC endpoint/)
  })

  it('puts the proxy ahead of every direct endpoint', () => {
    // The proxy is the only entry that can be a metered provider without publishing its key, so it
    // has to be the one that serves requests, not a fallback nobody reaches.
    expect(
      resolveRpcUrls({ proxy: PROXY, primary: ALCHEMY, secondary: QUICKNODE, publicDefault: PUBLIC }),
    ).toEqual([PROXY, ALCHEMY, QUICKNODE, PUBLIC])
  })

  it('keeps the public endpoint behind the proxy, so a proxy outage still serves', () => {
    expect(resolveRpcUrls({ proxy: PROXY, publicDefault: PUBLIC })).toEqual([PROXY, PUBLIC])
  })

  it('behaves exactly as before when no proxy is configured', () => {
    // The proxy is opt-in. A deployment that never sets it must get byte-for-byte the list it got
    // before this option existed, because that is what the live testnet build is running.
    expect(resolveRpcUrls({ primary: ALCHEMY, publicDefault: PUBLIC })).toEqual([ALCHEMY, PUBLIC])
    expect(resolveRpcUrls({ proxy: '', primary: ALCHEMY, publicDefault: PUBLIC })).toEqual([
      ALCHEMY,
      PUBLIC,
    ])
  })

  it('yields a single endpoint when nothing distinct is configured', () => {
    // Recorded because one URL wrapped in viem's fallback is NOT redundancy: fallback forces
    // retryCount 0 on the inner transports and retries from the first, so it behaves like a bare
    // http(). Failover only begins to exist at length 2.
    expect(resolveRpcUrls({ primary: PUBLIC, publicDefault: PUBLIC })).toHaveLength(1)
    expect(resolveRpcUrls({ primary: ALCHEMY, publicDefault: PUBLIC })).toHaveLength(2)
  })
})

describe('resolveProxyUrl', () => {
  const ORIGIN = 'https://octopus.example'

  it('resolves a path against the page origin', () => {
    expect(resolveProxyUrl('/rpc', ORIGIN)).toBe('https://octopus.example/rpc')
  })

  it('resolves an absolute URL to itself, so the proxy may live on another origin', () => {
    expect(resolveProxyUrl('https://rpc.octopus.example/', ORIGIN)).toBe(
      'https://rpc.octopus.example/',
    )
  })

  it('returns an ABSOLUTE url, never the relative path it was given', () => {
    // Recorded because leaving it relative would make the transport depend on how a given HTTP
    // client resolves a bare path, which differs between a browser, jsdom and Node.
    const resolved = resolveProxyUrl('/rpc', ORIGIN)
    expect(resolved?.startsWith('https://')).toBe(true)
  })

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace only', '   '],
  ])('returns null when the path is %s', (_name, path) => {
    // The unconfigured case is the live one, so it has to be null rather than a guess. A guessed
    // /rpc on a static host answers with an HTML 404, which is a successful response carrying a
    // body viem cannot parse, on every single read.
    expect(resolveProxyUrl(path, ORIGIN)).toBeNull()
  })

  it('returns null for a relative path with no origin to resolve against', () => {
    // Server-side rendering, or a test environment with no DOM. Guessing an origin here would
    // point the app at whatever host happened to run the build.
    expect(resolveProxyUrl('/rpc', undefined)).toBeNull()
    expect(resolveProxyUrl('/rpc', '')).toBeNull()
  })

  it('returns null rather than throwing on an unparseable origin', () => {
    expect(resolveProxyUrl('/rpc', 'not an origin')).toBeNull()
  })
})
