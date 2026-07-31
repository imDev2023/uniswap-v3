import { describe, expect, it, vi } from 'vitest'

// The shipped list is empty by design (nothing on testnet warrants an entry), so the rules are
// exercised against a stubbed list. Mocking the config rather than the lib keeps the real lookup
// logic - casing, tier precedence, filtering - under test.
const HIDDEN = '0x1111111111111111111111111111111111111111'
const IMAGE_ONLY = '0x2222222222222222222222222222222222222222'
const CLEAN = '0x3333333333333333333333333333333333333333'

vi.mock('../config/denylist', () => ({
  DENYLIST: {
    [HIDDEN]: 'hide',
    [IMAGE_ONLY]: 'image',
  },
}))

const { denylistTier, isHidden, isImageSuppressed, withoutHidden } = await import('./denylist')

describe('denylistTier', () => {
  it('matches regardless of address casing', () => {
    // Route params and subgraph ids disagree about casing constantly, and a moderation rule that
    // silently misses on a checksummed address is worse than no rule.
    expect(denylistTier(HIDDEN.toUpperCase().replace('0X', '0x'))).toBe('hide')
    expect(denylistTier(IMAGE_ONLY)).toBe('image')
  })

  it.each([undefined, null, '', CLEAN])('is null for %p', (addr) => {
    expect(denylistTier(addr)).toBeNull()
  })
})

describe('isImageSuppressed', () => {
  it('suppresses imagery for BOTH tiers', () => {
    // `hide` is strictly stronger than `image`, and a hidden token is still reachable by direct
    // link - so reading "hide means it never appears" and checking only the image tier would leave
    // the picture rendering on the one page it can still be reached from.
    expect(isImageSuppressed(HIDDEN)).toBe(true)
    expect(isImageSuppressed(IMAGE_ONLY)).toBe(true)
    expect(isImageSuppressed(CLEAN)).toBe(false)
  })
})

describe('isHidden', () => {
  it('is true only for the hide tier', () => {
    expect(isHidden(HIDDEN)).toBe(true)
    expect(isHidden(IMAGE_ONLY)).toBe(false)
  })
})

describe('withoutHidden', () => {
  it('removes hidden rows and keeps image-only ones listed', () => {
    const rows = [{ id: HIDDEN }, { id: IMAGE_ONLY }, { id: CLEAN }]
    expect(withoutHidden(rows).map((r) => r.id)).toEqual([IMAGE_ONLY, CLEAN])
  })

  it('leaves a clean list untouched', () => {
    const rows = [{ id: CLEAN }]
    expect(withoutHidden(rows)).toEqual(rows)
  })
})
