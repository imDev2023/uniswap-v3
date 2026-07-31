import { Link } from 'react-router-dom'
import type { TokenRow } from '../lib/subgraph'
import { useTokenMetadata } from '../hooks/useTokenMetadata'
import { formatAge, formatEth, formatPercent } from '../lib/format'
import { heatColor, heatPercent, meterWidthPercent } from '../lib/heat'
import { Avatar } from './Avatar'
import { Price } from './Price'

/**
 * One launch on the live board.
 *
 * Denser than the card it replaces: the old one was a 280px-wide stack of label/value rows where
 * progress - the number that actually decides whether you click - was a thin 8px line with no
 * figure attached. Here progress is the visual centre, carrying both length and heat colour, and
 * the supporting numbers are compressed into a single footer row.
 */
export function BoardCard({
  token,
  now,
  isNew = false,
}: {
  token: TokenRow
  now: number
  /** Arrived since the last poll - animates in so a changing board is noticeable. */
  isNew?: boolean
}) {
  // Resolved from the token's immutable on-chain URI, and cached forever - see useTokenMetadata for
  // why that caching is load-bearing on a board that polls every 5 seconds.
  const meta = useTokenMetadata(token.id, token.metadataURI)
  const pct = heatPercent(token.progressBps)
  const heat = heatColor(token.progressBps)
  const untraded = token.tradeCount === 0

  return (
    <Link
      to={`/token/${token.id}`}
      className={`tcard${token.graduated ? ' tcard-graduated' : ''}${isNew ? ' tcard-new' : ''}`}
      // Drives the top hairline, the meter fill and the percentage label from one value, so they
      // can never disagree about how hot this curve is.
      style={{ '--heat': heat } as React.CSSProperties}
    >
      <div className="tcard-head">
        <Avatar image={meta?.image} symbol={token.symbol} address={token.id} size="sm" />
        <div className="tcard-id">
          <div className="tcard-name">{token.name}</div>
          <div className="tcard-symbol">{token.symbol}</div>
        </div>
        {/* No "Live" badge: every card in a section headed "Live curves" carries it, so it says
            nothing and costs the ~44px that was truncating names like "Robinhood Doge". Only the
            states that actually differ from the default get a badge. */}
        {token.graduated ? (
          <span className="badge badge-grad">Graduated</span>
        ) : untraded ? (
          <span className="badge badge-new">New</span>
        ) : null}
      </div>

      {token.graduated ? (
        <div className="tcard-meter">
          <div className="meter-row">
            <span className="meter-pct">Locked</span>
            <span className="meter-note">liquidity forever</span>
          </div>
        </div>
      ) : (
        <div className="tcard-meter">
          <div
            className="meter-track"
            role="progressbar"
            aria-valuenow={Math.round(pct)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${token.symbol} progress to graduation`}
          >
            <div className="meter-fill" style={{ width: `${meterWidthPercent(token.progressBps)}%` }} />
          </div>
          <div className="meter-row">
            <span className="meter-pct">{formatPct(pct)}</span>
            {/* An untraded launch says so, rather than showing "0% to graduation" beside an empty
                bar and a 0 ETH volume - three readings that together look like a broken card. */}
            <span className="meter-note">{untraded ? 'not traded yet' : 'to graduation'}</span>
          </div>
        </div>
      )}

      <div className="tcard-stats">
        <div>
          <div className="tstat-label">Price</div>
          <div className="tstat-value">
            <Price priceX18={BigInt(token.priceX18)} unit={null} />
          </div>
        </div>
        <div className="tstat-right">
          <div className="tstat-label">{untraded ? 'Launched' : 'Volume'}</div>
          <div className="tstat-value">
            {untraded
              ? formatAge(token.createdAtTimestamp, now)
              : `${formatEth(BigInt(token.volumeEth))} ETH`}
          </div>
        </div>
      </div>
    </Link>
  )
}

/**
 * Whole percents once past 1%, one decimal below it, so a sub-1% position is not shown as "0%".
 * Delegates the actual formatting to lib/format so there is one percentage renderer in the app.
 */
function formatPct(pct: number): string {
  return formatPercent(pct / 100, pct > 0 && pct < 1 ? 1 : 0)
}
