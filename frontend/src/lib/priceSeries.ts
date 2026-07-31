import type { TradeRow } from './subgraph'
import { priceEthPerToken } from './format'

/**
 * Turn indexed trades into a plottable price series.
 *
 * This module exists because the previous chart plotted price against the trade *index* and smoothed
 * between points, which fabricated history. The seeded RDOGE curve is the clearest example: three
 * buys inside six seconds that moved price ~8x, then a 49-minute gap, then one small buy, then hours
 * of silence. On an index axis with monotone interpolation that renders as a graceful, evenly-paced
 * S-curve - a price history that never happened.
 *
 * Three properties make the series honest, and each is enforced here rather than in the component:
 *
 *  1. **Time-proportional spacing.** Points sit on a fixed time grid, so a 49-minute gap is drawn
 *     ~980x wider than a 3-second one. See {@link buildPriceSeries} on why a grid is required.
 *  2. **Carry-forward, not interpolation.** A bonding curve's marginal price is constant between
 *     trades and jumps at each one, so every grid point holds the last traded price. The renderer
 *     draws `LineType.WithSteps`; the values here already encode the same claim.
 *  3. **An explicit tail.** A curve that last traded hours ago must not end at the right edge looking
 *     freshly active, so a live curve is carried flat to `now`. The tail is only honest because the
 *     input window is anchored to the newest trades - see TRADE_HISTORY_LIMIT in lib/subgraph.ts.
 *
 * ⚠️ **The one dishonesty that remains, deliberately.** Resampling keeps the LAST price in each
 * bucket, so a move that fully reverses inside one bucket leaves no trace: at a 30-day span the
 * grid is ~1h, and a 10x spike followed by a return to the old price inside that hour renders as a
 * flat line. Nothing is fabricated - every value plotted genuinely held - but an excursion is
 * omitted, and past MAX_MARKERS even the markers are gone. Carrying each bucket's min and max would
 * fix it, which is what a candlestick's wicks are for; it is a change to what this series MEANS
 * rather than a bug fix, so it is written down here rather than smuggled in.
 */

/** A point on the price line. `time` is a UTC timestamp in **seconds**, as lightweight-charts wants. */
export interface PricePoint {
  time: number
  value: number
}

/** A real trade to mark on the line. Grid points with no trade in them never produce one. */
export interface TradeMarker {
  time: number
  side: 'BUY' | 'SELL'
  /** Trades that fell inside this grid bucket - see the bucketing note on {@link buildPriceSeries}. */
  count: number
}

export interface PriceSeries {
  points: PricePoint[]
  markers: TradeMarker[]
  /** True when the line was carried flat to `now`, so the caller can caption it. */
  hasTail: boolean
  /** Grid resolution actually used, so the UI can state the chart's precision honestly. */
  bucketSeconds: number
}

/**
 * Above this many trade markers they become noise rather than information, and the stepped line
 * already shows every move. Sparse curves - the common case on a new launchpad, and the case where
 * a two-point line is otherwise unreadable - keep their markers.
 */
export const MAX_MARKERS = 40

/**
 * Grid points to aim for.
 *
 * Sets the chart's time resolution: a curve spanning 3.4 hours resolves to ~15s, one spanning a week
 * to ~15min. High enough that distinct trades stay distinct at normal zoom, low enough that a curve
 * running for months does not build a million-point array.
 */
const DEFAULT_MAX_POINTS = 800

export interface BuildOptions {
  /** Wall clock, injected so the series is deterministic under test. */
  nowSeconds: number
  /**
   * Carry the line flat to `now`.
   *
   * True for a live curve: the price genuinely still is the last traded price. **False once the token
   * has graduated** - the curve is closed and its final price is frozen, so running the line to now
   * would imply the *market* price hasn't moved, when in reality trading has moved to the V3 pool
   * and this chart has no visibility into it.
   */
  extendToNow: boolean
  maxPoints?: number
}

/** One second's worth of trading, collapsed: the curve's price after the last trade in that second. */
interface PriceEvent {
  time: number
  value: number
  side: 'BUY' | 'SELL'
  count: number
}

export function buildPriceSeries(trades: TradeRow[], opts: BuildOptions): PriceSeries {
  const events = toEvents(trades)
  if (events.length === 0) {
    return { points: [], markers: [], hasTail: false, bucketSeconds: 0 }
  }

  const from = events[0].time
  const lastEventTime = events[events.length - 1].time
  const now = Math.floor(opts.nowSeconds)
  const hasTail = opts.extendToNow && now > lastEventTime
  const to = hasTail ? now : lastEventTime

  // A curve whose entire life fits in one second has no span to lay out.
  if (to === from) {
    const only = events[events.length - 1]
    return {
      points: [{ time: from, value: only.value }],
      markers: [{ time: from, side: only.side, count: events.reduce((n, e) => n + e.count, 0) }],
      hasTail: false,
      bucketSeconds: 1,
    }
  }

  // Lightweight-charts' time scale is ORDINAL: every data point gets one equal-width slot, and the
  // gaps between timestamps are collapsed. That is right for OHLC bars sampled on a fixed interval
  // and wrong for raw events - feeding it four trades produces four evenly spaced points no matter
  // how far apart they happened, which is precisely the lie this module was written to remove.
  //
  // So resample onto a fixed grid, which makes slot position and elapsed time the same thing. This
  // is not a workaround for the library; it is what a candle chart does, and for a curve whose price
  // is piecewise-constant the carried-forward value at each grid point is exactly correct.
  const maxPoints = opts.maxPoints ?? DEFAULT_MAX_POINTS
  const bucketSeconds = Math.max(1, Math.ceil((to - from) / maxPoints))

  const points: PricePoint[] = []
  let cursor = 0
  let carried = events[0].value
  for (let t = from; t <= to; t += bucketSeconds) {
    while (cursor < events.length && events[cursor].time <= t) {
      carried = events[cursor].value
      cursor++
    }
    points.push({ time: t, value: carried })
  }
  // The grid rarely lands exactly on `to`, and the line must reach the right edge - otherwise a
  // live curve appears to stop up to one bucket short of now.
  if (points[points.length - 1].time !== to) {
    while (cursor < events.length && events[cursor].time <= to) {
      carried = events[cursor].value
      cursor++
    }
    points.push({ time: to, value: carried })
  }

  const lastTime = points[points.length - 1].time
  return { points, markers: toMarkers(events, from, bucketSeconds, lastTime), hasTail, bucketSeconds }
}

/**
 * Trades to one-second price events, strictly ascending and unique.
 *
 * Robinhood Chain produces 0.3s blocks (0.1s on mainnet), so several trades landing in one second is
 * routine rather than an edge case, and lightweight-charts requires unique ascending times. The
 * surviving value is the price after the *last* trade of that second - the marginal price the curve
 * would actually have quoted at that moment.
 */
function toEvents(trades: TradeRow[]): PriceEvent[] {
  const sorted = [...trades]
    .filter((t) => Number.isFinite(Number(t.timestamp)))
    .sort((a, b) => Number(a.timestamp) - Number(b.timestamp))

  const byTime = new Map<number, PriceEvent>()
  for (const t of sorted) {
    const time = Math.floor(Number(t.timestamp))
    byTime.set(time, {
      time,
      value: priceEthPerToken(BigInt(t.priceX18)),
      side: t.type,
      count: (byTime.get(time)?.count ?? 0) + 1,
    })
  }
  return [...byTime.values()]
}

/**
 * Place a marker on the grid point each trade falls into.
 *
 * Markers must sit on times that exist in the series or the chart silently drops them, so every
 * event is snapped to a grid point. It is snapped **up**, not down, and that direction is the whole
 * correctness of this function: a grid point carries every event at or before it, so the point at
 * or after a trade is the first one holding the price that trade produced. Snapping down lands the
 * dot on the *previous* price - visibly at the foot of the step it caused rather than on top of it,
 * with the crosshair reporting the pre-trade price for a trade that moved the market.
 *
 * The last bucket can round past the end of the series, so it is clamped to the final point.
 *
 * When the grid is coarser than the trading, several trades share one marker and the count says so
 * - which is the honest reading: at a resolution of 15s, a three-trade burst inside 6s genuinely is
 * one instant.
 */
function toMarkers(
  events: PriceEvent[],
  from: number,
  bucketSeconds: number,
  lastTime: number,
): TradeMarker[] {
  const byBucket = new Map<number, TradeMarker>()
  for (const e of events) {
    const snapped = from + Math.ceil((e.time - from) / bucketSeconds) * bucketSeconds
    const time = Math.min(snapped, lastTime)
    byBucket.set(time, {
      time,
      side: e.side,
      count: (byBucket.get(time)?.count ?? 0) + e.count,
    })
  }
  const markers = [...byBucket.values()]
  return markers.length <= MAX_MARKERS ? markers : []
}

/**
 * How long the series spans, in seconds - `0` for a single point.
 *
 * Used to decide whether the time axis needs seconds visible. A curve whose whole life is a
 * six-second burst is unreadable on minute ticks.
 */
export function seriesSpanSeconds(points: PricePoint[]): number {
  if (points.length < 2) return 0
  return points[points.length - 1].time - points[0].time
}

/** Below this span the axis shows seconds; above it, minutes are enough. */
export const SECONDS_VISIBLE_BELOW = 6 * 60 * 60

/** The finest price difference that can exist: `priceX18` is an integer, so prices quantise to 1e-18. */
const ABSOLUTE_MIN_MOVE = 1e-18

/** Roughly how many significant digits of tick resolution to ask the price scale for. */
const MIN_MOVE_SIG_DIGITS = 4

/**
 * The price-scale tick granularity to use for a series.
 *
 * Lightweight-charts derives its tick marks from `minMove`, so this cannot simply be the true 1e-18
 * quantum: across a launchpad price range (~4e-10) that asks the scale to consider ~10^8 candidate
 * steps, and the chart silently fails to paint rather than erroring. Scaling it to the data keeps
 * tick generation bounded while still resolving far below the 1e-6 point where a default price
 * scale would give up and collapse every tick onto one value.
 */
export function priceMinMove(points: PricePoint[]): number {
  let max = 0
  for (const p of points) {
    if (Number.isFinite(p.value) && p.value > max) max = p.value
  }
  if (max <= 0) return ABSOLUTE_MIN_MOVE
  const exponent = Math.floor(Math.log10(max)) - MIN_MOVE_SIG_DIGITS
  return Math.max(ABSOLUTE_MIN_MOVE, 10 ** exponent)
}
