import { CURVE_SUPPLY } from '../config/constants'
import { progressFractionFromBps } from '../lib/curve'
import { formatPercent, formatTokenAmount } from '../lib/format'

// Curve progress toward graduation (spec story 11). Uses the subgraph's integer progressBps so it
// matches the indexed value exactly.
export function ProgressMeter({ progressBps, tokensSold }: { progressBps: number; tokensSold: bigint }) {
  const fraction = progressFractionFromBps(progressBps)
  return (
    <div className="progress">
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${fraction * 100}%` }} />
      </div>
      <div className="progress-meta">
        <span>{formatPercent(fraction)} to graduation</span>
        <span className="num">
          {formatTokenAmount(tokensSold)} / {formatTokenAmount(CURVE_SUPPLY)}
        </span>
      </div>
    </div>
  )
}
