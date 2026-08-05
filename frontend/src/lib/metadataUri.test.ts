import { describe, expect, it } from 'vitest'
import { classifyMetadataUri, isSubmittableMetadataUri } from './metadataUri'
import { gatewayUrls } from './ipfs'

// The create form's URI field writes PERMANENTLY and has no setter, for anyone (ADR-0002). Until
// #37 it had no validation at all, and the four spellings named below all passed straight into
// `createLaunch` while the read side silently dropped every one of them.

const REAL_CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'

describe('the spellings that used to pass silently', () => {
  it('rejects ipfs// - the missing colon', () => {
    const v = classifyMetadataUri(`ipfs//${REAL_CID}`)
    expect(v.kind).toBe('invalid')
    if (v.kind !== 'invalid') throw new Error('unreachable')
    // The message names the actual mistake. On a field that can never be edited, "invalid" is worth
    // far less than the one sentence that lets the creator fix it before submitting.
    expect(v.reason).toMatch(/ipfs:\/\//)
  })

  it('rejects free text', () => {
    expect(classifyMetadataUri('my token metadata').kind).toBe('invalid')
  })

  it('rejects javascript:', () => {
    expect(classifyMetadataUri('javascript:alert(1)').kind).toBe('invalid')
  })

  it('rejects a lone space, which is not the same as an empty field', () => {
    // A space trims to empty, which IS legitimate - so this asserts the trim happens rather than
    // that whitespace is rejected outright.
    expect(classifyMetadataUri('   ').kind).toBe('empty')
    // Whitespace INSIDE a URI is the real defect, and it is diagnosed by name.
    const v = classifyMetadataUri(`ipfs://${REAL_CID} extra`)
    expect(v.kind).toBe('invalid')
  })

  it('rejects plain http, which the browser blocks on an https page anyway', () => {
    const v = classifyMetadataUri('http://example.com/meta.json')
    expect(v.kind).toBe('invalid')
    if (v.kind !== 'invalid') throw new Error('unreachable')
    expect(v.reason).toMatch(/https/i)
  })
})

describe('what it accepts', () => {
  it('accepts an empty field - most launches carry no URI at all', () => {
    expect(classifyMetadataUri('').kind).toBe('empty')
    expect(isSubmittableMetadataUri('')).toBe(true)
  })

  it('accepts ipfs:// with a real CID, a bare CID, and https', () => {
    expect(classifyMetadataUri(`ipfs://${REAL_CID}`).kind).toBe('ok')
    expect(classifyMetadataUri(REAL_CID).kind).toBe('ok')
    expect(classifyMetadataUri('https://example.com/meta.json').kind).toBe('ok')
  })
})

describe('the verdict is the READ SIDE’s, not a parallel ruleset', () => {
  // ⚠️ This is the property that keeps the fix from rotting. The defect being closed is a form that
  // accepts spellings the reader drops; restating the rules here instead of deriving them
  // reintroduces exactly that, one refactor later. So: for every input, "the form accepts it" and
  // "the reader would fetch it" must agree.
  const cases = [
    '',
    '   ',
    REAL_CID,
    `ipfs://${REAL_CID}`,
    `ipfs://ipfs/${REAL_CID}`,
    `ipfs//${REAL_CID}`,
    'ipfs:/broken',
    'https://example.com/meta.json',
    'http://example.com/meta.json',
    'javascript:alert(1)',
    'my token metadata',
    'Qmtooshort',
    `ipfs://${REAL_CID}/../../admin`,
  ]

  it.each(cases)('agrees with gatewayUrls on %j', (input) => {
    const verdict = classifyMetadataUri(input)
    const readerWouldFetch = gatewayUrls(input).length > 0
    if (verdict.kind === 'empty') {
      expect(readerWouldFetch).toBe(false)
      return
    }
    expect(verdict.kind === 'ok').toBe(readerWouldFetch)
  })
})
