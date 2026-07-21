import { Link, useParams } from 'react-router-dom'
import { getAddress, isAddress, type Address } from 'viem'
import { activeChain } from '../config/chain'
import { useHolders, useToken, useTrades } from '../hooks/useSubgraph'
import { getTokenImage } from '../lib/tokenMeta'
import { explorerAddressUrl, formatEth, formatPriceX18, shortAddress } from '../lib/format'
import { Avatar } from '../components/TokenCard'
import { CurveChart } from '../components/CurveChart'
import { ProgressMeter } from '../components/ProgressMeter'
import { TradePanel } from '../components/TradePanel'
import { HoldersCard } from '../components/HoldersCard'

export function TokenPage() {
  const { address } = useParams<{ address: string }>()
  const valid = address && isAddress(address)

  const { data: token, isLoading } = useToken(valid ? address : undefined)
  const { data: trades } = useTrades(valid ? address : undefined)
  const { data: holders } = useHolders(valid ? address : undefined)

  if (!valid) return <p className="center-note">Invalid token address.</p>
  if (isLoading) return <div className="spinner">Loading token…</div>
  if (!token) return <p className="center-note">Token not found in the index yet.</p>

  const tokenAddr = getAddress(token.id) as Address
  const curveAddr = getAddress(token.curve) as Address
  const image = getTokenImage(token.id)
  const explorer = activeChain.blockExplorers?.default.url ?? ''

  return (
    <div>
      <Link to="/" className="back-link">
        ← All curves
      </Link>

      <div className="token-layout">
        <div className="col-stack">
          <div className="card">
            <div className="token-header">
              <Avatar image={image} symbol={token.symbol} />
              <div style={{ flex: 1 }}>
                <h1>{token.name}</h1>
                <div className="token-symbol">
                  {token.symbol} ·{' '}
                  <a
                    className="link-accent"
                    href={explorerAddressUrl(explorer, tokenAddr)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {shortAddress(token.id)}
                  </a>
                </div>
              </div>
              <span className={`badge ${token.graduated ? 'badge-grad' : 'badge-live'}`}>
                {token.graduated ? 'Graduated' : 'Live'}
              </span>
            </div>

            <div style={{ marginTop: 20 }}>
              <CurveChart trades={trades ?? []} />
            </div>

            {!token.graduated && (
              <div style={{ marginTop: 16 }}>
                <ProgressMeter
                  progressBps={token.progressBps}
                  tokensSold={BigInt(token.tokensSold)}
                />
              </div>
            )}
          </div>

          <div className="card">
            <p className="section-title">Curve stats</p>
            <div className="kv-grid">
              <Kv label="Price" value={`${formatPriceX18(BigInt(token.priceX18))} ETH`} />
              <Kv label="Volume" value={`${formatEth(BigInt(token.volumeEth))} ETH`} />
              <Kv label="ETH reserve" value={`${formatEth(BigInt(token.ethReserve))} ETH`} />
              <Kv label="Trades" value={String(token.tradeCount)} />
              <Kv label="Holders" value={String(token.holderCount)} />
              <Kv label="Buys / Sells" value={`${token.buyCount} / ${token.sellCount}`} />
            </div>
          </div>

          <HoldersCard holders={holders ?? []} creator={token.creator} />
        </div>

        <div className="col-stack" style={{ position: 'sticky', top: 84 }}>
          <TradePanel
            token={tokenAddr}
            curve={curveAddr}
            symbol={token.symbol}
            graduated={token.graduated}
          />
          {token.graduated && token.graduation && (
            <div className="card">
              <p className="section-title">Graduated</p>
              <div className="kv-grid">
                <Kv label="Raised" value={`${formatEth(BigInt(token.graduation.raisedEth))} ETH`} />
                <Kv
                  label="Pool"
                  value={
                    <a
                      className="link-accent num"
                      href={explorerAddressUrl(explorer, getAddress(token.graduation.pool) as Address)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {shortAddress(token.graduation.pool)}
                    </a>
                  }
                />
              </div>
              <p className="hint" style={{ marginTop: 12 }}>
                Liquidity is permanently locked.
              </p>
              <Link
                to={`/swap/${token.id}`}
                className="btn btn-primary"
                style={{ display: 'block', textAlign: 'center', marginTop: 12 }}
              >
                Swap {token.symbol} / ETH →
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Kv({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="kv">
      <div className="kv-label">{label}</div>
      <div className="kv-value">{value}</div>
    </div>
  )
}
