import { describe, expect, it } from 'vitest'
import {
  apiSecurityHeaders,
  connectSources,
  contentSecurityPolicy,
  gatewaySources,
  originOf,
  renderHeadersFile,
  securityHeaders,
} from './securityHeaders'
import { IPFS_GATEWAYS } from './ipfs'
import { PUBLIC_RPC_BY_CHAIN } from '../config/publicRpc'
import { DEFAULT_SUBGRAPH_URL, subgraphUrlFrom } from '../config/subgraphUrl'

/** Read one directive out of a rendered policy. */
const directive = (csp: string, name: string): string | undefined =>
  csp
    .split('; ')
    .find((d) => d === name || d.startsWith(`${name} `))
    ?.slice(name.length)
    .trim()

describe('originOf', () => {
  it('reduces a URL with a path and query to its origin, which is what CSP matches on', () => {
    expect(originOf('https://graph.example/subgraphs/name/octopus/octopus')).toBe(
      'https://graph.example',
    )
    expect(originOf('https://host.example/v2/key?apiKey=abc')).toBe('https://host.example')
  })

  it('keeps a non-default port, because an origin that drops it matches nothing', () => {
    expect(originOf('http://localhost:8100/subgraphs/name/octopus/octopus')).toBe(
      'http://localhost:8100',
    )
  })

  it.each([
    ['blank', ''],
    ['whitespace', '  '],
    ['undefined', undefined],
    ['a relative path', '/rpc'],
    ['a non-http scheme', 'wss://host.example'],
  ])('returns null for %s rather than inventing a source', (_label, value) => {
    expect(originOf(value)).toBeNull()
  })
})

describe('gatewaySources', () => {
  // The entry that is easy to miss. Both gateways redirect path form to subdomain form, and CSP
  // re-checks the redirect target, so the wildcard is what makes metadata load at all.
  it('covers both the path form and the subdomain form a gateway redirects to', () => {
    expect(gatewaySources('https://dweb.link')).toEqual([
      'https://dweb.link',
      'https://*.dweb.link',
    ])
  })

  it('produces two entries that do not substitute for each other', () => {
    const [exact, wildcard] = gatewaySources('https://w3s.link')
    // CSP's host matching: `*.w3s.link` does NOT match `w3s.link` itself.
    expect(exact).not.toBe(wildcard)
    expect(wildcard.startsWith('https://*.')).toBe(true)
  })

  it('ignores an unusable gateway rather than emitting a broken source', () => {
    expect(gatewaySources('not-a-url')).toEqual([])
  })
})

describe('connectSources', () => {
  it("always leads with 'self', which is what serves the proxy path in production", () => {
    expect(connectSources({})[0]).toBe("'self'")
  })

  it('names every configured endpoint', () => {
    const sources = connectSources({
      subgraphUrl: 'https://graph.example/subgraphs/name/octopus/octopus',
      directRpcUrls: ['https://primary.example/v2/key', 'https://secondary.example/v2/key'],
      publicRpcUrl: 'https://rpc.testnet.chain.robinhood.com',
    })
    expect(sources).toContain('https://graph.example')
    expect(sources).toContain('https://primary.example')
    expect(sources).toContain('https://secondary.example')
    expect(sources).toContain('https://rpc.testnet.chain.robinhood.com')
  })

  it('drops blanks, which is the ordinary state of the second RPC endpoint', () => {
    const sources = connectSources({ directRpcUrls: [undefined, ''], subgraphUrl: '' })
    expect(sources).toEqual(["'self'"])
  })

  it('deduplicates, so pointing VITE_RPC_URL at the public endpoint names it once', () => {
    const url = 'https://rpc.testnet.chain.robinhood.com'
    const sources = connectSources({ directRpcUrls: [url], publicRpcUrl: url })
    expect(sources.filter((s) => s === url)).toHaveLength(1)
  })

  // The documented separate-origin deployment: an absolute VITE_RPC_PROXY_PATH is no longer covered
  // by 'self', and a CSP that assumed it was would block every read in the app.
  it('adds the proxy origin when the proxy path is absolute', () => {
    expect(connectSources({ proxyPath: 'https://proxy.example/rpc' })).toContain(
      'https://proxy.example',
    )
  })

  it('adds nothing for the ordinary same-origin proxy path', () => {
    expect(connectSources({ proxyPath: '/rpc' })).toEqual(["'self'"])
  })

  it('covers the real gateway list rather than a copy of it', () => {
    const sources = connectSources({ ipfsGateways: IPFS_GATEWAYS })
    for (const gateway of IPFS_GATEWAYS) {
      expect(sources).toContain(gateway)
      expect(sources).toContain(gateway.replace('https://', 'https://*.'))
    }
  })
})

describe('contentSecurityPolicy', () => {
  const csp = contentSecurityPolicy(connectSources({ subgraphUrl: 'https://graph.example' }))

  it('carries the resolved connect-src list', () => {
    expect(directive(csp, 'connect-src')).toBe("'self' https://graph.example")
  })

  // The directive the whole policy rests on. Vite emits no inline script, measured against this
  // project's own output, so there is no reason to weaken it and every reason not to.
  it.each(['script-src', 'style-src', 'default-src'])('keeps %s free of unsafe allowances', (name) => {
    const value = directive(csp, name)
    expect(value).not.toContain('unsafe-inline')
    expect(value).not.toContain('unsafe-eval')
    expect(value).not.toContain('*')
  })

  it('forbids framing, which is the wallet-signing clickjacking case', () => {
    expect(directive(csp, 'frame-ancestors')).toBe("'none'")
  })

  it('forbids plugins and a re-pointed <base>', () => {
    expect(directive(csp, 'object-src')).toBe("'none'")
    expect(directive(csp, 'base-uri')).toBe("'self'")
  })

  // The deliberate concession, asserted so that narrowing it later is a visible decision rather
  // than a tidy-up: creator artwork lives at URLs frozen at launch and can be anywhere.
  // ⚠️ Asserted on TOKENS, not substrings. `https:` is a substring of every origin in the list, so
  // a `toContain` here would have passed for connect-src no matter what the policy said - the
  // source being tested for is the bare scheme, which is a source of its own.
  it('allows images from any HTTPS host, and only images', () => {
    const sourcesOf = (name: string) => directive(csp, name)?.split(' ') ?? []
    expect(sourcesOf('img-src')).toContain('https:')
    expect(sourcesOf('connect-src')).not.toContain('https:')
    expect(sourcesOf('script-src')).not.toContain('https:')
    expect(sourcesOf('default-src')).not.toContain('https:')
  })

  it('sets every directive exactly once', () => {
    const names = csp.split('; ').map((d) => d.split(' ')[0])
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('securityHeaders', () => {
  const headers = securityHeaders(connectSources({}))

  it.each([
    ['Content-Security-Policy'],
    ['Strict-Transport-Security'],
    ['X-Content-Type-Options'],
    ['X-Frame-Options'],
    ['Referrer-Policy'],
    ['Permissions-Policy'],
    ['Cross-Origin-Opener-Policy'],
  ])('sets %s', (name) => {
    expect(headers[name]).toBeTruthy()
  })

  it('sets HSTS for two years, including subdomains', () => {
    expect(headers['Strict-Transport-Security']).toContain('max-age=63072000')
    expect(headers['Strict-Transport-Security']).toContain('includeSubDomains')
  })

  // Explicitly 0. A stale `1` re-enables a deprecated auditor that introduced bugs of its own.
  it('disables the legacy XSS auditor rather than enabling it', () => {
    expect(headers['X-XSS-Protection']).toBe('0')
  })

  it('never emits a header value containing a newline, which would forge a second header', () => {
    for (const value of Object.values(headers)) {
      expect(value).not.toMatch(/[\r\n]/)
    }
  })
})

describe('apiSecurityHeaders', () => {
  const api = apiSecurityHeaders()

  it('locks a JSON reply down to nothing, since it is never a document', () => {
    expect(api['Content-Security-Policy']).toContain("default-src 'none'")
    expect(api['Content-Security-Policy']).toContain("frame-ancestors 'none'")
  })

  it('stops the reply being sniffed into something executable', () => {
    expect(api['X-Content-Type-Options']).toBe('nosniff')
  })

  // Shared with the document set rather than restated, so the two can never disagree about how
  // long HSTS lasts - which is the kind of difference nobody notices until a browser does.
  it('reuses the document set rather than declaring a second HSTS policy', () => {
    expect(api['Strict-Transport-Security']).toBe(
      securityHeaders([])['Strict-Transport-Security'],
    )
  })

  it('leaves out what is meaningless on an API reply', () => {
    // Referrer-Policy governs requests a DOCUMENT makes; on a JSON response it is decoration.
    expect(api['Referrer-Policy']).toBeUndefined()
    expect(api['Permissions-Policy']).toBeUndefined()
  })
})

describe('renderHeadersFile', () => {
  it("renders Cloudflare's format: a path, then indented name-value pairs", () => {
    expect(renderHeadersFile([{ path: '/*', headers: { 'X-Frame-Options': 'DENY' } }])).toBe(
      '/*\n  X-Frame-Options: DENY\n',
    )
  })

  it('separates rules with a blank line', () => {
    const rendered = renderHeadersFile([
      { path: '/*', headers: { A: '1' } },
      { path: '/rpc', headers: { B: '2' } },
    ])
    expect(rendered).toBe('/*\n  A: 1\n\n/rpc\n  B: 2\n')
  })

  it('ends with a newline, which the parser needs for the final entry', () => {
    expect(renderHeadersFile([{ path: '/*', headers: { A: '1' } }]).endsWith('\n')).toBe(true)
  })
})

// The reason `PUBLIC_RPC_BY_CHAIN` and `subgraphUrlFrom` were extracted into their own modules: the
// CSP and the app have to name the same endpoints, and a second copy would go stale silently.
describe('the CSP and the app read the same endpoints', () => {
  it.each([4663, 46630])('covers chain %i public endpoint', (chainId) => {
    expect(connectSources({ publicRpcUrl: PUBLIC_RPC_BY_CHAIN[chainId] })).toContain(
      PUBLIC_RPC_BY_CHAIN[chainId],
    )
  })

  // ⚠️ THE REGRESSION. Found in review: the generator passed `env.VITE_SUBGRAPH_URL` raw while
  // `src/config/contracts.ts` falls back to a localhost default, so with the variable UNSET the app
  // fetched an origin the CSP did not name. Blocked, and a blocked fetch renders as an empty panel
  // - indistinguishable from "nobody has traded".
  //
  // The assertion is deliberately about the RESOLVER rather than a hardcoded localhost URL: writing
  // the default out here would be the second copy all over again.
  it.each([
    ['unset', undefined],
    ['blank', ''],
  ])('names the subgraph origin the app falls back to when the variable is %s', (_label, value) => {
    const resolved = subgraphUrlFrom(value)
    expect(connectSources({ subgraphUrl: resolved })).toContain(originOf(resolved))
  })

  it('still prefers a configured subgraph over the default', () => {
    const configured = 'https://graph.example/subgraphs/name/octopus/octopus'
    const sources = connectSources({ subgraphUrl: subgraphUrlFrom(configured) })
    expect(sources).toContain('https://graph.example')
    expect(sources).not.toContain(originOf(DEFAULT_SUBGRAPH_URL))
  })
})
