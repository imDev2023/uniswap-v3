import { Link } from 'react-router-dom'
import type { TokenRow } from '../lib/subgraph'
import { formatAge, formatEth } from '../lib/format'

/**
 * Recent graduations, as a ticker rather than a card grid.
 *
 * The old homepage gave "Just graduated" a full row of cards ABOVE the live curves, which put the
 * finished thing above the thing you can still act on - backwards for a launchpad. Graduation is
 * still the product's proudest moment (liquidity locked forever), so it keeps a distinct, celebratory
 * treatment; it just no longer outranks the board.
 */
export function GraduationTicker({ tokens, now }: { tokens: TokenRow[]; now: number }) {
  if (tokens.length === 0) return null

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
