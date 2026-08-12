import { describe, expect, it } from 'vitest'
import { classifyUrl, findCredentials } from './rpcCredentials'

// The real shapes, with the key material replaced by same-length filler. Nothing here is a
// credential; the point is that the classifier judges by SHAPE, so filler of the right shape
// exercises it exactly as a real key would.
const ALCHEMY = 'https://robinhood-testnet.g.alchemy.com/v2/aB3dEf6hIj9lMn0pQr3tUv6xYz9bCd2e'
const QUICKNODE = 'https://frosty-x.robinhood-mainnet.quiknode.pro/7f3a91c05e2b48d6a1f09c7e3b5d820a'
const INFURA = 'https://mainnet.infura.io/v3/0123456789abcdef0123456789abcdef'
const DRPC = 'https://lb.drpc.org/ogrpc?network=ethereum&dkey=Ai8xK2mQ0pR4sT7vW1yZ3bC6eF9hJ2lN'

const PUBLIC_TESTNET = 'https://rpc.testnet.chain.robinhood.com'
const PUBLIC_MAINNET = 'https://rpc.mainnet.chain.robinhood.com'

// The managed-subgraph shape, with filler in place of the tenant id: credential-SHAPED, and not a
// credential. `OTHER_TENANT` differs only in that segment, so the two redact to the same string.
const SUBGRAPH = 'https://api.goldsky.com/api/public/project_aaaa1111bbbb2222cccc3333/subgraphs/octopus/1.0.0/gn'
const OTHER_TENANT = 'https://api.goldsky.com/api/public/project_dddd4444eeee5555ffff6666/subgraphs/octopus/1.0.0/gn'

describe('classifyUrl', () => {
  it('flags a key carried as a path segment', () => {
    const found = classifyUrl(ALCHEMY)
    expect(found?.location).toBe('path')
  })

  it('flags a key carried as a query parameter', () => {
    const found = classifyUrl(DRPC)
    expect(found?.location).toBe('query')
  })

  it.each([
    ['alchemy', ALCHEMY],
    ['quicknode', QUICKNODE],
    ['infura', INFURA],
    ['drpc', DRPC],
  ])('flags the %s shape', (_name, url) => {
    expect(classifyUrl(url)).not.toBeNull()
  })

  it('NEVER returns the secret it found', () => {
    // The whole guard is worthless if firing it publishes the key - a build error goes to a
    // terminal, to CI output and into logs. This is the assertion that makes the guard safe to run
    // anywhere, so it is tested against every shape rather than one.
    for (const url of [ALCHEMY, QUICKNODE, INFURA, DRPC]) {
      const parts = url.split(/[/=]/)
      const secret = parts[parts.length - 1]
      expect(secret.length).toBeGreaterThanOrEqual(20)
      expect(classifyUrl(url)!.redacted).not.toContain(secret)
    }
  })

  it('redacts to a readable URL rather than a percent-encoded one', () => {
    // `URL` re-encodes whatever is written into a pathname, so a marker containing punctuation
    // arrives as %3C...%3E and reads like corruption in the build error.
    const redacted = classifyUrl(ALCHEMY)!.redacted
    expect(redacted).toBe('https://robinhood-testnet.g.alchemy.com/v2/REDACTED')
    expect(redacted).not.toContain('%')
  })

  it('is idempotent, so re-scanning redacted text finds nothing', () => {
    expect(classifyUrl(classifyUrl(ALCHEMY)!.redacted)).toBeNull()
    expect(classifyUrl(classifyUrl(DRPC)!.redacted)).toBeNull()
  })

  it.each([
    ['the public testnet endpoint', PUBLIC_TESTNET],
    ['the public mainnet endpoint', PUBLIC_MAINNET],
    ['a same-origin proxy path resolved to absolute', 'https://octopus.example/rpc'],
    ['a subgraph endpoint', 'http://localhost:8100/subgraphs/name/octopus/octopus'],
    ['a block explorer', 'https://explorer.testnet.chain.robinhood.com'],
  ])('does not flag %s', (_name, url) => {
    expect(classifyUrl(url)).toBeNull()
  })

  it('does not flag a long path segment that has no digits', () => {
    // Ordinary routes get long. A credential is drawn from a mixed alphabet; an English path
    // segment is not, and that is the whole difference the rule leans on.
    expect(classifyUrl('https://example.com/documentationreference')).toBeNull()
  })

  it('does not flag a long run of digits with no letters', () => {
    // A block number, a timestamp or an id. Same reasoning in the other direction.
    expect(classifyUrl('https://example.com/block/12345678901234567890')).toBeNull()
  })

  it('ignores an empty credential parameter', () => {
    // A declared-but-unset var produces `?key=`, which is a misconfiguration and not a leak.
    expect(classifyUrl('https://example.com/rpc?key=')).toBeNull()
  })

  it.each([
    ['a redaction marker', 'https://example.com/rpc?apikey=REDACTED'],
    ['an angle-bracket placeholder', 'https://example.com/rpc?apikey=<your-key>'],
    ['a shouty placeholder', 'https://example.com/rpc?apikey=YOUR_KEY_HERE'],
  ])('does not flag %s under a credential parameter name', (_name, url) => {
    // A value under `apikey` is not automatically a secret. Placeholders live in documentation
    // strings and in redacted output, and a guard that fires on them teaches people to pass the
    // opt-out flag, which is the one outcome that makes the guard worse than nothing.
    expect(classifyUrl(url)).toBeNull()
  })

  it('matches credential parameter names case-insensitively', () => {
    expect(classifyUrl('https://example.com/rpc?apiKey=Ai8xK2mQ0pR4sT7vW1yZ3bC6eF9hJ2lN')).not.toBeNull()
  })

  it('returns null for text that is not a URL', () => {
    expect(classifyUrl('not a url')).toBeNull()
  })
})

describe('findCredentials', () => {
  it('finds a credential inside a minified bundle', () => {
    const bundle = `const t="${PUBLIC_TESTNET}",n="${ALCHEMY}";export{t,n};`
    const found = findCredentials(bundle)
    expect(found).toHaveLength(1)
    expect(found[0].redacted).toBe('https://robinhood-testnet.g.alchemy.com/v2/REDACTED')
  })

  it('stops at the closing quote instead of swallowing the rest of the file', () => {
    // The failure this avoids is the one the evm-security gate has: a scanner whose terminator is
    // wrong reports about text it never actually read. Here a greedy match would run past the
    // quote, mis-parse, and report nothing at all.
    const bundle = `a="${PUBLIC_TESTNET}";b="${ALCHEMY}";c='${QUICKNODE}';d=\`${INFURA}\`;`
    expect(findCredentials(bundle)).toHaveLength(3)
  })

  it('reports one finding per distinct URL, however often it is repeated', () => {
    const bundle = Array(20).fill(`"${ALCHEMY}"`).join(',')
    expect(findCredentials(bundle)).toHaveLength(1)
  })

  it('returns nothing for a bundle that only names public endpoints', () => {
    const bundle = `const c={4663:"${PUBLIC_MAINNET}",46630:"${PUBLIC_TESTNET}"};`
    expect(findCredentials(bundle)).toEqual([])
  })

  it('finds a credential in HTML as well as in JavaScript', () => {
    // Vite emits index.html through the same bundle object, and a hand-edited preconnect or script
    // tag is a route into it that never touches src/.
    expect(findCredentials(`<link rel="preconnect" href="${ALCHEMY}">`)).toHaveLength(1)
  })

  it('marks nothing published when no published urls are supplied', () => {
    expect(findCredentials(`"${ALCHEMY}"`)[0].published).toBe(false)
  })

  it('marks a supplied url published, and leaves a real key alone', () => {
    const found = findCredentials(`a="${SUBGRAPH}",b="${ALCHEMY}";`, [SUBGRAPH])
    expect(found.find((f) => f.redacted.includes('goldsky'))?.published).toBe(true)
    expect(found.find((f) => f.redacted.includes('alchemy'))?.published).toBe(false)
  })

  it('matches the exact url, so a sibling endpoint at the same host is not published', () => {
    expect(findCredentials(`"${OTHER_TENANT}"`, [SUBGRAPH])[0].published).toBe(false)
  })

  it('compares urls canonically, so an equivalent spelling still matches', () => {
    // `URL` normalises a default port away. The published list is written by a human into a config
    // file and the bundle carries whatever the app resolved, so the two spellings need not be
    // byte-identical to mean the same endpoint.
    const withPort = SUBGRAPH.replace('https://api.goldsky.com', 'https://api.goldsky.com:443')
    expect(findCredentials(`"${SUBGRAPH}"`, [withPort])[0].published).toBe(true)
  })

  it('⚠️ never publishes a QUERY-string credential, even when it is explicitly listed', () => {
    // Nothing is published by construction under a parameter named `dkey`. The exemption exists for
    // an opaque PATH segment that identifies a tenant; a provider asking for a key in the query is
    // asking for a secret. No allowlist entry may override that, so this passes the URL as its own
    // published entry - the most generous input possible - and still expects false.
    expect(findCredentials(`"${DRPC}"`, [DRPC])[0].published).toBe(false)
  })

  it('⚠️ does not let a published url absorb an unpublished one that redacts identically', () => {
    // Redaction replaces the opaque segment, so every tenant at one host reduces to the SAME
    // string. Deduplicating on the redacted form alone would collapse these two into one finding
    // carrying whichever flag was seen first - and if the published one came first, a genuinely
    // undeclared endpoint would inherit its exemption and never be reported.
    const found = findCredentials(`a="${SUBGRAPH}",b="${OTHER_TENANT}";`, [SUBGRAPH])
    expect(found[0].redacted).toBe(found[1].redacted)
    expect(found.map((f) => f.published).sort()).toEqual([false, true])
  })
})
