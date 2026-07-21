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
import { formatPriceX18, priceEthPerToken } from '../lib/format'

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

  return (
    <div className="chart-wrap">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#37d69b" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#37d69b" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="i" hide />
          <YAxis
            width={64}
            tick={{ fill: '#5a6675', fontSize: 11 }}
            tickFormatter={(v: number) => v.toExponential(1)}
            domain={['auto', 'auto']}
          />
          <Tooltip
            contentStyle={{
              background: '#121821',
              border: '1px solid #2c3b4d',
              borderRadius: 8,
              fontSize: 12,
            }}
            labelFormatter={() => ''}
            formatter={(v: number) => [`${formatPriceX18(BigInt(Math.round(v * 1e18)))} ETH`, 'Price']}
          />
          <Area
            type="monotone"
            dataKey="price"
            stroke="#37d69b"
            strokeWidth={2}
            fill="url(#priceFill)"
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
