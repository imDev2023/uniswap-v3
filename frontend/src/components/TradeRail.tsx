import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import type { RecentTradeRow } from '../lib/subgraph'
import { formatAge, formatEth } from '../lib/format'
import { useArrivals } from '../hooks/useArrivals'
import { useIsScrollable } from '../hooks/useIsScrollable'
import { isDegraded, type IndexerState } from '../lib/indexerHealth'
import { IndexedDataNotice } from './IndexedDataNotice'
import { Notice } from './Notice'

/**
 * Cross-launch live trade feed.
 *
 * This is the board's pulse: the one surface that answers "is anything actually happening here?"
 * without the visitor having to open a token. It is indexer-derived, so it degrades to a labelled
 * notice rather than to an empty list - an empty feed reads as "nobody is trading", which is a
 * different and worse claim than "we cannot see the trades right now".
 */
export function TradeRail({
  trades,
  now,
  isError,
  isLoading,
  indexerState,
}: {
  trades: RecentTradeRow[] | undefined
  now: number
  isError: boolean
  isLoading: boolean
  /** Passed in rather than read here, so this stays presentational - as TokenTradeFeed does. */
  indexerState: IndexerState
}) {
  // Memoised: useArrivals depends on this array's identity, and a fresh array every render would
  // re-run its effect on every tick of the shared clock.
  const ids = useMemo(() => (trades ?? []).map((t) => t.id), [trades])
  const arrivals = useArrivals(ids)
  const [scrollRef, scrollable] = useIsScrollable()

  // An indexer that is merely BEHIND answers successfully with an empty list, so the error branch
  // below never sees it and "no rows" cannot on its own mean "nobody has traded". The same check
  // therefore has to guard the empty branch.
  const degraded = isDegraded(indexerState)

  return (
    <aside className="rail" aria-label="Recent trades">
      <div className="rail-head">
        {/* A pulsing dot asserts real-time; drop it when the data demonstrably is not. */}
        {!degraded && <span className="live-dot" aria-hidden="true" />}
        Live trades
      </div>

      {isError ? (
        // Diagnose, do not guess. This used to assert "the indexer is unreachable" for ANY query
        // failure, which states something false whenever the indexer is demonstrably healthy and
        // the request failed for some other reason - the same class of confident wrong claim the
        // rest of this work exists to remove.
        degraded ? (
          <IndexedDataNotice state={indexerState} what="Trade feed" />
        ) : (
          <Notice icon="◔" inline>
            Trade feed unavailable. Trading still works.
          </Notice>
        )
      ) : isLoading ? (
        <div className="spinner" style={{ padding: 'var(--s-5)' }}>
          Loading…
        </div>
      ) : !trades || trades.length === 0 ? (
        degraded ? (
          <IndexedDataNotice state={indexerState} what="Trade feed" />
        ) : (
          <Notice icon="◦" inline>
            No trades yet. The first buy shows up here.
          </Notice>
        )
      ) : (
        <div className="rail-scroll" ref={scrollRef} data-scrollable={scrollable}>
          {trades.map((t) => (
            <Link
              key={t.id}
              to={`/token/${t.token.id}`}
              className={`trade-row${arrivals.has(t.id) ? ' trade-row-new' : ''}`}
            >
              <span className={`trade-side ${t.type === 'BUY' ? 'trade-side-buy' : 'trade-side-sell'}`}>
                {t.type === 'BUY' ? 'buy' : 'sell'}
              </span>
              <span style={{ minWidth: 0 }}>
                <span className="trade-symbol">{t.token.symbol}</span>{' '}
                <span className="trade-eth">{formatEth(BigInt(t.amountEth))} ETH</span>
              </span>
              <span className="trade-age">{formatAge(t.timestamp, now)}</span>
            </Link>
          ))}
        </div>
      )}
    </aside>
  )
}
