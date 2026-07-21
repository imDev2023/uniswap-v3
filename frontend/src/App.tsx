import { Link, Route, Routes } from 'react-router-dom'
import { ConnectButton } from './components/ConnectButton'
import { ConfigBanner } from './components/ConfigBanner'
import { HomePage } from './pages/HomePage'
import { CreatePage } from './pages/CreatePage'
import { TokenPage } from './pages/TokenPage'

export function App() {
  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="brand">
            <span className="brand-mark">◭</span>
            <span className="brand-name">Launchpad</span>
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

      <main className="main">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/create" element={<CreatePage />} />
          <Route path="/token/:address" element={<TokenPage />} />
        </Routes>
      </main>

      <footer className="footer">
        <span>
          Fair-launch bonding curves · every graduation locks liquidity forever · v1 on Robinhood
          Chain
        </span>
      </footer>
    </div>
  )
}
