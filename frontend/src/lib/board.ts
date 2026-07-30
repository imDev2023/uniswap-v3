import type { TokenRow } from './subgraph'

/**
 * Board sort modes. `new` is the default because a launchpad's core promise is "something just
 * happened"; the others exist because "what is about to graduate" and "what is actually being
 * traded" are the two other questions people arrive with.
 */
export type SortMode = 'new' | 'progress' | 'volume' | 'trades'

export const SORT_MODES: { id: SortMode; label: string; title: string }[] = [
  { id: 'new', label: 'New', title: 'Most recently launched' },
  { id: 'progress', label: 'Closest', title: 'Closest to graduating' },
  { id: 'volume', label: 'Volume', title: 'Most ETH traded on the curve' },
  { id: 'trades', label: 'Busiest', title: 'Most curve trades' },
]

export const DEFAULT_SORT: SortMode = 'new'

/** Narrow an arbitrary string (URL param, stored preference) to a real mode. */
export function parseSortMode(raw: string | null | undefined): SortMode {
  return SORT_MODES.some((m) => m.id === raw) ? (raw as SortMode) : DEFAULT_SORT
}

/**
 * Sort tokens for the board.
 *
 * @dev Returns a NEW array - callers hold react-query cache data, and sorting in place would mutate
 *      the cache and make the rendered order depend on which sort happened to run last.
 *
 *      Comparisons on wei-scale values go through BigInt, not Number: `volumeEth` is an 18-decimal
 *      string, and two launches whose volumes differ by less than a double's precision would
 *      otherwise compare equal and shuffle between renders.
 *
 *      Every mode falls back to newest-first on a tie, so the order is total and stable. Without
 *      that, the nine untraded launches on a fresh deployment reorder on every poll.
 */
export function sortTokens(tokens: readonly TokenRow[], mode: SortMode): TokenRow[] {
  const byNewest = (a: TokenRow, b: TokenRow) =>
    Number(b.createdAtTimestamp) - Number(a.createdAtTimestamp) || compareId(a, b)

  const sorted = [...tokens]
  switch (mode) {
    case 'progress':
      return sorted.sort((a, b) => b.progressBps - a.progressBps || byNewest(a, b))
    case 'volume':
      return sorted.sort((a, b) => compareBigint(a.volumeEth, b.volumeEth) || byNewest(a, b))
    case 'trades':
      return sorted.sort((a, b) => b.tradeCount - a.tradeCount || byNewest(a, b))
    case 'new':
    default:
      return sorted.sort(byNewest)
  }
}

/** Descending BigInt comparison over decimal strings. */
function compareBigint(a: string, b: string): number {
  const av = BigInt(a)
  const bv = BigInt(b)
  if (av === bv) return 0
  return av > bv ? -1 : 1
}

/** Last-resort tiebreak so the order is fully deterministic even for same-block launches. */
function compareId(a: TokenRow, b: TokenRow): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
