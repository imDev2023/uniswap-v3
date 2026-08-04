import { useAccount } from 'wagmi'
import type { HolderRow } from '../lib/subgraph'
import { CURVE_SUPPLY } from '../config/constants'
import { shareOfCurveSupply } from '../lib/curve'
import { formatPercent, formatTokenAmount, shortAddress } from '../lib/format'

// Holder transparency (spec stories 26/27). The creator's position is called out explicitly and
// pinned first so buyers can judge concentration before buying; the connected wallet is tagged too.
export function HoldersCard({
  holders,
  creator,
  curveAllocation = CURVE_SUPPLY,
}: {
  holders: HolderRow[]
  /** Undefined when the creator isn't known - the indexer supplies it, and it may be unavailable. */
  creator: string | undefined
  /**
   * ⚠️ This launch's own curve allocation. Since #34 a dev allocation carves it below the 800M
   * constant, and concentration is read by someone deciding whether to buy - a denominator that is
   * too large understates exactly the number they are checking. Defaults to the no-dev-allocation
   * case, which is correct for every launch created without one.
   */
  curveAllocation?: bigint
}) {
  const { address } = useAccount()
  const you = address?.toLowerCase()
  const creatorLc = creator?.toLowerCase()

  const creatorHolder = holders.find((h) => h.account.toLowerCase() === creatorLc)
  const creatorShare = creatorHolder ? shareOfCurveSupply(BigInt(creatorHolder.balance), curveAllocation) : 0

  return (
    <div className="card">
      <p className="section-title">Holders</p>

      <div
        className="row-between"
        style={{
          background: 'rgba(55,214,155,0.06)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: '12px 14px',
          marginBottom: 16,
        }}
      >
        <div>
          <div className="kv-label">Creator holdings</div>
          <div className="num" style={{ marginTop: 2 }} title={creator}>
            {creator ? shortAddress(creator) : 'unknown'}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="num" style={{ fontSize: 18 }}>
            {creatorHolder ? formatTokenAmount(BigInt(creatorHolder.balance)) : '0'}
          </div>
          <div className="kv-label">{formatPercent(creatorShare)} of curve supply</div>
        </div>
      </div>

      {holders.length === 0 ? (
        <p className="muted">No holders yet.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Holder</th>
              <th style={{ textAlign: 'right' }}>Balance</th>
              <th style={{ textAlign: 'right' }}>Share</th>
            </tr>
          </thead>
          <tbody>
            {holders.map((h, i) => {
              const isCreator = h.account.toLowerCase() === creatorLc
              const isYou = h.account.toLowerCase() === you
              return (
                <tr key={h.id} className={isCreator ? 'creator-row' : undefined}>
                  <td className="muted">{i + 1}</td>
                  <td title={h.account}>
                    {shortAddress(h.account)}
                    {isCreator && <span className="you-tag">dev</span>}
                    {isYou && <span className="you-tag">you</span>}
                  </td>
                  <td style={{ textAlign: 'right' }}>{formatTokenAmount(BigInt(h.balance))}</td>
                  <td style={{ textAlign: 'right' }}>
                    {formatPercent(shareOfCurveSupply(BigInt(h.balance), curveAllocation))}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
