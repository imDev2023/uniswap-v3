import { useAccount } from 'wagmi'
import type { HolderRow } from '../lib/subgraph'
import { shareOfCurveSupply } from '../lib/curve'
import { formatPercent, formatTokenAmount, shortAddress } from '../lib/format'

// Holder transparency (spec stories 26/27). The creator's position is called out explicitly and
// pinned first so buyers can judge concentration before buying; the connected wallet is tagged too.
export function HoldersCard({
  holders,
  creator,
}: {
  holders: HolderRow[]
  creator: string
}) {
  const { address } = useAccount()
  const you = address?.toLowerCase()
  const creatorLc = creator.toLowerCase()

  const creatorHolder = holders.find((h) => h.account.toLowerCase() === creatorLc)
  const creatorShare = creatorHolder ? shareOfCurveSupply(BigInt(creatorHolder.balance)) : 0

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
            {shortAddress(creator)}
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
                    {formatPercent(shareOfCurveSupply(BigInt(h.balance)))}
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
