import { GATEWAY_TIMEOUT_MS, gatewayUrls, resolveMediaUrl } from './ipfs'

/**
 * Parse and fetch the JSON document a token's `metadataURI` points at.
 *
 * The shape was settled in build #24 as NFT-standard-ish - `{name, description, image, banner,
 * links}` - chosen over a bare image URI so a launch can gain a description or socials later
 * without a new contract. Nothing about that document is trustworthy: the URI is attacker-chosen,
 * immutable, and served by a third party. So every field is treated as hostile input and the parser
 * is a whitelist, not a cast.
 *
 * The failure modes here are not hypothetical - they are what the seeded testnet launches actually
 * do today, and each was measured rather than imagined:
 *
 *  - **no URI at all** (nine of twelve launches) - never fetched
 *  - **504 with an HTML error page** (`OCAT`, `BOOTS` - valid CIDs, never pinned)
 *  - **200 with a zero-byte body** (`META`) - the case a naive `res.json()` throws on
 *  - JSON that parses but is an array, a string, or an object with no usable `image`
 *
 * All of them resolve to `null` and the caller renders the deterministic identicon from #28.
 */

export interface TokenLink {
  label: string
  url: string
}

export interface TokenMetadata {
  name?: string
  description?: string
  /** Ready to put in an `<img src>` - already gateway-resolved. */
  image?: string
  /** Ready to put in an `<img src>` - already gateway-resolved. */
  banner?: string
  links: TokenLink[]
}

/**
 * Caps on rendered text.
 *
 * A metadata document is arbitrary third-party bytes, so an unbounded `description` is a layout
 * attack: a megabyte of text in a card would push every other launch off the board. Truncating at
 * parse time means no component has to remember to.
 */
const MAX_NAME = 80
const MAX_DESCRIPTION = 1_000
const MAX_LINKS = 6
const MAX_LINK_LABEL = 24

/** Largest metadata document worth reading, so a hostile URI cannot stream forever into memory. */
const MAX_DOCUMENT_BYTES = 100_000

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim().slice(0, max)
  return s || undefined
}

/**
 * Keep a link only if it is `https:`.
 *
 * This is the one field that becomes an `href`, which makes it the one genuine injection route in
 * the document: `javascript:` in an anchor executes on click. Allowlisting the single scheme we
 * want is the only check that stays correct as schemes get invented.
 */
function safeLinkUrl(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  try {
    const url = new URL(v.trim())
    return url.protocol === 'https:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

/**
 * `links` in the wild is either a labelled map (`{twitter: "https://…"}`) or an array of
 * `{label, url}`. Both are accepted and normalised, because the shape was never pinned down beyond
 * the field name and rejecting the other spelling would just silently drop a creator's socials.
 */
function parseLinks(v: unknown): TokenLink[] {
  const out: TokenLink[] = []
  const push = (label: unknown, rawUrl: unknown) => {
    if (out.length >= MAX_LINKS) return
    const url = safeLinkUrl(rawUrl)
    if (!url) return
    const text = str(label, MAX_LINK_LABEL) ?? new URL(url).hostname
    out.push({ label: text, url })
  }

  if (Array.isArray(v)) {
    for (const entry of v) {
      if (entry && typeof entry === 'object') {
        const e = entry as Record<string, unknown>
        push(e.label ?? e.name ?? e.type, e.url ?? e.href ?? e.value)
      } else {
        push(undefined, entry)
      }
    }
  } else if (v && typeof v === 'object') {
    for (const [key, value] of Object.entries(v as Record<string, unknown>)) push(key, value)
  }
  return out
}

/**
 * Turn a decoded JSON value into metadata we are willing to render, or `null` if there is nothing
 * usable in it.
 *
 * "Usable" deliberately means more than "parsed": a document with no image, no name and no
 * description is indistinguishable to a viewer from having no metadata at all, so it returns `null`
 * and lets the identicon path handle it rather than producing an empty object every caller then has
 * to test the fields of.
 */
export function parseTokenMetadata(raw: unknown): TokenMetadata | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const doc = raw as Record<string, unknown>

  const meta: TokenMetadata = {
    name: str(doc.name, MAX_NAME),
    description: str(doc.description, MAX_DESCRIPTION),
    // `image_url` is the other spelling in common use; accepting it costs nothing and its absence
    // would show as a permanently blank avatar with no way to correct the URI.
    image: resolveMediaUrl(str(doc.image, 2_048) ?? str(doc.image_url, 2_048)),
    banner: resolveMediaUrl(str(doc.banner, 2_048) ?? str(doc.banner_url, 2_048)),
    links: parseLinks(doc.links ?? doc.external_links),
  }

  const hasAnything =
    !!meta.image || !!meta.banner || !!meta.name || !!meta.description || meta.links.length > 0
  return hasAnything ? meta : null
}

/** Injected in tests so the fetch policy is exercised without a network. */
export interface FetchDeps {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/**
 * Read one URL with a hard deadline, returning `null` for every failure rather than throwing.
 *
 * The deadline is enforced with `AbortController` rather than `Promise.race`, so a slow gateway's
 * socket is actually released instead of being left running behind a resolved promise - the
 * difference matters when a board of forty cards is resolving at once.
 *
 * `res.json()` is deliberately not used. It throws on both of the bodies real gateways return for a
 * miss - an HTML 504 page and a zero-byte 200 - and a throw here would be indistinguishable from a
 * network fault. Reading text and parsing it ourselves keeps every failure on the same quiet path.
 */
async function readJson(url: string, deps: FetchDeps): Promise<unknown | null> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const timeoutMs = deps.timeoutMs ?? GATEWAY_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' })
    if (!res.ok) return null
    const text = await res.text()
    if (!text || text.length > MAX_DOCUMENT_BYTES) return null
    return JSON.parse(text)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fetch a token's metadata, trying each gateway in turn.
 *
 * Sequential rather than raced: racing would double the load we put on free public gateways for
 * every token on every board, to save time only in the case where the first one is down. The
 * timeout is what keeps the sequential cost bounded.
 */
export async function fetchTokenMetadata(
  uri: string,
  deps: FetchDeps = {},
): Promise<TokenMetadata | null> {
  for (const url of gatewayUrls(uri)) {
    const raw = await readJson(url, deps)
    if (raw !== null) {
      const meta = parseTokenMetadata(raw)
      // A gateway that answered with unusable content has answered: trying the next one would
      // fetch the identical bytes, since a CID addresses exactly one document.
      return meta
    }
  }
  return null
}
