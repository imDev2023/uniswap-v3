import { Link } from 'react-router-dom'
import type { TokenRow } from '../lib/subgraph'
import { formatAge, formatEth } from '../lib/format'

/**
 * Recent graduations, as a ticker rather than a card grid.
 *
 * The old homepage gave "Just graduated" a full row of cards ABOVE the live curves, which put the
 * finished thing above the thing you can still act on - backwards for a launchpad. Graduation is
 * still the product's proudest moment (liquidity locked), so it keeps a distinct, celebratory
 * treatment; it just no longer outranks the board.
 */
export function GraduationTicker({
  tokens,
  now,
  isError,
}: {
  tokens: TokenRow[] | undefined
  now: number
  isError?: boolean
}) {
  // Rendering nothing on failure would claim "nothing has graduated", which is exactly the lie the
  // Stage 2 degradation rule exists to prevent: every indexed panel says why it is empty rather
  // than silently vanishing. An empty list, by contrast, IS the honest answer on a fresh chain.
  if (isError) {
    return (
      <div className="ticker ticker-degraded">
        <span className="ticker-label">Graduated</span>
        <span className="ticker-meta">
          Unavailable - the indexer is unreachable. Trading still works.
        </span>
      </div>
    )
  }

  if (!tokens || tokens.length === 0) return null

  return (
    <div className="ticker">
      <span className="ticker-label">
        <span className="ticker-bolt" aria-hidden="true">
          ⚡
        </span>
        Graduated
      </span>
      <div className="ticker-items">
        {tokens.map((t) => (
          <Link key={t.id} to={`/swap/${t.id}`} className="ticker-item" title={`Swap ${t.symbol}`}>
            <span className="ticker-symbol">{t.symbol}</span>
            <span className="ticker-meta">
              {formatEth(BigInt(t.volumeEth))} ETH
              {t.graduatedAtTimestamp ? ` · ${formatAge(t.graduatedAtTimestamp, now)}` : ''}
            </span>
          </Link>
        ))}
      </div>
    </div>
  )
}
