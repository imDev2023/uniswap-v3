import { useMemo } from 'react'
import type { TradeRow } from '../lib/subgraph'
import { explorerTxUrl, formatAge, formatEth, formatTokenAmount, shortAddress } from '../lib/format'
import { useArrivals } from '../hooks/useArrivals'
import { useIsScrollable } from '../hooks/useIsScrollable'
import { IndexedDataNotice } from './IndexedDataNotice'
import { Notice } from './Notice'
import { isDegraded, type IndexerState } from '../lib/indexerHealth'

/**
 * Per-token live trade feed for the token page rail.
 *
 * The board got a cross-launch pulse in #28, but the token page - the surface someone actually
 * decides on - had no motion at all, and a tall left column beside a short trade panel left the rail
 * mostly empty. This fills it with the thing a trader most wants while deciding: who is buying, how
 * much, and how recently.
 *
 * Indexer-derived, so it degrades to a labelled notice. An empty feed asserts "nobody is trading",
 * which is a different and worse claim than "we cannot see the trades right now" - the same rule
 * TradeRail follows on the board.
 */
export function TokenTradeFeed({
  trades,
  symbol,
  now,
  explorer,
  indexerState,
  isError,
  isLoading,
  graduated = false,
}: {
  trades: TradeRow[] | undefined
  symbol: string
  now: number
  explorer: string
  indexerState: IndexerState
  isError: boolean
  isLoading: boolean
  /**
   * A graduated curve is closed, so these rows are history, not a live feed. The chart eight pixels
   * away already stops dead for exactly this reason; a pulsing "Live" dot over the same closed
   * curve would contradict it on the same screen.
   */
  graduated?: boolean
}) {
  // Newest first: the feed answers "what just happened", while the chart owns chronology.
  const newestFirst = useMemo(
    () => [...(trades ?? [])].sort((a, b) => Number(b.timestamp) - Number(a.timestamp)),
    [trades],
  )
  // useArrivals keys off array identity, so this must be memoised or its effect re-runs every tick
  // of the shared clock and the flash animation never settles.
  const ids = useMemo(() => newestFirst.map((t) => t.id), [newestFirst])
  const arrivals = useArrivals(ids)
  const [scrollRef, scrollable] = useIsScrollable()

  return (
    <div className="card-flush">
      <div className="rail-head">
        {!graduated && <span className="live-dot" aria-hidden="true" />}
        {graduated ? 'Curve trades' : 'Live trades'}
      </div>

      {isError ? (
        // IndexedDataNotice renders nothing when the indexer looks healthy, which would leave this
        // panel silently blank if the query failed for some other reason. Always say something.
        isDegraded(indexerState) ? (
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
      ) : newestFirst.length === 0 ? (
        <Notice icon="◦" inline>
          {graduated
            ? 'No curve trades were recorded before graduation.'
            : 'No trades yet. The first buy shows up here.'}
        </Notice>
      ) : (
        <div className="rail-scroll" ref={scrollRef} data-scrollable={scrollable}>
          {newestFirst.map((t) => (
            <a
              key={t.id}
              className={`trade-row${arrivals.has(t.id) ? ' trade-row-new' : ''}`}
              href={explorerTxUrl(explorer, t.txHash)}
              target="_blank"
              rel="noreferrer"
              // The row shows a shortened address and a compact amount; the full figures belong
              // somewhere hoverable rather than truncated away entirely.
              title={`${t.trader} · ${formatTokenAmount(BigInt(t.amountToken))} ${symbol}`}
            >
              <span
                className={`trade-side ${t.type === 'BUY' ? 'trade-side-buy' : 'trade-side-sell'}`}
              >
                {t.type === 'BUY' ? 'buy' : 'sell'}
              </span>
              <span style={{ minWidth: 0 }}>
                <span className="trade-symbol">{shortAddress(t.trader)}</span>{' '}
                <span className="trade-eth">{formatEth(BigInt(t.amountEth))} ETH</span>
              </span>
              <span className="trade-age">{formatAge(t.timestamp, now)}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
