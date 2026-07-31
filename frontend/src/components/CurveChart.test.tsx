import { render, act, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TradeRow } from '../lib/subgraph'

// The chart is a canvas renderer, so the assertions here are about the CALLS it makes to
// lightweight-charts rather than about pixels. That is the right seam: the defects this file guards
// are both "the component talks to the chart API at the wrong moment", which is invisible to a DOM
// assertion and was originally found only by watching the running app.
const setVisibleLogicalRange = vi.fn()
const setData = vi.fn()
const setMarkers = vi.fn()

vi.mock('lightweight-charts', () => {
  const series = { applyOptions: vi.fn(), setData }
  const chart = {
    addSeries: () => series,
    applyOptions: vi.fn(),
    timeScale: () => ({ setVisibleLogicalRange }),
    remove: vi.fn(),
  }
  return {
    createChart: () => chart,
    createSeriesMarkers: () => ({ setMarkers }),
    AreaSeries: 'Area',
    ColorType: { Solid: 'solid' },
    CrosshairMode: { Magnet: 1 },
    LineStyle: { Dotted: 1 },
    LineType: { WithSteps: 1 },
  }
})

const { CurveChart } = await import('./CurveChart')

const trade = (timestamp: number, priceX18: string): TradeRow =>
  ({
    id: `${timestamp}`,
    trader: '0xaaaa',
    type: 'BUY',
    amountEth: '0',
    amountToken: '0',
    priceX18,
    tokensSold: '0',
    timestamp: String(timestamp),
    txHash: '0xdead',
  }) as unknown as TradeRow

const TRADES = [trade(1000, '10000000000'), trade(1600, '20000000000')]

/** Advance the shared 5s clock in useNowSeconds by one tick. */
const tick = () => act(() => void vi.advanceTimersByTime(5_100))

describe('CurveChart viewport ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setVisibleLogicalRange.mockClear()
    setData.mockClear()
  })
  afterEach(() => vi.useRealTimers())

  it('keeps following the data while nobody has touched the chart', () => {
    render(<CurveChart trades={TRADES} graduated={false} />)
    tick()
    tick()
    // New trades must still come into view on a live board, so re-framing is correct until the
    // viewer takes over.
    expect(setVisibleLogicalRange.mock.calls.length).toBeGreaterThan(1)
  })

  it('stops re-framing once the viewer zooms, instead of undoing it on the next clock tick', () => {
    const { container } = render(<CurveChart trades={TRADES} graduated={false} />)
    const wrap = container.querySelector('.chart-wrap')!

    tick()
    fireEvent.wheel(wrap)
    const framesAtTakeover = setVisibleLogicalRange.mock.calls.length

    tick()
    tick()
    tick()

    // The regression this guards: `series` is rebuilt every 5s from the shared clock, so a framing
    // effect keyed on it silently threw away any zoom a few seconds after it was made.
    expect(setVisibleLogicalRange.mock.calls.length).toBe(framesAtTakeover)
    // ...while the data must keep flowing regardless of who owns the viewport.
    expect(setData.mock.calls.length).toBeGreaterThan(framesAtTakeover)
  })

  it('also honours a pointer drag, not just the wheel', () => {
    const { container } = render(<CurveChart trades={TRADES} graduated={false} />)
    const wrap = container.querySelector('.chart-wrap')!

    fireEvent.pointerDown(wrap)
    const framesAtTakeover = setVisibleLogicalRange.mock.calls.length
    tick()
    tick()

    expect(setVisibleLogicalRange.mock.calls.length).toBe(framesAtTakeover)
  })
})

describe('CurveChart caption', () => {
  it('says the view is a window when the trade page came back full', () => {
    // A full page means older trades exist that are not plotted, so the left edge is NOT the launch
    // of the curve and the caption must not let it read as one.
    const many = Array.from({ length: 200 }, (_, i) => trade(1000 + i * 10, '10000000000'))
    const { container } = render(<CurveChart trades={many} graduated={false} />)
    expect(container.querySelector('.chart-caption')?.textContent).toContain('Last 200 trades')
  })

  it('makes no such claim when the whole history fits', () => {
    const { container } = render(<CurveChart trades={TRADES} graduated={false} />)
    expect(container.querySelector('.chart-caption')?.textContent).not.toContain('Last 200')
  })
})

describe('CurveChart range selector', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setVisibleLogicalRange.mockClear()
    setData.mockClear()
  })
  afterEach(() => vi.useRealTimers())

  /** Trades an hour+ apart, so a 1H window genuinely excludes the older one. */
  const NOW = Math.floor(Date.now() / 1000)
  const SPREAD = [
    trade(NOW - 20 * 3600, '10000000000'),
    trade(NOW - 10 * 3600, '20000000000'),
    trade(NOW - 600, '90000000000'),
  ]

  it('offers the ranges and marks the active one for assistive tech, not just visually', () => {
    const { getByTitle } = render(<CurveChart trades={SPREAD} graduated={false} />)
    expect(getByTitle('Every trade held')).toHaveAttribute('aria-pressed', 'true')
    expect(getByTitle('Last hour')).toHaveAttribute('aria-pressed', 'false')
  })

  it('rebuilds the series at a finer grid when a narrower range is picked', () => {
    const { getByTitle } = render(<CurveChart trades={SPREAD} graduated={false} />)
    const pointsFor = (i: number) => setData.mock.calls[i][0] as { time: number }[]
    const allPoints = pointsFor(setData.mock.calls.length - 1)
    const allBucket = allPoints[1].time - allPoints[0].time

    act(() => void fireEvent.click(getByTitle('Last hour')))
    const hourPoints = pointsFor(setData.mock.calls.length - 1)
    const hourBucket = hourPoints[1].time - hourPoints[0].time

    // The whole justification for the control: the data is re-derived, not merely magnified.
    expect(hourBucket).toBeLessThan(allBucket)
  })

  it('re-frames on a range change even after the viewer has zoomed', () => {
    const { container, getByTitle } = render(<CurveChart trades={SPREAD} graduated={false} />)
    fireEvent.wheel(container.querySelector('.chart-wrap')!)
    const framesAtTakeover = setVisibleLogicalRange.mock.calls.length

    act(() => void fireEvent.click(getByTitle('Last hour')))

    // Picking a range is the viewer handing the viewport back. Keeping their old framing over a
    // completely different window would show them a view they never asked for.
    expect(setVisibleLogicalRange.mock.calls.length).toBeGreaterThan(framesAtTakeover)
  })

  it('keeps the picker on screen when a range turns up empty, so there is a way back', () => {
    const old = [trade(NOW - 40 * 3600, '10000000000')]
    // Graduated: a closed curve cannot be carried forward to now, so a recent window is truly empty.
    const { getByTitle, getByText } = render(<CurveChart trades={old} graduated />)
    act(() => void fireEvent.click(getByTitle('Last hour')))

    expect(getByText(/no trades in the last hour/i)).toBeInTheDocument()
    // Without this the panel would be a dead end with no route back to ALL.
    expect(getByTitle('Every trade held')).toBeInTheDocument()
  })

  it('captions the truncation when the 200-trade cap bites INSIDE the chosen range', () => {
    // Gating this caption on `range === 'all'` was a real bug: "inside a narrower range the left
    // edge is the range" holds only while the cap does not bite inside that range. 200 trades in
    // the last half hour with a 1H window - routine at mainnet's 0.1s blocks - starts the line 30
    // minutes in, and without the caption that reads as "the hour began here".
    const dense = Array.from({ length: 200 }, (_, i) =>
      trade(NOW - 1800 + i * 5, String(BigInt(i + 1) * 10n ** 9n)),
    )
    const { getByTitle, getByText } = render(<CurveChart trades={dense} graduated={false} />)
    act(() => void fireEvent.click(getByTitle('Last hour')))
    expect(getByText(/last 200 trades/i)).toBeInTheDocument()
  })

  it('drops the caption when the range edge is real, so it is not just always on', () => {
    // A trade before the window means the left edge IS the window, and the caption would be false.
    const withHistory = [
      trade(NOW - 20 * 3600, '10000000000'),
      ...Array.from({ length: 199 }, (_, i) => trade(NOW - 1800 + i * 5, String(BigInt(i + 2) * 10n ** 9n))),
    ]
    const { getByTitle, queryByText } = render(<CurveChart trades={withHistory} graduated={false} />)
    act(() => void fireEvent.click(getByTitle('Last hour')))
    expect(queryByText(/last 200 trades/i)).toBeNull()
  })

  it('names the ALL range readably in the empty state', () => {
    // `rangeLabel` lower-cased the tooltip, producing "No trades in the every trade held."
    const nonFinite = [trade(NaN as unknown as number, '10000000000')]
    const { getByText } = render(<CurveChart trades={nonFinite} graduated={false} />)
    expect(getByText(/no trades in this curve.s history/i)).toBeInTheDocument()
  })

  it('distinguishes an untraded curve from a quiet range', () => {
    const { queryByTitle, getByText } = render(<CurveChart trades={[]} graduated={false} />)
    expect(getByText(/be the first to buy/i)).toBeInTheDocument()
    // Nothing to range over, and offering the control would imply data exists behind it.
    expect(queryByTitle('Last hour')).toBeNull()
  })
})
