import { useEffect, useMemo, useRef } from 'react'
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
import { formatPriceCompactText } from '../lib/format'
import {
  SECONDS_VISIBLE_BELOW,
  buildPriceSeries,
  priceMinMove,
  seriesSpanSeconds,
} from '../lib/priceSeries'
import { useNowSeconds } from '../hooks/useNowSeconds'

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

  // Shared page clock, so the flat tail advances instead of freezing at first-render's `now`.
  const now = useNowSeconds()
  const series = useMemo(
    () => buildPriceSeries(trades, { nowSeconds: now, extendToNow: !graduated }),
    [trades, now, graduated],
  )
  const isEmpty = series.points.length === 0

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

    return () => {
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
    // Not `fitContent()`: that pins the first and last points to the exact edges, which clips the
    // leftmost time label in half and draws a final price step flush against the price scale. A
    // logical range with a little padding either side fits the same data and leaves both readable.
    const pad = Math.max(1, Math.round(series.points.length * EDGE_PAD_FRACTION))
    chart
      .timeScale()
      .setVisibleLogicalRange({ from: -pad, to: series.points.length - 1 + pad })
  }, [series])

  if (isEmpty) {
    return <div className="center-note">No trades yet — be the first to buy this curve.</div>
  }

  return (
    <div className="chart-block">
      <div className="chart-wrap" ref={containerRef} />
      <p className="chart-caption">
        {graduated
          ? 'Curve price up to graduation. Trading has moved to the locked V3 pool.'
          : 'Marginal curve price - flat between trades, because the curve only moves when someone trades.'}
        {series.bucketSeconds > 1 && ` Sampled every ${formatDuration(series.bucketSeconds)}.`}
      </p>
    </div>
  )
}
