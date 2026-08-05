import { useAccount } from 'wagmi'
import type { CurvePositionRow } from '../lib/subgraph'
import { CURVE_SUPPLY } from '../config/constants'
import { shareOfCurveSupply } from '../lib/curve'
import { formatPercent, formatTokenAmount, shortAddress } from '../lib/format'

/**
 * Curve-position transparency (spec stories 26/27), renamed from `HoldersCard` in #37.
 *
 * ⚠️ **This panel is not a holder list, and saying so is its main job.** The model counts net tokens
 * bought from the CURVE, minus tokens sold back to it. It ignores ERC-20 transfers entirely, and it
 * freezes permanently at graduation while the real holders keep changing with every pool swap. #36
 * renamed the entity; this ticket owns the words a person actually reads.
 *
 * ⚠️ **The creator block exists to disclose concentration, and until #36 it was reading 0% for a
 * creator holding up to 40M tokens.** A dev allocation is a free carve, not a curve buy, so it emits
 * no `Bought` and never produced a row here. It is now shown as two separate numbers - granted and
 * released - because they diverge for the whole vesting window and either one alone is misleading:
 * granted-only overstates near-term sell pressure, released-only reads as nothing at all on a launch
 * whose supply is already spoken for.
 */
export function CurvePositionsCard({
  positions,
  creator,
  curveAllocation = CURVE_SUPPLY,
  devAllocation,
  devClaimed,
  graduated,
}: {
  positions: CurvePositionRow[]
  /** Undefined when the creator isn't known - the indexer supplies it, and it may be unavailable. */
  creator: string | undefined
  /**
   * ⚠️ This launch's own curve allocation. Since #34 a dev allocation carves it below the 800M
   * constant, and concentration is read by someone deciding whether to buy - a denominator that is
   * too large understates exactly the number they are checking. Defaults to the no-dev-allocation
   * case, which is correct for every launch created without one.
   *
   * Every percentage in this card shares this denominator, deliberately. Two denominators in one
   * table is how a reader ends up comparing figures that are not comparable.
   */
  curveAllocation?: bigint
  /**
   * Tokens carved for the creator at creation and held by `DevVesting`.
   *
   * ⚠️ Three states, and no default: `0n` means no carve was taken, `undefined` means the read
   * failed. Defaulting the second to the first prints "no dev allocation taken" - a confident
   * disclosure of nothing - on the panel whose entire job is disclosing concentration.
   */
  devAllocation: bigint | undefined
  /** What has actually reached the creator's wallet, out of that carve. */
  devClaimed: bigint | undefined
  /** Whether the curve has closed. Decides whether these positions are current or final. */
  graduated: boolean
}) {
  const { address } = useAccount()
  const you = address?.toLowerCase()
  const creatorLc = creator?.toLowerCase()

  const creatorPosition = positions.find((p) => p.account.toLowerCase() === creatorLc)
  const creatorBought = creatorPosition ? BigInt(creatorPosition.balance) : 0n
  const carveUnknown = devAllocation === undefined
  const hasCarve = devAllocation !== undefined && devAllocation > 0n

  return (
    <div className="card">
      <p className="section-title">Curve positions</p>

      {/* ⚠️ A graduated launch's positions are FINAL, not current, and this line is the only thing
          on the page that says so. Without it the panel presents a snapshot of who once bought on a
          closed curve as a statement about who holds the token today - which is wrong the moment
          the first pool swap settles, and gets more wrong every day after. */}
      <p className="muted" style={{ marginTop: 0, marginBottom: 16, fontSize: 13 }}>
        {graduated ? (
          <>
            <strong>Final.</strong> The curve closed at graduation, so these positions can never
            change again. Actual {' '}
            <span title="Curve positions ignore ERC-20 transfers and pool swaps entirely.">
              token holders
            </span>{' '}
            change with every pool swap and are not shown here.
          </>
        ) : (
          <>Net tokens bought from the curve, minus tokens sold back to it. Transfers between wallets are not counted.</>
        )}
      </p>

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
          <div className="kv-label">Creator</div>
          <div className="num" style={{ marginTop: 2 }} title={creator}>
            {creator ? shortAddress(creator) : 'unknown'}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          {hasCarve ? (
            <>
              <div className="num" style={{ fontSize: 18 }} title="Granted at creation and held by the vesting vault.">
                {formatTokenAmount(devAllocation)}
              </div>
              {/* ⚠️ "of the curve allocation", NOT "of curve supply", and the distinction is real
                  rather than pedantic. The creator selects the carve in basis points of the 800M
                  CURVE_SUPPLY constant, so a 5% choice is 40M tokens - but the carve comes OUT of
                  that supply, leaving this launch's own allocation at 760M, against which the same
                  40M is 5.3%. Both numbers are right for their own denominator; labelling this one
                  "of curve supply" made the token page contradict the number the create form had
                  just quoted. This card uses one denominator throughout, so its rows stay
                  comparable, and the label now names it. */}
              <div className="kv-label">
                dev allocation · {formatPercent(shareOfCurveSupply(devAllocation, curveAllocation))} of
                the curve allocation
              </div>
              {/* The second of the two numbers. Shown even at zero: "0 released" is a fact a buyer
                  wants during the vesting window, and hiding it would leave the granted figure
                  looking like tokens already in a wallet. */}
              <div className="kv-label" style={{ marginTop: 4 }}>
                {devClaimed === undefined ? '?' : formatTokenAmount(devClaimed)} released to the
                creator so far
              </div>
            </>
          ) : carveUnknown ? (
            /* ⚠️ Not the same as "none". A failed read printed as "no dev allocation taken" is a
               confident disclosure of nothing, on the panel that exists to disclose concentration. */
            <>
              <div className="num" style={{ fontSize: 18 }}>
                unknown
              </div>
              <div className="kv-label">creator allocation could not be read</div>
            </>
          ) : (
            <>
              <div className="num" style={{ fontSize: 18 }}>
                none
              </div>
              <div className="kv-label">no dev allocation taken</div>
            </>
          )}
          <div className="kv-label" style={{ marginTop: 4 }}>
            {formatTokenAmount(creatorBought)} bought on the curve
          </div>
        </div>
      </div>

      {positions.length === 0 ? (
        <p className="muted">
          {graduated ? 'No curve positions were recorded.' : 'No curve positions yet.'}
        </p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Account</th>
              <th style={{ textAlign: 'right' }}>Bought net</th>
              <th style={{ textAlign: 'right' }}>Share</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p, i) => {
              const isCreator = p.account.toLowerCase() === creatorLc
              const isYou = p.account.toLowerCase() === you
              return (
                <tr key={p.id} className={isCreator ? 'creator-row' : undefined}>
                  <td className="muted">{i + 1}</td>
                  <td title={p.account}>
                    {shortAddress(p.account)}
                    {isCreator && <span className="you-tag">dev</span>}
                    {isYou && <span className="you-tag">you</span>}
                  </td>
                  <td style={{ textAlign: 'right' }}>{formatTokenAmount(BigInt(p.balance))}</td>
                  <td style={{ textAlign: 'right' }}>
                    {formatPercent(shareOfCurveSupply(BigInt(p.balance), curveAllocation))}
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
