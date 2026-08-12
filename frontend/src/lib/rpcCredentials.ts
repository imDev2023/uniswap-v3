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

/**
 * What a URL's own shape says, before this build's configuration has any say.
 *
 * The primary type: `classifyUrl` returns exactly this, and cannot decide that anything is
 * published, because that is a fact about the build rather than about the URL.
 */
export interface CredentialShape {
  /** The URL as it appeared, with the secret already replaced. NEVER carries key material. */
  redacted: string
  /** Which part of the URL held it. */
  location: CredentialLocation
}

export interface CredentialFinding extends CredentialShape {
  /**
   * The project declared this exact URL published to every visitor, so it is reported rather than
   * fatal. Set by `findCredentials` from its `publishedUrls` argument; nothing about the URL's own
   * shape can produce it.
   */
  published: boolean
}

/**
 * The canonical form of a URL, for comparing one against another.
 *
 * `URL` normalises the parts that vary without meaning - a default port, an empty query, the case
 * of the host - so two spellings of one endpoint compare equal. Returns `null` for anything that is
 * not a URL, which then matches nothing.
 */
const canonical = (raw: string): string | null => {
  try {
    return new URL(raw).href
  } catch {
    return null
  }
}

/**
 * Has this project already decided this exact URL is visible to every visitor?
 *
 * ⚠️ EXACT, and deliberately not a provider or origin rule. The endpoint that motivated this is a
 * managed subgraph, whose URL carries an opaque tenant segment
 * (`https://api.goldsky.com/api/public/project_<id>/...`) that is credential-SHAPED without being a
 * credential: it is read-only over data already public on chain, it cannot deploy or mutate, and the
 * browser has to reach it directly, so no configuration exists in which it is not published. The
 * remedy the guard offers - move it behind the RPC proxy - does not apply, because the subgraph is
 * not routed through `/rpc`.
 *
 * Matching the ORIGIN instead would exempt every future URL from that host, including a genuinely
 * keyed one. Matching the exact URL means a second endpoint at the same host is judged on its own.
 *
 * ⚠️ A QUERY-STRING credential is never exemptible, whatever the caller passes.
 * `location: 'query'` means the URL carried something under a parameter literally named `apiKey`,
 * `access_token` or similar. Nothing is published BY CONSTRUCTION under a name like that: the tenant
 * segment that motivated the exemption is a path segment, and a provider that wants a key in the
 * query is asking for a secret. So this returns false before the list is even consulted, and no
 * entry can override it. Defence in depth rather than the primary control - the primary control is
 * that the list is a tracked constant.
 *
 * ⚠️ This is an ALLOWLIST, and that is why it does not contradict the module's refusal to keep a
 * list of providers at the top of this file. That refusal is about a DENYLIST of credential-bearing
 * hosts, which fails SILENT when it goes out of date.
 *
 * ⚠️ The allowlist fails LOUD **only because it is a tracked constant**
 * (`PUBLISHED_SUBGRAPH_URLS` in `../config/subgraphUrl.ts`). That is not a property of allowlists in
 * general and it was not true when this was first written: the list was computed from
 * `VITE_SUBGRAPH_URL`, the same variable that put the URL in the bundle, so it moved with the
 * endpoint and could never stop matching. Anything placed in that variable was exempt, including a
 * real key. Never wire this argument back to the environment.
 */
const isPublished = (
  shape: CredentialShape,
  url: string,
  publishedUrls: readonly string[],
): boolean => {
  if (shape.location === 'query') return false
  const target = canonical(url)
  if (target === null) return false
  return publishedUrls.some((candidate) => canonical(candidate) === target)
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
export function classifyUrl(url: string): CredentialShape | null {
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
 *
 * ⚠️ The dedup key carries `published` as well as the redacted URL, and it has to. Redaction
 * replaces the opaque segment, so two DIFFERENT endpoints at one host reduce to the same string -
 * `https://api.goldsky.com/api/public/REDACTED/...` for every project id there is. Keying on the
 * redacted form alone would let a published endpoint absorb an unpublished one that happens to
 * redact identically, and the survivor would carry whichever flag was seen first.
 *
 * @param publishedUrls URLs this project has already established are visible to every visitor, so
 *        finding one is not a leak. Exact matches only, and never a query-string credential - see
 *        `isPublished`. Pass a tracked constant, never a value read from the environment.
 */
export function findCredentials(
  text: string,
  publishedUrls: readonly string[] = [],
): CredentialFinding[] {
  const seen = new Map<string, CredentialFinding>()
  for (const match of text.matchAll(URL_PATTERN)) {
    const shape = classifyUrl(match[0])
    if (shape === null) continue
    const finding: CredentialFinding = {
      ...shape,
      published: isPublished(shape, match[0], publishedUrls),
    }
    const key = `${finding.published} ${finding.redacted}`
    if (!seen.has(key)) seen.set(key, finding)
  }
  return [...seen.values()]
}

/**
 * The same text with every credential-shaped URL replaced by its redacted form.
 *
 * Used by the RPC proxy on an upstream ERROR body before returning it to the browser. A provider
 * that rejects a key can quote it back - "invalid api key ..." - and a proxy that streamed that
 * response through would publish, to every visitor, precisely the credential it exists to hide.
 * Passing the body on rather than swallowing it keeps a failing upstream diagnosable.
 *
 * ⚠️ Bounded by the same rule as the rest of this module: it recognises credentials INSIDE URLs.
 * A body quoting a bare key with no surrounding URL is not matched, so this reduces the leak rather
 * than closing it, and it is not a licence to return upstream errors unexamined.
 */
export function redactCredentials(text: string): string {
  return text.replace(URL_PATTERN, (url) => classifyUrl(url)?.redacted ?? url)
}
