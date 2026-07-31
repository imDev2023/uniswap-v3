import { describe, expect, it } from 'vitest'
import { IPFS_GATEWAYS, gatewayUrls, resolveMediaUrl } from './ipfs'

// A real CIDv1 (base32) and a real CIDv0 (base58), so the shapes under test are the shapes that
// actually appear on-chain rather than plausible-looking strings.
const CID_V1 = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku'
const CID_V0 = 'QmeSjSinHpPnmXmspMjwiXyN6zS4E9zccariGR3jxcaWtq'

describe('gatewayUrls', () => {
  it('offers every gateway, in order, so a failure has somewhere to fall', () => {
    const urls = gatewayUrls(`ipfs://${CID_V1}`)
    expect(urls).toHaveLength(IPFS_GATEWAYS.length)
    expect(urls[0]).toBe(`https://dweb.link/ipfs/${CID_V1}`)
    expect(urls[1]).toBe(`https://w3s.link/ipfs/${CID_V1}`)
  })

  it('pairs gateways run by DIFFERENT operators', () => {
    // The entire purpose of a fallback is surviving an outage, and ipfs.io + dweb.link are both
    // Protocol Labs - pairing them would look like redundancy while providing none. This asserts
    // the property rather than the hostnames, so swapping either gateway keeps the guarantee.
    const hosts = IPFS_GATEWAYS.map((g) => new URL(g).hostname)
    expect(new Set(hosts).size).toBe(hosts.length)
    expect(hosts).not.toContain('ipfs.io')
  })

  it('keeps the path after the CID, which is where directory-style metadata lives', () => {
    // The widely-pinned NFT JSON used to validate this path is addressed exactly this way.
    expect(gatewayUrls(`ipfs://${CID_V0}/1`)[0]).toBe(`https://dweb.link/ipfs/${CID_V0}/1`)
  })

  it('accepts a CIDv0, which cannot be spelled as a gateway subdomain', () => {
    expect(gatewayUrls(`ipfs://${CID_V0}`)[0]).toBe(`https://dweb.link/ipfs/${CID_V0}`)
  })

  it('repairs the doubled ipfs:// prefix rather than 404ing on it', () => {
    expect(gatewayUrls(`ipfs://ipfs/${CID_V1}`)[0]).toBe(`https://dweb.link/ipfs/${CID_V1}`)
  })

  it('accepts a bare CID with no scheme', () => {
    expect(gatewayUrls(CID_V1)[0]).toBe(`https://dweb.link/ipfs/${CID_V1}`)
  })

  it('passes an https URI straight through', () => {
    expect(gatewayUrls('https://example.com/meta.json')).toEqual(['https://example.com/meta.json'])
  })

  it('passes a data URI through, so on-chain-inlined metadata needs no network', () => {
    const uri = 'data:application/json,{"name":"x"}'
    expect(gatewayUrls(uri)).toEqual([uri])
  })

  it('rejects http, which the browser would block as mixed content anyway', () => {
    // Returning nothing fails immediately to the identicon instead of after a console error.
    expect(gatewayUrls('http://example.com/meta.json')).toEqual([])
  })

  it.each([undefined, null, '', '   ', 'not a uri', 'ftp://x/y', 'ipfs://'])(
    'yields no URLs for %p, so no request is made',
    (uri) => {
      expect(gatewayUrls(uri)).toEqual([])
    },
  )

  it('refuses a URI that would climb out of the gateway /ipfs/ namespace', () => {
    // `URL` normalises `..` away, so a naive string concat would have produced
    // https://dweb.link/admin and happily fetched it. Every surviving URL must stay under /ipfs/.
    for (const url of gatewayUrls(`ipfs://${CID_V1}/../../admin`)) {
      expect(new URL(url).pathname.startsWith('/ipfs/')).toBe(true)
    }
  })

  it('never escapes the gateway origin, whatever the URI contains', () => {
    for (const evil of [`${CID_V1}/..//evil.com`, `${CID_V1}/%2e%2e/%2e%2e/x`]) {
      for (const url of gatewayUrls(`ipfs://${evil}`)) {
        expect(['dweb.link', 'w3s.link']).toContain(new URL(url).hostname)
      }
    }
  })
})

describe('resolveMediaUrl', () => {
  it('resolves the nested ipfs:// URI that metadata documents put in their image field', () => {
    // Not hypothetical: the reference NFT JSON holds "image":"ipfs://Qm…", so resolving the
    // document is only half the work - the image inside it needs resolving too.
    expect(resolveMediaUrl(`ipfs://${CID_V0}`)).toBe(`https://dweb.link/ipfs/${CID_V0}`)
  })

  it('is undefined when nothing usable can be built, so <img> is never given an empty src', () => {
    expect(resolveMediaUrl('')).toBeUndefined()
    expect(resolveMediaUrl('http://example.com/a.png')).toBeUndefined()
  })
})
