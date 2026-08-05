import { formatLag, isDegraded, type IndexerStatus } from '../lib/indexerHealth'

// Stage 2 makes indexer downtime a visible, bounded degradation instead of a silently broken page.
// The banner's job is to say two things at once: what is stale, and what still works. Trading runs
// on RPC and is unaffected - a user who doesn't know that will assume the whole site is down.

/** Presentational, so the copy for each state is testable without a chain or a graph-node. */
export function IndexerBanner({ status }: { status: IndexerStatus }) {
  if (!isDegraded(status.state)) return null

  return (
    <div className="banner banner-warn" role="status">
      {status.state === 'down' ? (
        <>
          <strong>Charts unavailable.</strong> Can’t reach the indexer, so feeds, price charts and
          curve positions won’t load. <strong>Trading is unaffected</strong> - buys, sells and swaps run
          directly against the chain.
        </>
      ) : (
        <>
          <strong>Charts are stale.</strong> The indexer is {formatLag(status.lagSeconds)} behind the
          chain, so recent trades may be missing from feeds and charts.{' '}
          <strong>Trading is unaffected</strong> — prices and balances are read live from the chain.
        </>
      )}
    </div>
  )
}
