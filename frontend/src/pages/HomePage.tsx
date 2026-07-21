import { Link } from 'react-router-dom'
import { isLaunchpadConfigured } from '../config/contracts'
import { useActiveTokens, useFactoryStats, useGraduatedTokens } from '../hooks/useSubgraph'
import { formatEth } from '../lib/format'
import { TokenCard } from '../components/TokenCard'

export function HomePage() {
  const { data: tokens, isLoading, isError } = useActiveTokens()
  const { data: graduated } = useGraduatedTokens()
  const { data: stats } = useFactoryStats()

  return (
    <>
      <section className="hero">
        <h1>Launch fair. Graduate locked.</h1>
        <p>
          Create a token on a bonding curve with zero upfront liquidity. It graduates automatically
          into a permanently-locked Uniswap V3 pool the instant it fills — no pre-mine, no rug.
        </p>
        <div className="stat-row">
          <div className="stat">
            <div className="stat-value num">{stats?.launchCount ?? '—'}</div>
            <div className="stat-label">Tokens launched</div>
          </div>
          <div className="stat">
            <div className="stat-value num">{stats?.graduationCount ?? '—'}</div>
            <div className="stat-label">Graduated</div>
          </div>
          <div className="stat">
            <div className="stat-value num">
              {stats ? formatEth(BigInt(stats.totalVolumeEth)) : '—'}
            </div>
            <div className="stat-label">Curve volume (ETH)</div>
          </div>
        </div>
      </section>

      {graduated && graduated.length > 0 && (
        <section style={{ marginBottom: 36 }}>
          <div className="row-between" style={{ marginBottom: 16 }}>
            <h2 style={{ fontSize: 18, margin: 0 }}>
              <span className="brand-mark" style={{ marginRight: 8 }}>
                🎓
              </span>
              Just graduated
            </h2>
            <span className="muted" style={{ fontSize: 13 }}>
              liquidity locked forever
            </span>
          </div>
          <div className="token-grid">
            {graduated.map((t) => (
              <TokenCard key={t.id} token={t} />
            ))}
          </div>
        </section>
      )}

      <div className="row-between" style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 18, margin: 0 }}>Live curves</h2>
        <Link to="/create" className="link-accent">
          + Launch a token
        </Link>
      </div>

      {!isLaunchpadConfigured ? (
        <p className="center-note">
          The launchpad contracts aren’t configured for this build yet — see the banner above.
        </p>
      ) : isError ? (
        <p className="center-note">
          Couldn’t reach the subgraph. Check <code>VITE_SUBGRAPH_URL</code> for this build.
        </p>
      ) : isLoading ? (
        <div className="spinner">Loading curves…</div>
      ) : !tokens || tokens.length === 0 ? (
        <p className="center-note">
          No live curves yet. <Link to="/create" className="link-accent">Launch the first one →</Link>
        </p>
      ) : (
        <div className="token-grid">
          {tokens.map((t) => (
            <TokenCard key={t.id} token={t} />
          ))}
        </div>
      )}
    </>
  )
}
