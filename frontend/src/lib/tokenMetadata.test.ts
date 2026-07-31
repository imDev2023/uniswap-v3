import { describe, expect, it, vi } from 'vitest'
import { fetchTokenMetadata, parseTokenMetadata } from './tokenMetadata'

const CID = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku'
const URI = `ipfs://${CID}`

/** A gateway reply. Defaults to the shape a working gateway returns. */
function reply(body: string, ok = true): Response {
  return { ok, text: () => Promise.resolve(body) } as unknown as Response
}

describe('parseTokenMetadata', () => {
  it('reads the agreed document shape', () => {
    const meta = parseTokenMetadata({
      name: 'Octo Cat',
      description: 'A cat.',
      image: `ipfs://${CID}`,
      links: { twitter: 'https://x.com/octo' },
    })
    expect(meta?.name).toBe('Octo Cat')
    expect(meta?.description).toBe('A cat.')
    expect(meta?.image).toBe(`https://dweb.link/ipfs/${CID}`)
    expect(meta?.links).toEqual([{ label: 'twitter', url: 'https://x.com/octo' }])
  })

  it('accepts links as an array as well as a map, since the shape was never pinned down', () => {
    const meta = parseTokenMetadata({
      image: `ipfs://${CID}`,
      links: [{ label: 'Site', url: 'https://octo.example' }],
    })
    // Normalised through `URL`, which is what appends the trailing slash on a bare origin.
    expect(meta?.links).toEqual([{ label: 'Site', url: 'https://octo.example/' }])
  })

  it('drops any link that is not https', () => {
    // `javascript:` in an href executes on click, and this document is attacker-supplied. An
    // allowlist of one scheme is the only check that stays correct as schemes get invented.
    const meta = parseTokenMetadata({
      name: 'x',
      links: {
        evil: 'javascript:alert(1)',
        insecure: 'http://octo.example',
        data: 'data:text/html,<script>alert(1)</script>',
        good: 'https://octo.example',
      },
    })
    expect(meta?.links).toEqual([{ label: 'good', url: 'https://octo.example/' }])
  })

  it('truncates a description rather than letting it dictate the layout', () => {
    const meta = parseTokenMetadata({ description: 'x'.repeat(5_000) })
    expect(meta?.description?.length).toBe(1_000)
  })

  it.each([
    ['a zero-byte body parsed as null', null],
    ['a JSON array', [1, 2, 3]],
    ['a bare string', 'hello'],
    ['a number', 7],
    ['an object with nothing usable in it', { decimals: 18, extra: { a: 1 } }],
  ])('returns null for %s', (_label, doc) => {
    expect(parseTokenMetadata(doc)).toBeNull()
  })

  it('ignores an image URI it cannot turn into a URL, keeping the rest', () => {
    const meta = parseTokenMetadata({ name: 'x', image: 'http://insecure.example/a.png' })
    expect(meta?.name).toBe('x')
    expect(meta?.image).toBeUndefined()
  })
})

describe('fetchTokenMetadata', () => {
  it('uses the first gateway that answers usefully', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply(JSON.stringify({ name: 'Octo' })))
    const meta = await fetchTokenMetadata(URI, { fetchImpl })
    expect(meta?.name).toBe('Octo')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0][0]).toContain('dweb.link')
  })

  it('falls through to the second operator when the first is down', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(reply(JSON.stringify({ name: 'Octo' })))
    const meta = await fetchTokenMetadata(URI, { fetchImpl })
    expect(meta?.name).toBe('Octo')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls[1][0]).toContain('w3s.link')
  })

  it('survives the 504 HTML page an unpinned CID actually returns', async () => {
    // Measured against the seeded OCAT/BOOTS launches: structurally valid CIDs that were never
    // pinned answer 504 with an HTML body, which `res.json()` would have thrown on.
    const html = '<!DOCTYPE html><html><body>504 Gateway Timeout</body></html>'
    const fetchImpl = vi.fn().mockResolvedValue(reply(html, false))
    await expect(fetchTokenMetadata(URI, { fetchImpl })).resolves.toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("survives META's real behaviour: 200 with a zero-byte body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply(''))
    await expect(fetchTokenMetadata(URI, { fetchImpl })).resolves.toBeNull()
  })

  it('survives a 200 whose body is not JSON at all', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply('<html>hi</html>'))
    await expect(fetchTokenMetadata(URI, { fetchImpl })).resolves.toBeNull()
  })

  it('gives every request an abort signal, which is what bounds a 28s gateway hang', async () => {
    // An unpinned CID hangs dweb.link for ~28 seconds while it walks the DHT. Without a deadline a
    // board of forty cards would sit on dozens of those, so the signal is the actual fix.
    const fetchImpl = vi.fn().mockResolvedValue(reply(JSON.stringify({ name: 'Octo' })))
    await fetchTokenMetadata(URI, { fetchImpl })
    expect(fetchImpl.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('aborts a gateway that exceeds the deadline and moves on', async () => {
    const fetchImpl = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )
    await expect(fetchTokenMetadata(URI, { fetchImpl, timeoutMs: 5 })).resolves.toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('makes no request at all when the URI yields no usable URL', async () => {
    const fetchImpl = vi.fn()
    await expect(fetchTokenMetadata('', { fetchImpl })).resolves.toBeNull()
    await expect(fetchTokenMetadata('http://x.example/m.json', { fetchImpl })).resolves.toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not retry the second gateway after the first returns unusable content', async () => {
    // A CID addresses exactly one document, so a gateway that answered with junk has answered -
    // the other would return byte-identical junk. Retrying would double load on free gateways for
    // no possible gain.
    const fetchImpl = vi.fn().mockResolvedValue(reply(JSON.stringify({ decimals: 18 })))
    await expect(fetchTokenMetadata(URI, { fetchImpl })).resolves.toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
