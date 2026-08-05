import { gatewayUrls } from './ipfs'

// Validation for the create form's metadata URI field.
//
// ⚠️ **This is a permanent on-chain write with no setter, for anyone** (ADR-0002). Until #37 the
// field had NO validation at all: `ipfs//cid`, free text, `javascript:alert(1)` and a lone space all
// passed straight into `createLaunch`, and the read side then silently ignored every one of them.
// The creator saw a successful launch and a blank avatar forever, with nothing anywhere telling them
// which of the two had gone wrong.
//
// ⚠️ **The rule is derived from `gatewayUrls`, not restated.** That function IS the read side: if it
// returns no URL, nothing in this product will ever fetch the document, so the field is unusable by
// definition. Writing a second, parallel ruleset here is how the two drift - a form that accepts a
// spelling the reader drops is exactly the defect being fixed, reintroduced one refactor later.
// The `reason` below is advisory copy layered ON TOP of that verdict; the verdict itself is one call.

export type UriVerdict =
  /** The field is empty. Legitimate - v1 is bring-your-own-URI and most launches have none. */
  | { kind: 'empty' }
  /** `gatewayUrls` would produce at least one fetchable URL. */
  | { kind: 'ok'; resolved: string }
  /** Nothing in this product would ever fetch it. `reason` says why, as specifically as it can. */
  | { kind: 'invalid'; reason: string }

/**
 * Classify a metadata URI exactly as the read side would, with a reason when it fails.
 *
 * The reasons are ordered most-specific-first: each recognises a concrete mistake a creator actually
 * makes, and the generic message is the fallback for everything else. A message naming the mistake
 * ("the scheme is `ipfs://`, with a colon") is worth far more than "invalid" on a field whose value
 * can never be edited.
 */
export function classifyMetadataUri(raw: string): UriVerdict {
  const uri = raw.trim()
  if (!uri) return { kind: 'empty' }

  // Checked before `gatewayUrls`, because these produce a specific diagnosis rather than a generic
  // one. `gatewayUrls` would reject all of them anyway - these branches only choose better words.
  if (/\s/.test(uri)) {
    return { kind: 'invalid', reason: 'Contains a space. A URI cannot contain whitespace.' }
  }
  if (/^ipfs\/\//i.test(uri) || /^ipfs:\/(?!\/)/i.test(uri)) {
    return { kind: 'invalid', reason: 'Malformed scheme. Write it as ipfs://<cid>, with a colon and two slashes.' }
  }
  if (/^http:\/\//i.test(uri)) {
    return {
      kind: 'invalid',
      reason: 'Plain http is blocked by the browser on an https page, so this would never load. Use https:// or ipfs://.',
    }
  }
  if (/^(javascript|vbscript|file|blob):/i.test(uri)) {
    return { kind: 'invalid', reason: 'Not a fetchable document scheme.' }
  }

  const [resolved] = gatewayUrls(uri)
  if (!resolved) {
    return {
      kind: 'invalid',
      reason: 'Not a URI this app can resolve. Use ipfs://<cid>, a bare CID, or an https:// URL.',
    }
  }
  return { kind: 'ok', resolved }
}

/** Whether the create form should let this value be submitted. Empty is allowed; broken is not. */
export function isSubmittableMetadataUri(raw: string): boolean {
  return classifyMetadataUri(raw).kind !== 'invalid'
}
