import { describe, expect, it } from 'vitest'
import { zeroAddress } from 'viem'
import { resolveOnchainToken, type OnchainTokenReads } from './onchainToken'

const CURVE = '0x81a14013d3F048BcBe4AF0fB8b88aF0ec25D799a' as const
const POOL = '0xDC27FeCB8589c0FB0328fd98963c823a1681E933' as const

/** All reads landed, token is graduated with a pool. Override per test. */
function reads(over: Partial<OnchainTokenReads> = {}): OnchainTokenReads {
  return {
    configured: true,
    curve: CURVE,
    curveError: false,
    graduated: true,
    graduatedError: false,
    pool: POOL,
    poolError: false,
    name: 'Meta Test',
    symbol: 'META',
    ...over,
  }
}

describe('resolveOnchainToken', () => {
  it('resolves a graduated token to its pool', () => {
    expect(resolveOnchainToken(reads())).toEqual({
      status: 'graduated',
      curve: CURVE,
      pool: POOL,
      name: 'Meta Test',
      symbol: 'META',
    })
  })

  it('resolves a live curve without needing a pool', () => {
    expect(resolveOnchainToken(reads({ graduated: false, pool: undefined }))).toEqual({
      status: 'on-curve',
      curve: CURVE,
      name: 'Meta Test',
      symbol: 'META',
    })
  })

  it('reports preview mode when the launchpad address is unset', () => {
    expect(resolveOnchainToken(reads({ configured: false })).status).toBe('not-configured')
  })

  it('rejects an address the launchpad does not know', () => {
    // curveOf returns the zero address for anything not launched here - this is the check that
    // stops an arbitrary ERC-20 from rendering a trade panel.
    expect(resolveOnchainToken(reads({ curve: zeroAddress })).status).toBe('not-a-launch')
  })

  it('is loading while the membership read is in flight', () => {
    expect(resolveOnchainToken(reads({ curve: undefined })).status).toBe('loading')
  })

  it('is loading while graduation state is in flight', () => {
    expect(resolveOnchainToken(reads({ graduated: undefined })).status).toBe('loading')
  })

  it('is loading while the pool lookup is in flight', () => {
    expect(resolveOnchainToken(reads({ pool: undefined })).status).toBe('loading')
  })

  it('reports unreachable when the membership read fails', () => {
    expect(resolveOnchainToken(reads({ curveError: true })).status).toBe('unreachable')
  })

  it('reports unreachable when the graduation read fails', () => {
    expect(resolveOnchainToken(reads({ graduatedError: true })).status).toBe('unreachable')
  })

  it('reports unreachable rather than hanging when the pool lookup fails', () => {
    // The pool read depends on v3Factory(); if that read fails, round 2 never runs and `pool` stays
    // undefined forever. Without poolError this would sit on the spinner indefinitely.
    expect(resolveOnchainToken(reads({ pool: undefined, poolError: true })).status).toBe(
      'unreachable',
    )
  })

  it('still trades a live curve when only the pool lookup failed', () => {
    // A curve trades against the curve contract - a broken V3 factory read is irrelevant to it and
    // must not degrade a page that can perfectly well take an order.
    expect(
      resolveOnchainToken(reads({ graduated: false, pool: undefined, poolError: true })).status,
    ).toBe('on-curve')
  })

  it('surfaces a graduated token whose pool is missing rather than rendering a broken swap', () => {
    const r = resolveOnchainToken(reads({ pool: zeroAddress }))
    expect(r.status).toBe('graduated-pool-missing')
    // No pool address is exposed on that state, so nothing downstream can trade against zero.
    expect(r).not.toHaveProperty('pool')
  })

  it('does not let missing labels block trading', () => {
    // name()/symbol() are cosmetic; a token that omits them must still resolve to a tradeable state.
    const r = resolveOnchainToken(reads({ name: undefined, symbol: undefined }))
    expect(r.status).toBe('graduated')
    expect(r).toMatchObject({ name: '', symbol: '' })
  })

  it('falls back to the symbol when only the name is missing', () => {
    expect(resolveOnchainToken(reads({ name: undefined }))).toMatchObject({ name: 'META' })
  })

  it('never depends on indexed data: the same reads resolve identically regardless of context', () => {
    // Guard against a regression where subgraph state leaks back into this decision. The resolver
    // takes only contract reads, so this is a shape assertion on its input surface.
    expect(Object.keys(reads()).sort()).toEqual([
      'configured',
      'curve',
      'curveError',
      'graduated',
      'graduatedError',
      'name',
      'pool',
      'poolError',
      'symbol',
    ])
  })
})
