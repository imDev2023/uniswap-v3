import { CURVE_SUPPLY } from '../config/constants'
import { progressFractionFromBps } from '../lib/curve'
import { formatPercent, formatTokenAmount } from '../lib/format'

// Curve progress toward graduation (spec story 11). Uses the subgraph's integer progressBps so it
// matches the indexed value exactly.
export function ProgressMeter({
  progressBps,
  tokensSold,
  curveAllocation = CURVE_SUPPLY,
}: {
  progressBps: number
  tokensSold: bigint
  /**
   * ⚠️ This launch's own curve allocation, not the 800M constant. The BAR was always right (the
   * subgraph divides by the per-launch allocation), but the "sold / total" label read off a
   * constant, so a launch with a dev allocation would have shown 760M/800M at a sold-out curve.
   * Defaults to the no-dev-allocation case, which is correct for every launch created without one.
   */
  curveAllocation?: bigint
}) {
  const fraction = progressFractionFromBps(progressBps)
  return (
    <div className="progress">
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${fraction * 100}%` }} />
      </div>
      <div className="progress-meta">
        <span>{formatPercent(fraction)} to graduation</span>
        <span className="num">
          {formatTokenAmount(tokensSold)} / {formatTokenAmount(curveAllocation)}
        </span>
      </div>
    </div>
  )
}
