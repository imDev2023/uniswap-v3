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

// recharts needs concrete colour strings for SVG gradient stops and tick fills, not var()
// references, so the design tokens have to be resolved to values here.
//
// The literals below are NOT a second copy of the palette to keep in sync: they are only reached in
// a non-browser environment (unit tests under jsdom before styles are attached), where any colour is
// as good as another because nothing is rendered to a screen. In a real browser the computed token
// always wins, so a palette change cannot leave the chart on a stale accent.
const cssToken = (name: string, whenHeadless: string) => {
  if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined') return whenHeadless
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || whenHeadless
}

/** recharts hands back a float; round back to the integer priceX18 the formatters expect. */
function toPriceX18(v: number): bigint {
  return BigInt(Math.max(0, Math.round(v * 1e18)))
}

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

  // Resolved on render rather than at module load: at import time the stylesheet may not be
  // attached yet, which would silently bake the headless fallbacks into a real browser session.
  const theme = useMemo(
    () => ({
      accent: cssToken('--accent', '#29e59a'),
      axisText: cssToken('--text-faint', '#5b6878'),
      panelBg: cssToken('--bg-raised-2', '#151b25'),
      panelBorder: cssToken('--border-strong', '#2b3849'),
    }),
    [],
  )

  if (data.length === 0) {
    return <div className="center-note">No trades yet — be the first to buy this curve.</div>
  }

  return (
    <div className="chart-wrap">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={theme.accent} stopOpacity={0.35} />
              <stop offset="100%" stopColor={theme.accent} stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="i" hide />
          <YAxis
            width={82}
            tick={{ fill: theme.axisText, fontSize: 11 }}
            // Was `v.toExponential(1)`, so the axis read "6.0e-10" at every tick. Unicode subscripts
            // give the same compact form the rest of the UI uses, in a plain string.
            tickFormatter={(v: number) => formatPriceCompactText(toPriceX18(v))}
            domain={['auto', 'auto']}
          />
          <Tooltip
            contentStyle={{
              background: theme.panelBg,
              border: `1px solid ${theme.panelBorder}`,
              borderRadius: 8,
              fontSize: 12,
            }}
            labelFormatter={() => ''}
            formatter={(v: number) => [`${formatPriceCompactText(toPriceX18(v))} ETH`, 'Price']}
          />
          <Area
            type="monotone"
            dataKey="price"
            stroke={theme.accent}
            strokeWidth={2}
            fill="url(#priceFill)"
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
