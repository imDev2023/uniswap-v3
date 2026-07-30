import { describe, expect, it } from 'vitest'
import { hasFailover, resolveRpcUrls } from './rpcEndpoints'

const PUBLIC = 'https://rpc.mainnet.chain.robinhood.com'
const ALCHEMY = 'https://robinhood-mainnet.g.alchemy.com/v2/key'
const QUICKNODE = 'https://x.robinhood-mainnet.quiknode.pro/token'

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
})

describe('hasFailover', () => {
  it('is false for a single endpoint', () => {
    // One URL wrapped in viem's fallback is NOT redundancy: fallback forces retryCount 0 on the
    // inner transports and retries from the first, so it behaves like a bare http().
    expect(hasFailover(resolveRpcUrls({ publicDefault: PUBLIC }))).toBe(false)
  })

  it('is true once a genuinely different endpoint is configured', () => {
    expect(hasFailover(resolveRpcUrls({ primary: ALCHEMY, publicDefault: PUBLIC }))).toBe(true)
  })

  it('is false when the configured primary only duplicates the public endpoint', () => {
    expect(hasFailover(resolveRpcUrls({ primary: PUBLIC, publicDefault: PUBLIC }))).toBe(false)
  })
})
