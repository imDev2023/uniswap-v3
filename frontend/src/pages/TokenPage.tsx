import { Link, useParams } from 'react-router-dom'
import { activeChain } from '../config/chain'
import { useIndexerStatus } from '../hooks/useIndexerStatus'
import { useNowSeconds } from '../hooks/useNowSeconds'
import { useOnchainToken } from '../hooks/useOnchainToken'
import { useCurvePositions, useToken, useTrades } from '../hooks/useSubgraph'
import { useLaunchTerms } from '../hooks/useLaunchTerms'
import { parseTokenParam } from '../lib/address'
import { isTradeable } from '../lib/onchainToken'
import { isDegraded } from '../lib/indexerHealth'
import { useOnchainMetadataUri, useTokenMetadata } from '../hooks/useTokenMetadata'
import { TokenIdentity } from '../components/TokenIdentity'
import { explorerAddressUrl, formatEth, shortAddress } from '../lib/format'
import { Avatar } from '../components/Avatar'
import { Price } from '../components/Price'
import { CurveChart } from '../components/CurveChart'
import { IndexedDataNotice } from '../components/IndexedDataNotice'
import { OnchainTokenGate } from '../components/OnchainTokenGate'
import { ProgressMeter } from '../components/ProgressMeter'
import { TradePanel } from '../components/TradePanel'
import { TokenTradeFeed } from '../components/TokenTradeFeed'
import { CurvePositionsCard } from '../components/CurvePositionsCard'
import { LockCard } from '../components/LockCard'
import { FeeEarningsCard } from '../components/FeeEarningsCard'
import { VestingCard } from '../components/VestingCard'

// Stage 2 split: the trade path (curve address, graduation state, symbol) comes from RPC, so the
// buy/sell panel keeps working through an indexer outage. The analytics panels (chart, curve stats,
// curve positions) are indexer-derived and degrade individually to a labelled "unavailable" note.
//
// The lock and vesting panels (#37) sit on the CHAIN side of that split, not the indexed side. Every
// term they show is frozen at `createLaunch` and readable per token, so they survive an outage like
// the trade panel does. Only the realised `Lock` record - the position's actual expiry, extension
// count and reclaim outcome - comes from the read model, and that half degrades on its own.
export function TokenPage() {
  const { address } = useParams<{ address: string }>()
  const tokenAddr = parseTokenParam(address) ?? undefined

  const onchain = useOnchainToken(tokenAddr)
  const indexer = useIndexerStatus()
  // Read over RPC, not from the subgraph, so a launch keeps its identity through an indexer outage
  // - the same reason the trade path was decoupled in Stage 2.
  const metadataUri = useOnchainMetadataUri(tokenAddr)
  const meta = useTokenMetadata(tokenAddr, metadataUri)

  const { data: token } = useToken(tokenAddr)
  const tradesQuery = useTrades(tokenAddr)
  const { data: curvePositions } = useCurvePositions(tokenAddr)
  // ⚠️ **The launch's frozen terms come from the CHAIN, not from the indexed row.** Both the lock
  // and vesting panels used to be gated on `token`, which meant an indexer outage silently removed
  // the panel a buyer reads to find out whether the liquidity is locked at all - and took the
  // creator's claim button with it. Found by loading the page with graph-node stopped, not by a
  // test. Every value is frozen at `createLaunch`, so the read model was only ever a second route
  // to the same immutable facts. See `useLaunchTerms`.
  const terms = useLaunchTerms(tokenAddr)
  const trades = tradesQuery.data
  const now = useNowSeconds()

  if (!tokenAddr) return <p className="center-note">Invalid token address.</p>
  if (!isTradeable(onchain)) return <OnchainTokenGate token={onchain} />

  const { curve, name, symbol } = onchain
  const graduated = onchain.status !== 'on-curve'
  const explorer = activeChain.blockExplorers?.default.url ?? ''
  // Only complain about missing indexed panels when the indexer is actually degraded. A token that
  // simply hasn't been indexed yet (launched seconds ago) is a normal, transient empty state.
  const indexedMissing = !token && isDegraded(indexer.state)

  // This launch's own curve allocation (#34). ⚠️ Guarded rather than `BigInt(token.x)` directly:
  // the row comes from the indexer, and an absent field would throw inside render and white-screen
  // the whole route instead of degrading. `undefined` does NOT mean 800M: `CurvePositionsCard`
  // rebuilds the figure from the chain-read carve, which is the same number by construction.
  const curveAllocation = token?.curveTokenAllocation ? BigInt(token.curveTokenAllocation) : undefined

  return (
    <div>
      <Link to="/" className="back-link">
        ← All curves
      </Link>

      <div className="token-layout">
        <div className="col-stack">
          <div className="card">
            <div className="token-header">
              <Avatar image={meta?.image} symbol={symbol} address={tokenAddr} />
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

            <TokenIdentity address={tokenAddr} meta={meta} />

            <div style={{ marginTop: 20 }}>
              {indexedMissing ? (
                <IndexedDataNotice state={indexer.state} what="Price history" />
              ) : (
                <CurveChart trades={trades ?? []} graduated={graduated} />
              )}
            </div>

            {!graduated && token && (
              <div style={{ marginTop: 16 }}>
                <ProgressMeter
                  progressBps={token.progressBps}
                  tokensSold={BigInt(token.tokensSold)}
                  curveAllocation={curveAllocation}
                />
              </div>
            )}
          </div>

          <div className="card">
            <p className="section-title">Curve stats</p>
            {token ? (
              <div className="kv-grid">
                <Kv label="Price" value={<Price priceX18={BigInt(token.priceX18)} />} />
                <Kv label="Volume" value={`${formatEth(BigInt(token.volumeEth))} ETH`} />
                <Kv label="ETH reserve" value={`${formatEth(BigInt(token.ethReserve))} ETH`} />
                <Kv label="Trades" value={String(token.tradeCount)} />
                <Kv label="Curve positions" value={String(token.curvePositionCount)} />
                <Kv label="Buys / Sells" value={`${token.buyCount} / ${token.sellCount}`} />
              </div>
            ) : indexedMissing ? (
              <IndexedDataNotice state={indexer.state} what="Curve stats" />
            ) : (
              <p className="center-note">Not indexed yet.</p>
            )}
          </div>

          {/* Terms from the chain, realised lock record from the indexer. Renders in both phases:
              the terms are frozen at creation, so "is this liquidity locked, and for how long" is
              worth answering BEFORE someone buys on the curve, not only after graduation. */}
          <LockCard
            lock={token?.lock ?? null}
            lockDuration={terms.lockDuration}
            permanentLockChoice={terms.permanentLock}
            creatorFeeBps={terms.creatorFeeBps}
            graduated={graduated}
            pool={onchain.status === 'graduated' ? onchain.pool : undefined}
            nowSeconds={now}
            symbol={symbol}
          />

          {/* What the creator has actually earned from the locked position (#39). Renders nothing
              before graduation, when no position exists yet. Deliberately reads BOTH sides: what has
              been collected comes from the indexer, what is waiting comes from the chain, and on a
              permissionless collector the second is routinely non-zero while the first is zero. */}
          <FeeEarningsCard
            lock={token?.lock ?? null}
            // ⚠️ From the CHAIN, not from `lock.id`. The accrued half of this card is a chain read
            // and must not be gated on the indexer - see the prop's own note.
            positionTokenId={terms.positionTokenId}
            token={tokenAddr}
            pool={onchain.status === 'graduated' ? onchain.pool : undefined}
            creatorFeeBps={terms.creatorFeeBps}
            graduated={graduated}
            symbol={symbol}
            nowSeconds={now}
          />

          {/* Renders nothing at all when the launch took no carve - see VestingCard. */}
          <VestingCard
            token={tokenAddr}
            terms={{
              // An unread allocation renders nothing, which is right: with no carve figure there is
              // no grant to describe. The concentration panel below is where the failed read is
              // reported, because that is the panel a reader consults for it.
              allocation: terms.devAllocation ?? 0n,
              // ⚠️ Passed through as `undefined`, NEVER defaulted to `0n`. A zero duration means the
              // grant has fully released, so the default would announce an untouched carve as 100%
              // vested and fully releasable. `VestingCard` has a state of its own for not-known.
              duration: terms.vestingDuration,
              // ⚠️ From `GraduationManager`, NOT from the indexed row, and tri-state all the way
              // through: `undefined` not known, `null` still on the curve, a `bigint` graduated.
              // This was the one value on the card still sourced from the read model, and an
              // indexer outage therefore rendered a launch that had graduated as one that never
              // would - taking the creator's claim button with it. That is the exact regression the
              // rest of this panel was moved onto the chain to prevent.
              graduatedAt: terms.graduatedAt,
              claimed: terms.devClaimed ?? 0n,
            }}
            creator={terms.creator}
            claimable={terms.claimable}
            symbol={symbol}
            nowSeconds={now}
          />

          {indexedMissing ? (
            <div className="card">
              <p className="section-title">Curve positions</p>
              <IndexedDataNotice state={indexer.state} what="Curve positions" />
            </div>
          ) : (
            <CurvePositionsCard
              positions={curvePositions ?? []}
              creator={token?.creator}
              curveAllocation={curveAllocation}
              devAllocation={terms.devAllocation}
              devClaimed={terms.devClaimed}
              graduated={graduated}
            />
          )}
        </div>

        <div className="col-stack rail-sticky">
          {/* One card, not two. A graduated token used to render a "Trade" card whose entire content
              was "curve trading is closed" directly above a "Graduated" card that said the same
              thing and then did something useful. The state has one meaning, so it gets one card. */}
          {graduated ? (
            <div className="card">
              <p className="section-title">Graduated</p>
              <p className="muted" style={{ marginTop: 0 }}>
                Curve trading is closed. {symbol} now trades in a locked V3 pool.
              </p>

              <div className="kv-grid" style={{ marginTop: 'var(--s-4)' }}>
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

              {onchain.status === 'graduated' && (
                <Link
                  to={`/swap/${tokenAddr}`}
                  className="btn btn-primary btn-block"
                  style={{ marginTop: 'var(--s-4)' }}
                >
                  Swap {symbol} / ETH →
                </Link>
              )}
            </div>
          ) : (
            /* Curve address and graduation state are RPC-resolved, so this panel is unaffected by
               indexer health - it quotes, caps and trades entirely on-chain. */
            <TradePanel token={tokenAddr} curve={curve} symbol={symbol} />
          )}

          <TokenTradeFeed
            trades={trades}
            symbol={symbol}
            now={now}
            explorer={explorer}
            indexerState={indexer.state}
            isError={tradesQuery.isError}
            isLoading={tradesQuery.isLoading}
            graduated={graduated}
          />
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
