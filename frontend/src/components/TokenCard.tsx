import { Link } from 'react-router-dom'
import type { TokenRow } from '../lib/subgraph'
import { getTokenImage } from '../lib/tokenMeta'
import { formatEth, formatPriceX18 } from '../lib/format'
import { ProgressMeter } from './ProgressMeter'

export function TokenCard({ token }: { token: TokenRow }) {
  const image = getTokenImage(token.id)
  return (
    <Link to={`/token/${token.id}`} className="token-card">
      <div className="token-head">
        <Avatar image={image} symbol={token.symbol} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="token-name">{token.name}</div>
          <div className="token-symbol">{token.symbol}</div>
        </div>
        <span className={`badge ${token.graduated ? 'badge-grad' : 'badge-live'}`}>
          {token.graduated ? 'Graduated' : 'Live'}
        </span>
      </div>

      {!token.graduated && (
        <ProgressMeter progressBps={token.progressBps} tokensSold={BigInt(token.tokensSold)} />
      )}

      <div className="row-between" style={{ fontSize: 13 }}>
        <span className="muted">Price</span>
        <span className="num">{formatPriceX18(BigInt(token.priceX18))} ETH</span>
      </div>
      <div className="row-between" style={{ fontSize: 13 }}>
        <span className="muted">Volume</span>
        <span className="num">{formatEth(BigInt(token.volumeEth))} ETH</span>
      </div>
    </Link>
  )
}

export function Avatar({ image, symbol }: { image?: string; symbol: string }) {
  if (image) {
    return <img className="token-avatar" src={image} alt={symbol} onError={hideBroken} />
  }
  return <div className="token-avatar">{symbol.slice(0, 3).toUpperCase()}</div>
}

function hideBroken(e: React.SyntheticEvent<HTMLImageElement>) {
  e.currentTarget.style.display = 'none'
}
