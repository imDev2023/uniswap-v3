import { Link, useParams } from 'react-router-dom'
import { activeChain } from '../config/chain'
import { useOnchainToken } from '../hooks/useOnchainToken'
import { useToken } from '../hooks/useSubgraph'
import { parseTokenParam } from '../lib/address'
import { isTradeable } from '../lib/onchainToken'
import { getTokenImage } from '../lib/tokenMeta'
import { explorerAddressUrl, formatEth, shortAddress } from '../lib/format'
import { Avatar } from '../components/TokenCard'
import { OnchainTokenGate } from '../components/OnchainTokenGate'
import { SwapPanel } from '../components/SwapPanel'

// Stage 2: this page moves money, so every address it uses comes from RPC.
//
// It previously read the pool address out of the subgraph, which meant an indexer outage took
// trading down rather than just charts. Now the pool comes from
// `launchpad.v3Factory().getPool(token, WETH, 10000)` and graduation from `curve.graduated()` — see
// hooks/useOnchainToken. The subgraph is consulted only for the "ETH seeded" garnish, which simply
// disappears when the indexer is unavailable.
export function SwapPage() {
  const { address } = useParams<{ address: string }>()
  const tokenAddr = parseTokenParam(address) ?? undefined

  const onchain = useOnchainToken(tokenAddr)
  // Garnish only. Never gates rendering, and its failure is ignored rather than surfaced —
  // the banner in App already explains an indexer outage once, globally.
  const { data: indexed } = useToken(tokenAddr)

  if (!tokenAddr) return <p className="center-note">Invalid token address.</p>
  if (!isTradeable(onchain)) return <OnchainTokenGate token={onchain} />

  if (onchain.status === 'on-curve') {
    return (
      <div style={{ maxWidth: 460, margin: '0 auto' }}>
        <Link to={`/token/${tokenAddr}`} className="back-link">
          ← Back to the curve
        </Link>
        <p className="center-note">
          {onchain.name} hasn’t graduated yet — it still trades on its bonding curve. Swapping opens
          once it graduates into a locked V3 pool.
        </p>
      </div>
    )
  }

  const explorer = activeChain.blockExplorers?.default.url ?? ''

  if (onchain.status === 'graduated-pool-missing') {
    return (
      <div style={{ maxWidth: 460, margin: '0 auto' }}>
        <Link to={`/token/${tokenAddr}`} className="back-link">
          ← Back to {onchain.symbol}
        </Link>
        <p className="center-note">
          {onchain.name} has graduated, but no {onchain.symbol}/WETH pool was found at the graduated
          fee tier. Nothing is safe to trade here until that resolves — check the token on the{' '}
          <a
            className="link-accent"
            href={explorerAddressUrl(explorer, tokenAddr)}
            target="_blank"
            rel="noreferrer"
          >
            explorer
          </a>
          .
        </p>
      </div>
    )
  }

  const { pool, symbol } = onchain
  const raised = indexed?.graduation?.raisedEth

  return (
    <div style={{ maxWidth: 460, margin: '0 auto' }}>
      <Link to={`/token/${tokenAddr}`} className="back-link">
        ← Back to {symbol}
      </Link>

      <div className="token-header" style={{ marginBottom: 20 }}>
        <Avatar image={getTokenImage(tokenAddr)} symbol={symbol} />
        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 22, margin: 0 }}>Swap {symbol} / ETH</h1>
          <div className="token-symbol">
            Pool{' '}
            <a
              className="link-accent"
              href={explorerAddressUrl(explorer, pool)}
              target="_blank"
              rel="noreferrer"
            >
              {shortAddress(pool)}
            </a>{' '}
            · liquidity locked
            {raised ? ` · ${formatEth(BigInt(raised))} ETH seeded` : ''}
          </div>
        </div>
      </div>

      <SwapPanel token={tokenAddr} symbol={symbol} pool={pool} />
    </div>
  )
}
