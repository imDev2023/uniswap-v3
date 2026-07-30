import { useMemo } from 'react'
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { TradeRow } from '../lib/subgraph'
import { formatPriceCompactText, priceEthPerToken } from '../lib/format'

// Chart colours are read from the design tokens rather than hardcoded, so a palette change cannot
// leave the chart on the previous accent. Resolved once at module load: recharts wants concrete
// colour strings, not var() references, for the SVG gradient stops.
const css = (name: string, fallback: string) =>
  (typeof getComputedStyle !== 'undefined' &&
    getComputedStyle(document.documentElement).getPropertyValue(name).trim()) ||
  fallback
const ACCENT = css('--accent', '#29e59a')
const AXIS_TEXT = css('--text-faint', '#5b6878')
const PANEL_BG = css('--bg-raised-2', '#151b25')
const PANEL_BORDER = css('--border-strong', '#2b3849')

// Live price chart from indexed trades (spec story 27): marginal curve price after each trade.
// Purely a subgraph read — the price series is deterministic from the Bought/Sold events.
export function CurveChart({ trades }: { trades: TradeRow[] }) {
  const data = useMemo(
    () =>
      trades.map((t, i) => ({
        i,
        price: priceEthPerToken(BigInt(t.priceX18)),
        time: Number(t.timestamp),
      })),
    [trades],
  )

  if (data.length === 0) {
    return <div className="center-note">No trades yet — be the first to buy this curve.</div>
  }

  /** recharts hands back a float; round back to the integer priceX18 the formatters expect. */
  function toPriceX18(v: number): bigint {
    return BigInt(Math.max(0, Math.round(v * 1e18)))
  }

  return (
    <div className="chart-wrap">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={ACCENT} stopOpacity={0.35} />
              <stop offset="100%" stopColor={ACCENT} stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="i" hide />
          <YAxis
            width={82}
            tick={{ fill: AXIS_TEXT, fontSize: 11 }}
            // Was `v.toExponential(1)`, so the axis read "6.0e-10" at every tick. Unicode subscripts
            // give the same compact form the rest of the UI uses, in a plain string.
            tickFormatter={(v: number) => formatPriceCompactText(toPriceX18(v))}
            domain={['auto', 'auto']}
          />
          <Tooltip
            contentStyle={{
              background: PANEL_BG,
              border: `1px solid ${PANEL_BORDER}`,
              borderRadius: 8,
              fontSize: 12,
            }}
            labelFormatter={() => ''}
            formatter={(v: number) => [`${formatPriceCompactText(toPriceX18(v))} ETH`, 'Price']}
          />
          <Area
            type="monotone"
            dataKey="price"
            stroke={ACCENT}
            strokeWidth={2}
            fill="url(#priceFill)"
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
