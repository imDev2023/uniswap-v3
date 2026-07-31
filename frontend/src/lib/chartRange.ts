/**
 * Time ranges the price chart can be re-derived over.
 *
 * ⚠️ **A range selector is not a zoom control, and the difference is why this exists.** The series
 * is resampled onto a fixed grid at BUILD time (see lib/priceSeries.ts), so its resolution is
 * decided before the chart renders a single pixel. On a 30-day span the grid is roughly an hour
 * wide, and an hour of frantic trading is already collapsed to one point by the time the canvas
 * sees it - magnifying that region shows a flat plateau, because there is nothing left in the data
 * to magnify. Only re-running the build with a narrower `from` recovers the detail, which is what
 * picking a range does.
 *
 * "Just zoom in" was never an adequate answer to this, and until the #29 review split the chart's
 * data effect from its viewport effect, zooming did not even survive the next 5-second poll.
 */

export type ChartRangeId = '1h' | '6h' | '1d' | 'all'

export interface ChartRange {
  id: ChartRangeId
  label: string
  /** Window width in seconds; `null` means every trade held. */
  seconds: number | null
  /** Tooltip, since two-character labels cannot carry their own meaning. */
  title: string
}

export const CHART_RANGES: readonly ChartRange[] = [
  { id: '1h', label: '1H', seconds: 3_600, title: 'Last hour' },
  { id: '6h', label: '6H', seconds: 6 * 3_600, title: 'Last 6 hours' },
  { id: '1d', label: '1D', seconds: 24 * 3_600, title: 'Last 24 hours' },
  { id: 'all', label: 'ALL', seconds: null, title: 'Every trade held' },
] as const

/**
 * Opening range.
 *
 * `all` rather than a narrow default: a launchpad curve's whole story is usually short, and opening
 * on "1H" would hide the launch of anything more than an hour old behind a control the viewer has
 * not been given a reason to touch yet.
 */
export const DEFAULT_RANGE: ChartRangeId = 'all'

/** The `from` timestamp to build a series with, or `undefined` for the whole history. */
export function rangeFrom(range: ChartRangeId, nowSeconds: number): number | undefined {
  const seconds = CHART_RANGES.find((r) => r.id === range)?.seconds
  return seconds == null ? undefined : Math.floor(nowSeconds) - seconds
}

/**
 * How to name a range inside a sentence, e.g. "No trades in {…}".
 *
 * Written out per range rather than lower-casing `title`, which produced "No trades in the every
 * trade held." for ALL - a tooltip phrase is not a noun phrase, and reusing one as the other only
 * reads correctly by luck. ALL is reachable here whenever the trades list is non-empty but yields
 * no plottable events.
 */
export function rangeEmptyPhrase(range: ChartRangeId): string {
  switch (range) {
    case '1h':
      return 'the last hour'
    case '6h':
      return 'the last 6 hours'
    case '1d':
      return 'the last 24 hours'
    case 'all':
      return 'this curve’s history'
  }
}
