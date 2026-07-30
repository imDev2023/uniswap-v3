import { describe, expect, it } from 'vitest'
import { avatarHue, avatarInitials, avatarStyle } from './identicon'

const META = '0x52eEF29c3c869B4D04F3c1451b16548DEAA923bE'

describe('avatarHue', () => {
  it('is stable for the same address across calls', () => {
    // The fallback avatar must not change between renders, sessions or browsers - it is the token's
    // only visual identity when there is no image, and metadataURI is immutable so that is permanent.
    expect(avatarHue(META)).toBe(avatarHue(META))
  })

  it('ignores address casing', () => {
    expect(avatarHue(META)).toBe(avatarHue(META.toLowerCase()))
  })

  it('stays within the hue circle', () => {
    for (const a of [META, '0x0', '0xffffffffffffffffffffffffffffffffffffffff', '']) {
      const hue = avatarHue(a)
      expect(hue).toBeGreaterThanOrEqual(0)
      expect(hue).toBeLessThan(360)
    }
  })

  it('separates addresses that differ only in the last character', () => {
    const a = avatarHue('0x11E0d50dB0f8F8fc635C159898EDBDF7113c635a')
    const b = avatarHue('0x11E0d50dB0f8F8fc635C159898EDBDF7113c635b')
    expect(a).not.toBe(b)
  })
})

describe('avatarStyle', () => {
  it('produces usable css colour strings', () => {
    const s = avatarStyle(META)
    expect(s.background).toMatch(/^hsl\(\d+ \d+% \d+%\)$/)
    expect(s.color).toMatch(/^hsl\(/)
    expect(s.borderColor).toMatch(/^hsl\(/)
  })
})

describe('avatarInitials', () => {
  it('takes up to three alphanumeric characters, uppercased', () => {
    expect(avatarInitials('rdoge')).toBe('RDO')
    expect(avatarInitials('META')).toBe('MET')
    expect(avatarInitials('ab')).toBe('AB')
  })

  it('strips symbols so punctuation-only tickers still render something', () => {
    expect(avatarInitials('$$$')).toBe('?')
    expect(avatarInitials('')).toBe('?')
    expect(avatarInitials('a-b-c')).toBe('ABC')
  })
})
