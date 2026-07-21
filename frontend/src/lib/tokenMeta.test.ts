import { beforeEach, describe, expect, it } from 'vitest'
import { getTokenImage, setTokenImage } from './tokenMeta'

describe('tokenMeta', () => {
  beforeEach(() => localStorage.clear())

  it('stores and retrieves an image url, case-insensitively by address', () => {
    setTokenImage('0xAbC0000000000000000000000000000000000001', 'https://img/x.png')
    expect(getTokenImage('0xabc0000000000000000000000000000000000001')).toBe('https://img/x.png')
  })

  it('returns undefined for unknown tokens', () => {
    expect(getTokenImage('0x0000000000000000000000000000000000000009')).toBeUndefined()
  })

  it('ignores blank urls', () => {
    setTokenImage('0xabc0000000000000000000000000000000000002', '   ')
    expect(getTokenImage('0xabc0000000000000000000000000000000000002')).toBeUndefined()
  })
})
