import { Link, useParams } from 'react-router-dom'
import { activeChain } from '../config/chain'
import { useIndexerStatus } from '../hooks/useIndexerStatus'
import { useOnchainToken } from '../hooks/useOnchainToken'
import { useHolders, useToken, useTrades } from '../hooks/useSubgraph'
import { parseTokenParam } from '../lib/address'
import { isTradeable } from '../lib/onchainToken'
import { isDegraded } from '../lib/indexerHealth'
import { getTokenImage } from '../lib/tokenMeta'
import { explorerAddressUrl, formatEth, formatPriceX18, shortAddress } from '../lib/format'
import { Avatar } from '../components/TokenCard'
import { CurveChart } from '../components/CurveChart'
import { IndexedDataNotice } from '../components/IndexedDataNotice'
import { OnchainTokenGate } from '../components/OnchainTokenGate'
import { ProgressMeter } from '../components/ProgressMeter'
import { TradePanel } from '../components/TradePanel'
import { HoldersCard } from '../components/HoldersCard'

// Stage 2 split: the trade path (curve address, graduation state, symbol) comes from RPC, so the
// buy/sell panel keeps working through an indexer outage. The analytics panels (chart, curve stats,
// holders) are indexer-derived and degrade individually to a labelled "unavailable" note.
export function TokenPage() {
  const { address } = useParams<{ address: string }>()
  const tokenAddr = parseTokenParam(address) ?? undefined

  const onchain = useOnchainToken(tokenAddr)
  const indexer = useIndexerStatus()

  const { data: token } = useToken(tokenAddr)
  const { data: trades } = useTrades(tokenAddr)
  const { data: holders } = useHolders(tokenAddr)

  if (!tokenAddr) return <p className="center-note">Invalid token address.</p>
  if (!isTradeable(onchain)) return <OnchainTokenGate token={onchain} />

  const { curve, name, symbol } = onchain
  const graduated = onchain.status !== 'on-curve'
  const image = getTokenImage(tokenAddr)
  const explorer = activeChain.blockExplorers?.default.url ?? ''
  // Only complain about missing indexed panels when the indexer is actually degraded. A token that
  // simply hasn't been indexed yet (launched seconds ago) is a normal, transient empty state.
  const indexedMissing = !token && isDegraded(indexer.state)

  return (
    <div>
      <Link to="/" className="back-link">
        ← All curves
      </Link>

      <div className="token-layout">
        <div className="col-stack">
          <div className="card">
            <div className="token-header">
              <Avatar image={image} symbol={symbol} />
              <div style={{ flex: 1 }}>
                <h1>{name}</h1>
                <div className="token-symbol">
                  {symbol} ·{' '}
                  <a
                    className="link-accent"
                    href={explorerAddressUrl(explorer, tokenAddr)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {shortAddress(tokenAddr)}
                  </a>
                </div>
              </div>
              <span className={`badge ${graduated ? 'badge-grad' : 'badge-live'}`}>
                {graduated ? 'Graduated' : 'Live'}
              </span>
            </div>

            <div style={{ marginTop: 20 }}>
              {indexedMissing ? (
                <IndexedDataNotice state={indexer.state} what="Price history" />
              ) : (
                <CurveChart trades={trades ?? []} />
              )}
            </div>

            {!graduated && token && (
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
            {token ? (
              <div className="kv-grid">
                <Kv label="Price" value={`${formatPriceX18(BigInt(token.priceX18))} ETH`} />
                <Kv label="Volume" value={`${formatEth(BigInt(token.volumeEth))} ETH`} />
                <Kv label="ETH reserve" value={`${formatEth(BigInt(token.ethReserve))} ETH`} />
                <Kv label="Trades" value={String(token.tradeCount)} />
                <Kv label="Holders" value={String(token.holderCount)} />
                <Kv label="Buys / Sells" value={`${token.buyCount} / ${token.sellCount}`} />
              </div>
            ) : indexedMissing ? (
              <IndexedDataNotice state={indexer.state} what="Curve stats" />
            ) : (
              <p className="center-note">Not indexed yet.</p>
            )}
          </div>

          {indexedMissing ? (
            <div className="card">
              <p className="section-title">Holders</p>
              <IndexedDataNotice state={indexer.state} what="Holder table" />
            </div>
          ) : (
            <HoldersCard holders={holders ?? []} creator={token?.creator} />
          )}
        </div>

        <div className="col-stack" style={{ position: 'sticky', top: 84 }}>
          {/* Curve address and graduation state are RPC-resolved, so this panel is unaffected by
              indexer health — it quotes, caps and trades entirely on-chain. */}
          <TradePanel token={tokenAddr} curve={curve} symbol={symbol} graduated={graduated} />

          {graduated && (
            <div className="card">
              <p className="section-title">Graduated</p>
              <div className="kv-grid">
                {token?.graduation && (
                  <Kv
                    label="Raised"
                    value={`${formatEth(BigInt(token.graduation.raisedEth))} ETH`}
                  />
                )}
                {onchain.status === 'graduated' && (
                  <Kv
                    label="Pool"
                    value={
                      <a
                        className="link-accent num"
                        href={explorerAddressUrl(explorer, onchain.pool)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {shortAddress(onchain.pool)}
                      </a>
                    }
                  />
                )}
              </div>
              <p className="hint" style={{ marginTop: 12 }}>
                Liquidity is permanently locked.
              </p>
              {onchain.status === 'graduated' && (
                <Link
                  to={`/swap/${tokenAddr}`}
                  className="btn btn-primary"
                  style={{ display: 'block', textAlign: 'center', marginTop: 12 }}
                >
                  Swap {symbol} / ETH →
                </Link>
              )}
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
