// Stage 4 key protection: every `VITE_*` value is INLINED into the JavaScript Vite emits, so a
// keyed RPC URL put there is published verbatim to anyone who opens the bundle. Measured on this
// project's own build: one `https://<sub>.g.alchemy.com/v2/<32 chars>` literal, in plaintext.
//
// This module is the pure half of the defence - it decides whether a piece of text contains a
// credential-shaped URL, so `vite.config.ts` can fail the build before such a bundle is ever
// written. It is deliberately free of Node, of Vite and of `import.meta.env`, so the policy is
// testable on its own.
//
// The rule is shape-based rather than a list of providers. A list would be out of date the first
// time we tried a provider nobody had added to it, and the failure mode of being out of date is
// silence - exactly the failure this guard exists to prevent.

/**
 * URL-shaped runs of text.
 *
 * Scanning is restricted to `http(s)://...` so the classifier looks at URLs rather than at every
 * long string in a minified vendor chunk. The terminators are the characters that end a string
 * literal in emitted JS, HTML or CSS, so a URL inside `"..."`, `'...'` or a template literal stops
 * at its own quote rather than swallowing the rest of the file.
 */
const URL_PATTERN = /https?:\/\/[^\s"'`<>\\)]+/g

/**
 * Query parameter names that carry an API credential.
 *
 * Lowercased at comparison time, because providers disagree on casing (`apiKey` and `apikey` are
 * both in the wild).
 */
const CREDENTIAL_QUERY_KEYS = new Set([
  'key',
  'apikey',
  'api_key',
  'api-key',
  'accesskey',
  'access_token',
  'auth',
  'dkey',
  'token',
])

/**
 * Does this look like an opaque token rather than something a human wrote?
 *
 * Two signals, both required. The alphabet must be the one tokens are drawn from, and it must mix
 * letters with digits - which is what separates a credential from an English word of the same
 * length, and from the placeholders that legitimately appear in code and docs (`REDACTED`,
 * `YOUR_KEY_HERE`, `<your-key>`).
 *
 * `minLength` differs by position, because the surrounding evidence differs. A path segment has to
 * be told apart from a route, so it needs 20 characters - below every provider token measured
 * (Alchemy 32, QuickNode 32, Infura 32) and above every routing segment a JSON-RPC URL uses (`v2`,
 * `rpc`, `mainnet`). A query value sitting under a parameter literally named `apiKey` has already
 * declared itself, so 12 is enough there.
 */
const isOpaqueToken = (value: string, minLength: number): boolean =>
  value.length >= minLength &&
  /^[A-Za-z0-9_-]+$/.test(value) &&
  /[A-Za-z]/.test(value) &&
  /\d/.test(value)

const PATH_SEGMENT_MIN = 20
const QUERY_VALUE_MIN = 12

/** Where in a URL the credential was found, so the build error can say what to move. */
export type CredentialLocation = 'path' | 'query'

export interface CredentialFinding {
  /** The URL as it appeared, with the secret already replaced. NEVER carries key material. */
  redacted: string
  /** Which part of the URL held it. */
  location: CredentialLocation
}

// Plain alphanumerics on purpose: `URL` percent-encodes anything else when it is written back into
// a pathname or a query value, and `%3Credacted%3E` in a build error reads like corruption rather
// than like a deliberate removal. It also fails `isOpaqueToken` in both positions - no digits, and
// shorter than either minimum - so re-scanning already-redacted text finds nothing.
const REDACTION = 'REDACTED'

/**
 * Classify one URL, returning the finding with the secret already removed.
 *
 * Redaction happens here rather than at the reporting site so there is exactly one path by which a
 * finding can be produced, and it cannot produce an unredacted one. Everything downstream - a build
 * error, a log line, a test snapshot - is safe to print by construction. This project's hard rule is
 * that nothing from `contracts/.env` or `frontend/.env.local` is ever echoed, and a guard that
 * printed the key it caught would break that rule precisely when it fires.
 *
 * Returns `null` for a URL that carries no credential.
 */
export function classifyUrl(url: string): CredentialFinding | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    // Not a URL after all. The scanner is deliberately loose about where a URL ends, so this is an
    // expected outcome rather than an error worth reporting.
    return null
  }

  for (const [name, value] of parsed.searchParams) {
    if (!CREDENTIAL_QUERY_KEYS.has(name.toLowerCase())) continue
    if (!isOpaqueToken(value.trim(), QUERY_VALUE_MIN)) continue
    const redacted = new URL(parsed.href)
    redacted.searchParams.set(name, REDACTION)
    return { redacted: redacted.href, location: 'query' }
  }

  const segments = parsed.pathname.split('/')
  const index = segments.findIndex((segment) => isOpaqueToken(segment, PATH_SEGMENT_MIN))
  if (index !== -1) {
    const redacted = new URL(parsed.href)
    redacted.pathname = segments.map((s, i) => (i === index ? REDACTION : s)).join('/')
    return { redacted: redacted.href, location: 'path' }
  }

  return null
}

/**
 * Every distinct credential-shaped URL in a blob of text, already redacted.
 *
 * Deduplicated on the redacted form: a bundler may repeat one literal, and reporting it twenty
 * times would bury the one thing the reader has to act on.
 */
export function findCredentials(text: string): CredentialFinding[] {
  const byRedacted = new Map<string, CredentialFinding>()
  for (const match of text.matchAll(URL_PATTERN)) {
    const finding = classifyUrl(match[0])
    if (finding !== null && !byRedacted.has(finding.redacted)) {
      byRedacted.set(finding.redacted, finding)
    }
  }
  return [...byRedacted.values()]
}
