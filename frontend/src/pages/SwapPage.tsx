import { Link, useParams } from 'react-router-dom'
import { getAddress, isAddress, type Address } from 'viem'
import { activeChain } from '../config/chain'
import { useToken } from '../hooks/useSubgraph'
import { getTokenImage } from '../lib/tokenMeta'
import { explorerAddressUrl, formatEth, shortAddress } from '../lib/format'
import { Avatar } from '../components/TokenCard'
import { SwapPanel } from '../components/SwapPanel'

export function SwapPage() {
  const { address } = useParams<{ address: string }>()
  const valid = address && isAddress(address)
  const { data: token, isLoading } = useToken(valid ? address : undefined)

  if (!valid) return <p className="center-note">Invalid token address.</p>
  if (isLoading) return <div className="spinner">Loading pool…</div>
  if (!token) return <p className="center-note">Token not found in the index yet.</p>

  if (!token.graduated || !token.graduation) {
    return (
      <div style={{ maxWidth: 460, margin: '0 auto' }}>
        <Link to={`/token/${token.id}`} className="back-link">
          ← Back to the curve
        </Link>
        <p className="center-note">
          {token.name} hasn’t graduated yet — it still trades on its bonding curve. Swapping opens
          once it graduates into a locked V3 pool.
        </p>
      </div>
    )
  }

  const tokenAddr = getAddress(token.id) as Address
  const poolAddr = getAddress(token.graduation.pool) as Address
  const explorer = activeChain.blockExplorers?.default.url ?? ''

  return (
    <div style={{ maxWidth: 460, margin: '0 auto' }}>
      <Link to={`/token/${token.id}`} className="back-link">
        ← Back to {token.symbol}
      </Link>

      <div className="token-header" style={{ marginBottom: 20 }}>
        <Avatar image={getTokenImage(token.id)} symbol={token.symbol} />
        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 22, margin: 0 }}>Swap {token.symbol} / ETH</h1>
          <div className="token-symbol">
            Pool{' '}
            <a
              className="link-accent"
              href={explorerAddressUrl(explorer, poolAddr)}
              target="_blank"
              rel="noreferrer"
            >
              {shortAddress(poolAddr)}
            </a>{' '}
            · liquidity locked · {formatEth(BigInt(token.graduation.raisedEth))} ETH seeded
          </div>
        </div>
      </div>

      <SwapPanel token={tokenAddr} symbol={token.symbol} pool={poolAddr} />
    </div>
  )
}
