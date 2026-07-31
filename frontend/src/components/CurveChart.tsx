import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AreaSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  LineType,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type AutoscaleInfo,
  type ISeriesMarkersPluginApi,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts'
import type { TradeRow } from '../lib/subgraph'
import { TRADE_HISTORY_LIMIT } from '../config/constants'
import { formatPriceCompactText } from '../lib/format'
import {
  SECONDS_VISIBLE_BELOW,
  buildPriceSeries,
  priceMinMove,
  seriesSpanSeconds,
} from '../lib/priceSeries'
import { useNowSeconds } from '../hooks/useNowSeconds'
import {
  CHART_RANGES,
  DEFAULT_RANGE,
  rangeFrom,
  rangeEmptyPhrase,
  type ChartRangeId,
} from '../lib/chartRange'

// Marginal curve price after each indexed trade (spec story 27). Purely a subgraph read - the series
// is deterministic from the Bought/Sold events, with no eth_calls and no price oracle.
//
// Renders with TradingView's Lightweight Charts rather than a general-purpose charting library: it
// is built for exactly this shape of data (an irregular financial time series), it supplies the real
// time scale this chart was missing, and it costs ~47 kB gzip less than the recharts stack it
// replaced - which was 42% of the whole JS bundle for this one chart.
//
// `LineType.WithSteps` is a correctness choice, not a style one. A bonding curve's marginal price is
// constant between trades and jumps at each one, so interpolating between points draws a price path
// that never existed. See lib/priceSeries.ts for the rest of the honesty rules.

/** Canvas paints need concrete colour strings, so the design tokens are resolved to values here. */
const cssToken = (name: string, whenHeadless: string) => {
  if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined') return whenHeadless
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || whenHeadless
}

/**
 * Format an axis/crosshair price without ever throwing.
 *
 * The price scale probes its formatter with values the data never contains - including `NaN` while
 * it is still measuring. `BigInt(NaN)` raises a RangeError, and a throw inside the paint pipeline
 * does not surface as an error: the chart simply never sizes its canvases and renders blank.
 */
function formatAxisPrice(p: number): string {
  if (!Number.isFinite(p) || p <= 0) return '0'
  return formatPriceCompactText(BigInt(Math.round(p * 1e18)))
}

/** Bucket size as words, for the caption that states the chart's real resolution. */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`
  return `${Math.round(seconds / 86400)}d`
}

/** Synthetic price range given to a series whose price never moved, as a fraction of that price. */
const FLAT_SERIES_PAD = 0.05

/**
 * Breathing room at each end of the plot, as a fraction of the series length.
 *
 * Sized so the first and last tick labels clear the plot edges: at less than this the leftmost
 * timestamp renders half-cut (":19:17" instead of "21:19:17"), which reads as a broken axis.
 */
const EDGE_PAD_FRACTION = 0.05

export function CurveChart({
  trades,
  graduated = false,
}: {
  trades: TradeRow[]
  /** A graduated curve is frozen: the line stops at its last trade instead of running to now. */
  graduated?: boolean
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null)
  // Held across renders so new trades update the existing plugin instead of stacking up a new
  // marker plugin on the series every poll.
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null)
  // Once the viewer has zoomed or panned, the chart is theirs and must stop re-framing itself.
  // Without this the shared 5s clock rebuilds `series`, the framing effect re-runs, and any zoom is
  // silently thrown away a few seconds after it is made.
  const viewerMovedRef = useRef(false)

  const [range, setRange] = useState<ChartRangeId>(DEFAULT_RANGE)

  // Shared page clock, so the flat tail advances instead of freezing at first-render's `now`.
  const now = useNowSeconds()
  // `from` re-enters the BUILD rather than being applied as a zoom afterwards. Resampling fixes the
  // grid's resolution before the chart sees the data, so magnifying a dense cluster of a long span
  // shows a flat plateau - the detail is already gone. Narrowing the window is what re-derives it.
  const series = useMemo(
    () =>
      buildPriceSeries(trades, {
        nowSeconds: now,
        extendToNow: !graduated,
        from: rangeFrom(range, now),
      }),
    [trades, now, graduated, range],
  )
  const isEmpty = series.points.length === 0
  // Distinguishes "this curve has never traded" from "nothing happened in the last hour". Both draw
  // an empty plot, and telling a viewer a traded curve has no trades is the exact class of false
  // claim this chart was rewritten to remove.
  const hasAnyTrades = trades.length > 0
  // A full page means the subgraph almost certainly had more; the oldest row here is not the
  // curve's first trade and the caption must not let it read as one.
  const isWindowed = trades.length >= TRADE_HISTORY_LIMIT

  // --- create once per mount ---
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const accent = cssToken('--accent', '#29e59a')
    const grid = cssToken('--border', '#1b2330')

    const chart = createChart(container, {
      // Transparent rather than an opaque panel colour: the chart sits inside a card that already
      // owns its background, and repainting it here shows as a seam.
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: cssToken('--text-faint', '#5b6878'),
        fontSize: 11,
        fontFamily: cssToken('--mono', 'monospace'),
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: grid, style: LineStyle.Dotted },
        horzLines: { color: grid, style: LineStyle.Dotted },
      },
      crosshair: { mode: CrosshairMode.Magnet },
      rightPriceScale: { borderColor: grid, scaleMargins: { top: 0.15, bottom: 0.1 } },
      timeScale: {
        borderColor: grid,
        timeVisible: true,
        // No trailing whitespace after the last point: the series already runs to `now`, so blank
        // plot area past it would read as a gap in the data rather than as padding. `fitContent`
        // below does the fitting; `fixLeftEdge`/`fixRightEdge` only clamp panning, and combining
        // them with a fit leaves a half-bar margin at each end.
        rightOffset: 0,
      },
      autoSize: true,
    })

    const area = chart.addSeries(AreaSeries, {
      lineColor: accent,
      lineWidth: 2,
      topColor: `${accent}59`,
      bottomColor: `${accent}00`,
      lineType: LineType.WithSteps,
      // Launchpad prices sit far below 1e-6, where the default formatter falls back to exponential -
      // the exact defect (`3.125e-11`) that #28 removed everywhere else. Reuse the shared
      // subscript-zero notation so axis, crosshair label and page copy all agree.
      priceFormat: { type: 'custom', formatter: formatAxisPrice, minMove: priceMinMove([]) },
      priceLineVisible: false,
      // A curve with one trade - or many trades at the same price - has zero price range, so the
      // scale packs several ticks into a span narrower than the four significant digits we display
      // and renders the SAME label twice, which reads as a rendering fault. Give a flat series a
      // little synthetic range so its ticks are distinguishable.
      autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
        const info = original()
        if (!info?.priceRange) return info
        const { minValue, maxValue } = info.priceRange
        if (maxValue > minValue) return info
        const pad = Math.abs(maxValue) * FLAT_SERIES_PAD || 1
        return { ...info, priceRange: { minValue: minValue - pad, maxValue: maxValue + pad } }
      },
    })

    chartRef.current = chart
    seriesRef.current = area
    markersRef.current = createSeriesMarkers(area, [])

    // A fresh chart frames itself again. Listening for the input events rather than for
    // visible-range changes matters: the framing effect below moves the range itself, so a
    // range-change subscription could not tell the viewer's pan from our own.
    viewerMovedRef.current = false
    const claimViewport = () => {
      viewerMovedRef.current = true
    }
    container.addEventListener('wheel', claimViewport, { passive: true })
    container.addEventListener('pointerdown', claimViewport)
    container.addEventListener('touchstart', claimViewport, { passive: true })

    return () => {
      container.removeEventListener('wheel', claimViewport)
      container.removeEventListener('pointerdown', claimViewport)
      container.removeEventListener('touchstart', claimViewport)
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      markersRef.current = null
    }
    // `isEmpty` is a dependency because the empty state returns before the container is rendered,
    // so the ref is null on the first pass. Without it, a curve whose first trade arrives while the
    // page is open would never get a chart at all.
  }, [isEmpty])

  // --- feed data ---
  useEffect(() => {
    const area = seriesRef.current
    const chart = chartRef.current
    if (!area || !chart) return

    // Tick granularity has to track the data: a curve's prices span orders of magnitude between
    // launch and graduation, and a fixed minMove either collapses the ticks or overwhelms the scale.
    area.applyOptions({
      priceFormat: {
        type: 'custom',
        formatter: formatAxisPrice,
        minMove: priceMinMove(series.points),
      },
    })
    area.setData(series.points.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })))

    markersRef.current?.setMarkers(
      series.markers.map((m) => ({
        time: m.time as UTCTimestamp,
        position: 'inBar' as const,
        shape: 'circle' as const,
        color: m.side === 'BUY' ? cssToken('--accent', '#29e59a') : cssToken('--sell', '#ff5c7c'),
        // Only worth the ink when several trades collapsed into one second - otherwise the dot
        // already says "one trade happened here".
        text: m.count > 1 ? String(m.count) : undefined,
      })),
    )

    // A curve whose entire life is a six-second burst is unreadable on minute ticks, and one that
    // has run for days does not want a seconds column. Re-applied with the data because the span
    // changes as trades arrive.
    chart.applyOptions({
      timeScale: { secondsVisible: seriesSpanSeconds(series.points) < SECONDS_VISIBLE_BELOW },
    })
  }, [series])

  // Picking a range is the viewer explicitly handing the viewport back. Without this, someone who
  // had zoomed and then chose "1H" would keep the old framing over completely different data - the
  // chart would be showing a window they never asked for. It is the same ownership rule as below,
  // read in the other direction: their pan claims the viewport, their range choice releases it.
  useEffect(() => {
    viewerMovedRef.current = false
  }, [range])

  // --- frame the view ---
  // Deliberately separate from feeding the data. They run on the same input but answer to different
  // owners: the data is ours and must track the chain, whereas the viewport belongs to whoever is
  // looking at it the moment they touch it. Fusing the two is what made a 5s clock tick silently
  // undo a zoom.
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || viewerMovedRef.current || series.points.length === 0) return

    // Not `fitContent()`: that pins the first and last points to the exact edges, which clips the
    // leftmost time label in half and draws a final price step flush against the price scale. A
    // logical range with a little padding either side fits the same data and leaves both readable.
    const pad = Math.max(1, Math.round(series.points.length * EDGE_PAD_FRACTION))
    chart
      .timeScale()
      .setVisibleLogicalRange({ from: -pad, to: series.points.length - 1 + pad })
  }, [series])

  // A curve that has genuinely never traded needs no range control - there is nothing to range over,
  // and offering one implies data exists somewhere behind it.
  if (isEmpty && !hasAnyTrades) {
    return <div className="center-note">No trades yet — be the first to buy this curve.</div>
  }

  const picker = (
    <div className="chart-ranges" role="group" aria-label="Chart time range">
      {CHART_RANGES.map((r) => (
        <button
          key={r.id}
          type="button"
          className="chart-range"
          title={r.title}
          aria-pressed={range === r.id}
          onClick={() => setRange(r.id)}
        >
          {r.label}
        </button>
      ))}
    </div>
  )

  // Empty because of the RANGE, not because the curve is untraded. The control has to stay on
  // screen: without it, picking "1H" on a quiet curve leaves a dead panel and no way back to ALL.
  if (isEmpty) {
    return (
      <div className="chart-block">
        {picker}
        <div className="center-note">No trades in {rangeEmptyPhrase(range)}.</div>
      </div>
    )
  }

  return (
    <div className="chart-block">
      {picker}
      <div className="chart-wrap" ref={containerRef} />
      <p className="chart-caption">
        {graduated
          ? 'Curve price up to graduation. Trading has moved to the locked V3 pool.'
          : 'Marginal curve price - flat between trades, because the curve only moves when someone trades.'}
        {series.bucketSeconds > 1 && ` Sampled every ${formatDuration(series.bucketSeconds)}.`}
        {/* The window is the most RECENT trades, so the right edge is always real. Say so, rather
            than letting the left edge pass for the launch of the curve.
            Driven by the SERIES, not by the range: gating this on `range === 'all'` was a real bug,
            because "inside a narrower range the left edge is the range" stops being true the moment
            the 200-trade cap bites inside that range. Pack 200 trades into the last half hour and
            ask for 1H - routine at mainnet's 0.1 s blocks - and the line starts 30 minutes into the
            window. `startsAtOldestHeldTrade` is exactly the question the caption answers. */}
        {isWindowed && series.startsAtOldestHeldTrade && ` Last ${TRADE_HISTORY_LIMIT} trades.`}
      </p>
    </div>
  )
}
