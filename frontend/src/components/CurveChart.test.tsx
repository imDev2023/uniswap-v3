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
