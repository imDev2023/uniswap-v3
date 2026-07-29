import { Link, Route, Routes } from 'react-router-dom'
import { ConnectButton } from './components/ConnectButton'
import { ConfigBanner } from './components/ConfigBanner'
import { IndexerBanner } from './components/IndexerBanner'
import { useIndexerStatus } from './hooks/useIndexerStatus'
import { HomePage } from './pages/HomePage'
import { CreatePage } from './pages/CreatePage'
import { TokenPage } from './pages/TokenPage'
import { SwapPage } from './pages/SwapPage'

export function App() {
  // One global statement of indexer health (Stage 2). Trading runs on RPC, so an outage is a
  // partial degradation — saying so once, at the top, beats each panel failing on its own.
  const indexer = useIndexerStatus()

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="brand">
            {/* Placeholder wordmark — the visual identity is the frontend-design pass. */}
            <span className="brand-mark">🐙</span>
            <span className="brand-name">Octopus</span>
          </Link>
          <nav className="nav">
            <Link to="/">Explore</Link>
            <Link to="/create" className="nav-cta">
              Launch a token
            </Link>
          </nav>
          <ConnectButton />
        </div>
      </header>

      <ConfigBanner />
      <IndexerBanner status={indexer} />

      <main className="main">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/create" element={<CreatePage />} />
          <Route path="/token/:address" element={<TokenPage />} />
          <Route path="/swap/:address" element={<SwapPage />} />
        </Routes>
      </main>

      <footer className="footer">
        <span>
          Octopus · fair-launch bonding curves · every graduation locks liquidity forever · v1 on
          Robinhood Chain
        </span>
        {/*
          Attribution, not branding. Octopus pools are our own deployment of unmodified Uniswap V3
          (GPL-2.0-or-later) — saying so is both a licence obligation and a trust signal: the AMM
          holding locked liquidity is audited code, not a homebrew curve. Deliberately worded to
          avoid implying any endorsement by Uniswap Labs.
        */}
        <span className="footer-attribution">
          Pools run on unmodified Uniswap V3 (GPL-2.0-or-later). Not affiliated with Uniswap Labs.
        </span>
      </footer>
    </div>
  )
}
