import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { isLaunchpadConfigured } from '../config/contracts'
import {
  BOARD_PAGE_SIZE,
  useActiveTokens,
  useFactoryStats,
  useGraduatedTokens,
  useRecentTrades,
} from '../hooks/useSubgraph'
import { useNowSeconds } from '../hooks/useNowSeconds'
import { useArrivals } from '../hooks/useArrivals'
import { useIndexerStatus } from '../hooks/useIndexerStatus'
import { formatEth } from '../lib/format'
import { DEFAULT_SORT, SORT_MODES, orderByFor, sortTokens, type SortMode } from '../lib/board'
import { BoardCard } from '../components/BoardCard'
import { GraduationTicker } from '../components/GraduationTicker'
import { TradeRail } from '../components/TradeRail'
import { Notice } from '../components/Notice'

/**
 * The live board.
 *
 * Structure follows the Stage 3 decision to re-think flows rather than only restyle. The previous
 * page led with a full-height hero, then a row of GRADUATED cards, and only then the live curves -
 * so the two things a visitor can act on (buy a live curve, launch one) sat below the fold behind
 * the one thing they cannot. Now: a slim masthead, graduations compressed to a ticker, and the
 * board itself immediately, with a live cross-launch trade feed alongside it.
 *
 * The Stage 2 split is preserved: everything here is indexer-derived DISCOVERY, and every panel
 * degrades to its own labelled notice. Trading never depends on this page.
 */
export function HomePage() {
  const [sort, setSort] = useState<SortMode>(DEFAULT_SORT)

  // The sort drives the QUERY, not just the rendered order: the board is paged, so ranking has to
  // happen server-side or "Closest" would only ever rank the newest page.
  const { data: tokens, isLoading, isError } = useActiveTokens(orderByFor(sort))
  const { data: graduated, isError: graduatedError } = useGraduatedTokens()
  const { data: stats } = useFactoryStats()
  const { data: trades, isError: tradesError, isLoading: tradesLoading } = useRecentTrades()

  // One clock for the whole render, so every age on the page agrees with every other.
  const now = useNowSeconds()
  const indexer = useIndexerStatus()

  // The server has already ranked these; sortTokens only applies the deterministic tiebreak so
  // equal-keyed rows (nine untraded launches from one block) hold still between polls.
  const sorted = useMemo(() => sortTokens(tokens ?? [], sort), [tokens, sort])

  // New launches flash in, so a board that changes while you are looking at it says so.
  const boardIds = useMemo(() => sorted.map((t) => t.id), [sorted])
  const arrivals = useArrivals(boardIds)

  // The factory rollup knows the real total; `sorted.length` is only the page we asked for.
  const liveTotal = stats ? stats.launchCount - stats.graduationCount : undefined
  const boardCount = sorted.length >= BOARD_PAGE_SIZE && liveTotal ? liveTotal : sorted.length

  return (
    <>
      <section className="masthead">
        <div>
          <h1>Launch fair. Graduate locked.</h1>
          <p>
            Bonding curves with zero upfront liquidity. Every graduation locks its pool forever - no
            pre-mine, no rug.
          </p>
        </div>
        <div className="masthead-stats">
          <div>
            <div className="mstat-value num">{stats?.launchCount ?? '-'}</div>
            <div className="mstat-label">Launched</div>
          </div>
          <div>
            <div className="mstat-value num">{stats?.graduationCount ?? '-'}</div>
            <div className="mstat-label">Graduated</div>
          </div>
          <div>
            <div className="mstat-value num">
              {stats ? formatEth(BigInt(stats.totalVolumeEth)) : '-'}
            </div>
            <div className="mstat-label">Volume (ETH)</div>
          </div>
        </div>
      </section>

      <GraduationTicker tokens={graduated} now={now} isError={graduatedError} />

      <div className="board-layout">
        <main>
          <div className="board-head">
            <h2 className="board-title">
              <span className="live-dot" aria-hidden="true" />
              Live curves
              {sorted.length > 0 && <span className="board-count">{boardCount}</span>}
            </h2>
            <div className="sorts" role="group" aria-label="Sort live curves">
              {SORT_MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className="sort"
                  title={m.title}
                  aria-pressed={sort === m.id}
                  onClick={() => setSort(m.id)}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {!isLaunchpadConfigured ? (
            <Notice icon="⚙" title="Not configured for this build">
              The launchpad contract addresses aren’t set - see the banner above.
            </Notice>
          ) : isError ? (
            // Browsing the launch list is a DISCOVERY feature and genuinely needs the indexer.
            // Trading does not (Stage 2) - so say what still works, and give a way through: anyone
            // holding a token address can still reach its trade page directly.
            <Notice icon="◔" title="Can’t reach the indexer">
              The live-curve list can’t load. Trading is unaffected - open a token directly at{' '}
              <code>/token/&lt;address&gt;</code> to buy, sell or swap it.
            </Notice>
          ) : isLoading ? (
            <div className="board-grid" aria-busy="true" aria-label="Loading curves">
              {Array.from({ length: 8 }, (_, i) => (
                <div key={i} className="skeleton-card" />
              ))}
            </div>
          ) : sorted.length === 0 ? (
            <Notice icon="🐙" title="No live curves yet">
              Nothing is on the curve right now.{' '}
              <Link to="/create" className="link-accent">
                Launch the first one →
              </Link>
            </Notice>
          ) : (
            <div className="board-grid">
              {sorted.map((t) => (
                <BoardCard key={t.id} token={t} now={now} isNew={arrivals.has(t.id)} />
              ))}
            </div>
          )}
        </main>

        <TradeRail
          trades={trades}
          now={now}
          isError={tradesError}
          isLoading={tradesLoading}
          indexerState={indexer.state}
        />
      </div>
    </>
  )
}
