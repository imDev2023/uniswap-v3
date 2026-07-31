import { DENYLIST, type DenylistTier } from '../config/denylist'

/**
 * Reading the moderation denylist.
 *
 * Every call site goes through these functions rather than touching `DENYLIST` directly, so the
 * lookup rules (address casing, tier precedence) live in exactly one place and a runtime overlay
 * could later be merged in here without any component changing. See `config/denylist.ts` for why
 * the list is compiled in and why neither tier ever blocks trading.
 */

export type { DenylistTier }

/** The tier applying to a token, or `null` when it is not listed. */
export function denylistTier(address: string | undefined | null): DenylistTier | null {
  if (!address) return null
  return DENYLIST[address.toLowerCase()] ?? null
}

/**
 * Whether this token's own imagery must be suppressed in favour of the identicon.
 *
 * True for BOTH tiers: `hide` is strictly stronger than `image`, and a hidden token is still
 * reachable by direct link, so its picture must not render there either. Reading it as "hide means
 * it never appears, so the image tier is the only one that matters here" is the mistake this
 * function exists to prevent.
 */
export function isImageSuppressed(address: string | undefined | null): boolean {
  return denylistTier(address) !== null
}

/** Whether this token is kept out of discovery surfaces: the board, the rails, the feeds. */
export function isHidden(address: string | undefined | null): boolean {
  return denylistTier(address) === 'hide'
}

/**
 * Drop hidden tokens from a list.
 *
 * Generic over anything carrying an `id`, so the board's `TokenRow[]`, the graduation feed and the
 * trade rails all filter through the same rule instead of each re-deriving it.
 */
export function withoutHidden<T extends { id: string }>(rows: readonly T[]): T[] {
  return rows.filter((r) => !isHidden(r.id))
}
