import { describe, expect, it } from 'vitest'
import { parseTokenParam } from './address'

// The live testnet META token, in three renderings of the SAME address.
const CANONICAL = '0x52eEF29c3c869B4D04F3c1451b16548DEAA923bE'
const LOWER = '0x52eef29c3c869b4d04f3c1451b16548deaa923be'
// The SAME address with a WRONG EIP-55 checksum casing - the form that was recorded in CLAUDE.md
// and docs/deployments-testnet.md until it was corrected. viem's strict isAddress rejects this,
// which used to strand a real token behind "Invalid token address" on the token and swap pages.
// Kept verbatim: this exact string is the regression.
const BAD_CHECKSUM = '0x52eEF29C3c869b4D04F3C1451b16548dEaa923bE'

describe('parseTokenParam', () => {
  it('accepts the canonical checksummed form', () => {
    expect(parseTokenParam(CANONICAL)).toBe(CANONICAL)
  })

  it('accepts an all-lowercase address and normalises it', () => {
    expect(parseTokenParam(LOWER)).toBe(CANONICAL)
  })

  it('accepts a mis-checksummed rendering rather than stranding a real token', () => {
    expect(parseTokenParam(BAD_CHECKSUM)).toBe(CANONICAL)
  })

  it('accepts an all-uppercase-hex rendering', () => {
    expect(parseTokenParam('0x' + LOWER.slice(2).toUpperCase())).toBe(CANONICAL)
  })

  it('rejects anything that is not an address', () => {
    expect(parseTokenParam(undefined)).toBeNull()
    expect(parseTokenParam('')).toBeNull()
    expect(parseTokenParam('not-an-address')).toBeNull()
    expect(parseTokenParam('0x1234')).toBeNull()
    // 41 hex chars - one too many.
    expect(parseTokenParam(LOWER + 'a')).toBeNull()
    // Right length, but a non-hex character.
    expect(parseTokenParam('0x52eef29c3c869b4d04f3c1451b16548deaa923bz')).toBeNull()
  })
})
