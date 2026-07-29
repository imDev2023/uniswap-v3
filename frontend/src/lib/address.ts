import { getAddress, isAddress, type Address } from 'viem'

/**
 * Parse a token address out of a URL parameter, tolerating any casing.
 *
 * viem's `isAddress` is STRICT by default: it rejects a mixed-case address whose EIP-55 checksum
 * doesn't match. That is the right rule for an address a user typed into a form, and the wrong rule
 * for a route parameter - a route parameter arrives from wherever the user copied it (an explorer,
 * a chat message, our own docs), and a casing difference is not a different address.
 *
 * Rejecting it strands a real token behind "Invalid token address" with no way through, which is
 * exactly the kind of avoidable dead end Stage 2 exists to remove from the trade path. So: validate
 * case-insensitively, then normalise to the canonical checksummed form for contract calls.
 *
 * This does NOT weaken any safety property. A malformed or non-existent address still fails the
 * check that matters - `launchpad.curveOf(token)` returning the zero address (see lib/onchainToken).
 */
export function parseTokenParam(raw: string | undefined): Address | null {
  if (!raw) return null
  if (!isAddress(raw, { strict: false })) return null
  return getAddress(raw)
}
