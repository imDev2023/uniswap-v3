import { describe, expect, it } from 'vitest'
import {
  MAX_MARKERS,
  buildPriceSeries,
  priceMinMove,
  seriesSpanSeconds,
  type PricePoint,
} from './priceSeries'
import type { TradeRow } from './subgraph'

/** priceX18 for a given ETH-per-token price, so the fixtures read in the units the UI shows. */
function px(ethPerToken: number): string {
  return BigInt(Math.round(ethPerToken * 1e18)).toString()
}

function trade(over: Partial<TradeRow> & { timestamp: string; priceX18: string }): TradeRow {
  return {
    id: `${over.timestamp}-${over.priceX18}`,
    trader: '0xaaaa',
    type: 'BUY',
    amountEth: '0',
    amountToken: '0',
    tokensSold: '0',
    txHash: '0xdead',
    ...over,
  }
}

/** Value carried at time `t`, read off the grid the way the chart draws it. */
function valueAt(points: PricePoint[], t: number): number | undefined {
  let v: number | undefined
  for (const p of points) {
    if (p.time <= t) v = p.value
    else break
  }
  return v
}

/**
 * The real seeded RDOGE shape, and the reason this module exists: three buys inside six seconds,
 * a 49-minute gap, then one late buy.
 */
const RDOGE: TradeRow[] = [
  trade({ timestamp: '1000', priceX18: px(0.54e-8), type: 'BUY' }),
  trade({ timestamp: '1003', priceX18: px(1.15e-8), type: 'BUY' }),
  trade({ timestamp: '1006', priceX18: px(3.98e-8), type: 'BUY' }),
  trade({ timestamp: '3946', priceX18: px(4.32e-8), type: 'BUY' }),
]

describe('buildPriceSeries', () => {
  it('returns nothing for a curve that has never traded', () => {
    const s = buildPriceSeries([], { nowSeconds: 5000, extendToNow: true })
    expect(s.points).toEqual([])
    expect(s.markers).toEqual([])
    expect(s.hasTail).toBe(false)
  })

  describe('time-proportional spacing', () => {
    // This is THE regression guard. lightweight-charts' time scale is ordinal - one equal-width slot
    // per point - so a raw event series renders four trades evenly spaced however far apart they
    // happened, exactly like the trade-index axis it replaced. Only a fixed grid makes screen
    // distance mean elapsed time.
    it('puts a point on every grid step, so gap width tracks elapsed time', () => {
      const { points, bucketSeconds } = buildPriceSeries(RDOGE, {
        nowSeconds: 3946,
        extendToNow: false,
      })

      const steps = points.slice(1).map((p, i) => p.time - points[i].time)
      // Every step is one bucket, except the last: the series snaps its final point exactly onto
      // `to` so the line reaches the right edge, which leaves one short bucket behind.
      expect(new Set(steps.slice(0, -1))).toEqual(new Set([bucketSeconds]))
      expect(steps[steps.length - 1]).toBeLessThanOrEqual(bucketSeconds)

      // The 49-minute silence must occupy ~980x the width of a 3-second gap, not the same width.
      const burstPoints = points.filter((p) => p.time <= 1006).length
      const gapPoints = points.filter((p) => p.time > 1006 && p.time <= 3946).length
      expect(gapPoints / burstPoints).toBeGreaterThan(100)
    })

    it('scales resolution to the span instead of building an unbounded array', () => {
      const long = [
        trade({ timestamp: '0', priceX18: px(1e-9) }),
        trade({ timestamp: String(60 * 60 * 24 * 30), priceX18: px(2e-9) }),
      ]
      const s = buildPriceSeries(long, { nowSeconds: 60 * 60 * 24 * 30, extendToNow: false })
      expect(s.points.length).toBeLessThanOrEqual(801)
      expect(s.bucketSeconds).toBeGreaterThan(1)
    })

    it('honours an explicit maxPoints', () => {
      const s = buildPriceSeries(RDOGE, { nowSeconds: 3946, extendToNow: false, maxPoints: 50 })
      expect(s.points.length).toBeLessThanOrEqual(51)
    })
  })

  describe('carry-forward values', () => {
    it('holds the last traded price across a gap rather than interpolating toward the next', () => {
      const { points } = buildPriceSeries(RDOGE, { nowSeconds: 3946, extendToNow: false })

      // Anywhere inside the 49-minute silence the price is still what the last trade left it at.
      expect(valueAt(points, 1500)).toBeCloseTo(3.98e-8, 12)
      expect(valueAt(points, 3000)).toBeCloseTo(3.98e-8, 12)
      expect(valueAt(points, 3900)).toBeCloseTo(3.98e-8, 12)

      // An interpolating chart would have drifted between 3.98e-8 and 4.32e-8 across that span.
      const mid = valueAt(points, 2473)!
      expect(mid).not.toBeCloseTo((3.98e-8 + 4.32e-8) / 2, 12)
    })

    it('ends on the final traded price', () => {
      const { points } = buildPriceSeries(RDOGE, { nowSeconds: 3946, extendToNow: false })
      expect(points[points.length - 1].value).toBeCloseTo(4.32e-8, 12)
      expect(points[points.length - 1].time).toBe(3946)
    })
  })

  describe('the tail', () => {
    it('carries a live curve flat to now rather than ending at the last trade', () => {
      const s = buildPriceSeries(RDOGE, { nowSeconds: 12_000, extendToNow: true })
      expect(s.hasTail).toBe(true)

      const last = s.points[s.points.length - 1]
      expect(last.time).toBe(12_000)
      expect(last.value).toBeCloseTo(4.32e-8, 12)
    })

    it('does NOT extend a graduated curve - its price is frozen, and the pool has moved on', () => {
      const s = buildPriceSeries(RDOGE, { nowSeconds: 12_000, extendToNow: false })
      expect(s.hasTail).toBe(false)
      expect(s.points[s.points.length - 1].time).toBe(3946)
    })

    it('never marks the tail as a trade', () => {
      const s = buildPriceSeries(RDOGE, { nowSeconds: 12_000, extendToNow: true })
      expect(s.markers.every((m) => m.time <= 3946)).toBe(true)
    })

    it('does not extend when the chain clock runs ahead of the browser', () => {
      // Block timestamps carry ~1s of slack and users' clocks are not synchronised, so `now` can
      // legitimately land before the last trade. A backwards point would break the axis outright.
      const s = buildPriceSeries(RDOGE, { nowSeconds: 3940, extendToNow: true })
      expect(s.hasTail).toBe(false)
      expect(s.points[s.points.length - 1].time).toBe(3946)
    })
  })

  describe('same-second trades', () => {
    // 0.3s blocks on testnet, 0.1s on mainnet - several trades per second is routine, and
    // lightweight-charts requires strictly ascending unique times.
    const sameSecond: TradeRow[] = [
      trade({ timestamp: '500', priceX18: px(1e-8), type: 'BUY' }),
      trade({ timestamp: '500', priceX18: px(2e-8), type: 'BUY' }),
      trade({ timestamp: '500', priceX18: px(3e-8), type: 'SELL' }),
    ]

    it('collapses to one point holding the price after the LAST trade', () => {
      const { points } = buildPriceSeries(sameSecond, { nowSeconds: 500, extendToNow: false })
      expect(points).toHaveLength(1)
      expect(points[0].value).toBeCloseTo(3e-8, 12)
    })

    it('records how many trades were collapsed, and the side that set the price', () => {
      const { markers } = buildPriceSeries(sameSecond, { nowSeconds: 500, extendToNow: false })
      expect(markers).toEqual([{ time: 500, side: 'SELL', count: 3 }])
    })
  })

  it('emits strictly ascending unique times even from unsorted input', () => {
    const shuffled = [RDOGE[2], RDOGE[0], RDOGE[3], RDOGE[1]]
    const { points } = buildPriceSeries(shuffled, { nowSeconds: 9000, extendToNow: true })

    const times = points.map((p) => p.time)
    expect(times).toEqual([...times].sort((a, b) => a - b))
    expect(new Set(times).size).toBe(times.length)
  })

  it('lands every marker on a time that exists in the series', () => {
    // Markers on times the series does not contain are silently dropped by the chart, so a marker
    // that misses its grid point disappears with no error anywhere.
    const s = buildPriceSeries(RDOGE, { nowSeconds: 12_000, extendToNow: true })
    const times = new Set(s.points.map((p) => p.time))
    expect(s.markers.length).toBeGreaterThan(0)
    for (const m of s.markers) expect(times.has(m.time)).toBe(true)
  })

  it('merges trades sharing a bucket and keeps the total count', () => {
    // At a coarse grid the six-second burst is one instant, and the marker must say "3".
    const s = buildPriceSeries(RDOGE, { nowSeconds: 3946, extendToNow: false, maxPoints: 20 })
    expect(s.bucketSeconds).toBeGreaterThan(6)
    expect(s.markers.reduce((n, m) => n + m.count, 0)).toBe(4)
  })

  it('drops trades with an unparseable timestamp instead of poisoning the axis with NaN', () => {
    const s = buildPriceSeries(
      [...RDOGE, trade({ timestamp: 'not-a-number', priceX18: px(9e-8) })],
      { nowSeconds: 3946, extendToNow: false },
    )
    expect(s.points.every((p) => Number.isFinite(p.time))).toBe(true)
    expect(s.points[s.points.length - 1].time).toBe(3946)
  })

  it('drops markers once they would outnumber the line they annotate', () => {
    const many = Array.from({ length: MAX_MARKERS + 1 }, (_, i) =>
      trade({ timestamp: String(1000 + i * 60), priceX18: px(1e-8) }),
    )
    expect(buildPriceSeries(many, { nowSeconds: 99_999, extendToNow: false }).markers).toEqual([])

    const justEnough = many.slice(0, MAX_MARKERS)
    expect(
      buildPriceSeries(justEnough, { nowSeconds: 99_999, extendToNow: false }).markers,
    ).toHaveLength(MAX_MARKERS)
  })

  it('gives a single trade a second point to draw, so it is not an invisible zero-width line', () => {
    const one = [trade({ timestamp: '800', priceX18: px(5e-9) })]
    const live = buildPriceSeries(one, { nowSeconds: 2000, extendToNow: true })
    expect(live.points.length).toBeGreaterThan(1)
    expect(live.markers).toHaveLength(1)
  })
})

describe('seriesSpanSeconds', () => {
  it('is zero for a series that cannot span anything', () => {
    expect(seriesSpanSeconds([])).toBe(0)
    expect(seriesSpanSeconds([{ time: 10, value: 1 }])).toBe(0)
  })

  it('measures first to last', () => {
    expect(
      seriesSpanSeconds([
        { time: 1000, value: 1 },
        { time: 1006, value: 2 },
        { time: 3946, value: 3 },
      ]),
    ).toBe(2946)
  })
})

describe('priceMinMove', () => {
  it('scales to the data instead of the default 0.01, which would collapse every tick', () => {
    expect(priceMinMove([{ time: 0, value: 4.33e-10 }])).toBeCloseTo(1e-14, 20)
    expect(priceMinMove([{ time: 0, value: 2.5 }])).toBeCloseTo(1e-4, 8)
  })

  it('never returns something finer than a price can actually be', () => {
    // priceX18 is an integer, so 1e-18 is the true quantum. Anything smaller invites the tick
    // generator to enumerate steps forever - which silently stops the chart painting at all.
    expect(priceMinMove([])).toBe(1e-18)
    expect(priceMinMove([{ time: 0, value: 0 }])).toBe(1e-18)
    expect(priceMinMove([{ time: 0, value: 1e-30 }])).toBe(1e-18)
  })
})
