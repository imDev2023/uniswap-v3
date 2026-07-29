import { isDegraded, type IndexerState } from '../lib/indexerHealth'

// Inline placeholder for a panel whose data comes from the indexer (chart, holders, curve stats).
// Deliberately says what is missing and that it doesn't block trading, rather than showing an empty
// chart - an empty chart reads as "this token has no trades", which is a different and worse lie.
export function IndexedDataNotice({
  state,
  what,
}: {
  state: IndexerState
  /**
   * What this panel would have shown, e.g. "Price history". Phrased as a bare noun and followed by
   * a dash rather than "is/are", so singular and plural labels ("Curve stats") both read correctly.
   */
  what: string
}) {
  if (!isDegraded(state)) return null
  return (
    <div className="center-note" role="status">
      {what} unavailable — the indexer is {state === 'down' ? 'unreachable' : 'behind the chain'}.
      Trading still works.
    </div>
  )
}
