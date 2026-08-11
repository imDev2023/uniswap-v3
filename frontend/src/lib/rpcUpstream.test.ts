import { describe, expect, it } from 'vitest'
import { parseUpstream } from './rpcUpstream'

// A credential-shaped upstream, in the exact spelling the real providers use: the key is a PATH
// SEGMENT, which is what makes path-joining destructive rather than merely untidy.
const KEYED = 'https://robinhood-testnet.g.alchemy.com/v2/aaaabbbbccccddddeeeeffff00001111'

describe('parseUpstream', () => {
  it('splits a keyed endpoint into an origin and the path that carries the credential', () => {
    const target = parseUpstream(KEYED)
    expect(target.origin).toBe('https://robinhood-testnet.g.alchemy.com')
    expect(target.pathAndSearch).toBe('/v2/aaaabbbbccccddddeeeeffff00001111')
  })

  // The invariant that keeps `vite.config.ts` and `functions/rpc.ts` from drifting: one composes
  // `origin` with a rewritten path, the other requests `href`, and this is the assertion that those
  // two are the same destination. If a later change makes `href` anything other than the
  // composition, this fails before either server does.
  it('composes href out of exactly the two fields the http-proxy path uses', () => {
    for (const upstream of [
      KEYED,
      'https://host.example/v2/key?apiKey=abc123def456',
      'http://127.0.0.1:8545/',
      'https://host.example',
    ]) {
      const target = parseUpstream(upstream)
      expect(target.href).toBe(`${target.origin}${target.pathAndSearch}`)
    }
  })

  // The bug this module exists to prevent, asserted as a bug rather than as an absence. Written the
  // naive way - joining the upstream with the incoming request path - this produces
  // `/v2/<key>/rpc`, which every managed provider answers with a 404.
  it('never lets the incoming request path reach the upstream', () => {
    const target = parseUpstream(KEYED)
    const naiveJoin = new URL('/rpc', KEYED)

    expect(target.href).not.toContain('/rpc')
    expect(target.pathAndSearch).not.toContain('/rpc')
    expect(target.href).not.toBe(`${KEYED}/rpc`)
    // And the join that WOULD have been wrong is genuinely different, so the assertion above is
    // testing something rather than passing vacuously.
    expect(naiveJoin.toString()).not.toBe(target.href)
  })

  it('keeps a query-string credential, which some providers use instead of a path segment', () => {
    const target = parseUpstream('https://host.example/rpc?apiKey=abc123def456')
    expect(target.pathAndSearch).toBe('/rpc?apiKey=abc123def456')
    expect(target.href).toBe('https://host.example/rpc?apiKey=abc123def456')
  })

  it('keeps a non-default port in the origin, which the forwarded URL is built from', () => {
    const target = parseUpstream('http://127.0.0.1:8545/')
    expect(target.origin).toBe('http://127.0.0.1:8545')
    expect(target.pathAndSearch).toBe('/')
    expect(target.href).toBe('http://127.0.0.1:8545/')
  })

  it('normalises a bare origin to a root path rather than an empty one', () => {
    // `new URL('https://host.example').pathname` is '/', so the forwarded request is well-formed
    // rather than a bare origin with no path.
    expect(parseUpstream('https://host.example').pathAndSearch).toBe('/')
  })

  it('drops a fragment, which is never sent to a server anyway', () => {
    const target = parseUpstream('https://host.example/v2/key#notes')
    expect(target.href).toBe('https://host.example/v2/key')
    expect(target.pathAndSearch).not.toContain('#')
  })

  it('tolerates surrounding whitespace, which a .env file readily produces', () => {
    expect(parseUpstream(`  ${KEYED}\n`).href).toBe(KEYED)
  })

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['not a URL', 'robinhood-testnet.g.alchemy.com/v2/key'],
    ['a relative path', '/v2/key'],
    ['the wrong scheme', 'file:///etc/passwd'],
    ['a websocket endpoint', 'wss://host.example/v2/key'],
  ])('refuses %s rather than forwarding somewhere nobody chose', (_label, upstream) => {
    expect(() => parseUpstream(upstream)).toThrow()
  })

  // The hard rule for this repo is that nothing from `.env.local` is ever echoed, and a thrown
  // error is printed by every runtime that catches it - a terminal, a Workers log, a CI transcript.
  it('never puts the upstream it rejected into the error message', () => {
    const secretish = 'file://host.example/v2/aaaabbbbccccddddeeeeffff00001111'
    expect(() => parseUpstream(secretish)).toThrow()
    try {
      parseUpstream(secretish)
    } catch (error) {
      expect((error as Error).message).not.toContain('aaaabbbbccccddddeeeeffff00001111')
      expect((error as Error).message).not.toContain('host.example')
    }
  })
})
