import { isDegraded, type IndexerState } from '../lib/indexerHealth'
import { IndexedDataNotice } from './IndexedDataNotice'
import { Notice } from './Notice'

/**
 * The non-row states shared by both trade feeds: the board's cross-launch `TradeRail` and the token
 * page's per-token `TokenTradeFeed`.
 *
 * Extracted because the two had drifted into the same four-way branch and then acquired the **same
 * bug in the same place**: each consulted indexer health only on its ERROR branch, so an indexer
 * that was merely behind - which does not error, it answers successfully with an empty array for a
 * token it has not reached - fell through to "No trades yet" and asserted that nobody had traded.
 * Fixing it twice in parallel is what made the duplication worth removing: a third feed would
 * otherwise inherit the same defect a third time.
 *
 * `emptyMessage` is the only genuinely per-feed copy, because only the caller knows whether an
 * empty list means "nothing yet" or "nothing before this curve graduated".
 */
export function TradeFeedState({
  indexerState,
  isError,
  isLoading,
  isEmpty,
  emptyMessage,
}: {
  indexerState: IndexerState
  isError: boolean
  isLoading: boolean
  isEmpty: boolean
  emptyMessage: string
}) {
  const degraded = isDegraded(indexerState)

  // Checked for BOTH the error and the empty case. That is the whole point of this component: a
  // lagging indexer reaches us as an empty list, never as an error.
  if (degraded && (isError || isEmpty)) {
    return <IndexedDataNotice state={indexerState} what="Trade feed" />
  }

  if (isError) {
    // The indexer looks healthy, so this failed for some other reason. IndexedDataNotice renders
    // nothing when health is fine, which would leave the panel silently blank - always say
    // something.
    return (
      <Notice icon="◔" inline>
        Trade feed unavailable. Trading still works.
      </Notice>
    )
  }

  if (isLoading) {
    return (
      <div className="spinner" style={{ padding: 'var(--s-5)' }}>
        Loading…
      </div>
    )
  }

  return (
    <Notice icon="◦" inline>
      {emptyMessage}
    </Notice>
  )
}

/**
 * Whether a feed may show its pulsing "live" dot.
 *
 * A dot asserts real-time. An indexer hours behind is not real-time, so the claim has to be
 * withdrawn - for the same reason a graduated curve never gets one.
 */
export function isFeedLive(indexerState: IndexerState): boolean {
  return !isDegraded(indexerState)
}
