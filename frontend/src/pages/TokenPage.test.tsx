import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

// Page-level guards for the #29 token-page rework. The pure modules (lib/priceSeries) prove the
// series is honest; these prove the WIRING - that the page tells the chart whether the curve is
// closed, that a graduated token renders ONE card rather than two saying the same thing, and that
// the Stage 2 split survives (trade path from RPC, feed degrading on its own).

const TOKEN = '0x52eEF29c3c869B4D04F3c1451b16548DEAA923bE'
const CURVE = '0x81a14013d3F048BcBe4AF0fB8b88aF0ec25D799a'
const POOL = '0xDC27FeCB8589c0FB0328fd98963c823a1681E933'
const V3FACTORY = '0x158a14f6Aa8C86921e624e3ed0526F31520cB2BD'
const DEV_VESTING = '0xFD8BaE689f3d878A15Cec543Fb042230283752d4'
const LP_LOCK = '0xFBDf081CD189286569678fF60CC4BD5058A09078'
const ZERO = '0x0000000000000000000000000000000000000000'

const TRADES = [
  {
    id: 't1',
    trader: '0x8Ec5f1e04531416d337E61733DfC5d1685D9A80C',
    type: 'BUY' as const,
    amountEth: '250000000000000000',
    amountToken: '1000000000000000000000',
    priceX18: '54103185',
    tokensSold: '1000000000000000000000',
    timestamp: '1000',
    txHash: '0xaaa',
  },
  {
    id: 't2',
    trader: '0x8Ec5f1e04531416d337E61733DfC5d1685D9A80C',
    type: 'SELL' as const,
    amountEth: '20000000000000000',
    amountToken: '500000000000000000000',
    priceX18: '432666306',
    tokensSold: '500000000000000000000',
    timestamp: '1200',
    txHash: '0xbbb',
  },
]

// lightweight-charts paints to a canvas jsdom does not implement. Mocking it also turns the chart
// into an observable seam: `setData` receiving a time-ordered series is the wiring assertion.
const setData = vi.fn()
const setMarkers = vi.fn()
vi.mock('lightweight-charts', () => ({
  createChart: () => ({
    addSeries: () => ({ setData, applyOptions: vi.fn() }),
    applyOptions: vi.fn(),
    timeScale: () => ({ setVisibleLogicalRange: vi.fn(), fitContent: vi.fn() }),
    remove: vi.fn(),
  }),
  createSeriesMarkers: () => ({ setMarkers }),
  AreaSeries: 'Area',
  ColorType: { Solid: 'solid' },
  CrosshairMode: { Magnet: 1 },
  LineStyle: { Dotted: 1 },
  LineType: { WithSteps: 1 },
}))

const fetchToken = vi.fn()
const fetchTrades = vi.fn()
const fetchCurvePositions = vi.fn()
vi.mock('../lib/subgraph', () => ({
  fetchToken: (...a: unknown[]) => fetchToken(...a),
  fetchTrades: (...a: unknown[]) => fetchTrades(...a),
  fetchCurvePositions: (...a: unknown[]) => fetchCurvePositions(...a),
  fetchMeta: vi.fn(() => Promise.reject(new Error('down'))),
}))

const readContractsMock = vi.fn()
vi.mock('wagmi', () => ({
  useReadContracts: (...a: unknown[]) => readContractsMock(...a),
  useReadContract: () => ({ data: undefined }),
  useAccount: () => ({ address: undefined, isConnected: false }),
  useBalance: () => ({ data: undefined }),
  useBlock: () => ({ data: undefined }),
  useSimulateContract: () => ({ data: undefined, isFetching: false }),
  useWriteContract: () => ({ writeContract: vi.fn(), isPending: false, reset: vi.fn() }),
  useWaitForTransactionReceipt: () => ({ isLoading: false, isSuccess: false }),
  useChainId: () => 46630,
  useConnect: () => ({ connect: vi.fn(), connectors: [], isPending: false }),
  useDisconnect: () => ({ disconnect: vi.fn() }),
  useSwitchChain: () => ({ switchChain: vi.fn() }),
}))

vi.mock('../config/contracts', async (orig) => ({
  ...(await orig<typeof import('../config/contracts')>()),
  FACTORY_ADDRESS: '0x632FD8713356aCc4ec9BdC6b378c05707bc9D1E7',
  isLaunchpadConfigured: true,
  isSwapConfigured: true,
  isQuoterConfigured: false,
}))

function ok(result: unknown) {
  return { status: 'success' as const, result }
}

/**
 * Answer whichever round the page is asking for, by its contract shape.
 *
 * ⚠️ A round this does not recognise must NOT fall through to another round's answer. #37 added the
 * launch-terms reads, and letting them land on the graduation round's `[bool, address]` handed a
 * boolean to a `BigInt()` - which at least threw. The silent version of the same mistake is what
 * this default guards against: an unrecognised round answering with somebody else's plausible data.
 */
function chainSays({ graduated }: { graduated: boolean }) {
  readContractsMock.mockImplementation((cfg: { contracts: { functionName: string }[] }) => {
    const fns = cfg.contracts.map((c) => c.functionName)
    if (fns.includes('curveOf')) {
      return { data: [ok(CURVE), ok(V3FACTORY), ok('Meta Test'), ok('META')], isError: false }
    }
    if (fns.includes('graduated')) {
      return { data: [ok(graduated), ok(graduated ? POOL : undefined)], isError: false }
    }
    // The two periphery addresses (usePeriphery).
    if (fns.includes('devVesting')) {
      return { data: [ok(DEV_VESTING), ok(LP_LOCK)], isError: false }
    }
    // The frozen lock terms + dev carve (useLaunchTerms). This fixture is the no-carve case.
    if (fns.includes('lockConfigOf')) {
      return { data: [ok([31_536_000n, 7000, false]), ok(0n)], isError: false }
    }
    // The vesting grant + claimable (useLaunchTerms). No grant exists for a no-carve launch.
    if (fns.includes('grantOf')) {
      return {
        data: [ok({ creator: ZERO, duration: 0n, total: 0n, claimed: 0n }), ok(0n)],
        isError: false,
      }
    }
    // Reclaim status, which only runs once a lock record exists.
    return { data: undefined, isError: false }
  })
}

async function renderTokenPage() {
  const { TokenPage } = await import('./TokenPage')
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/token/${TOKEN}`]}>
        <Routes>
          <Route path="/token/:address" element={<TokenPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  fetchToken.mockResolvedValue({
    id: TOKEN.toLowerCase(),
    creator: '0x8Ec5f1e04531416d337E61733DfC5d1685D9A80C',
    priceX18: '432666306',
    volumeEth: '270000000000000000',
    ethReserve: '124000000000000000',
    tradeCount: 2,
    // `holderCount` until #36 renamed the entity. The stale key sat here through the rename with
    // nothing asserting on it, so the page rendered `undefined` into the curve-position stat and
    // every test stayed green - the exact shape of the trap #36's review recorded.
    curvePositionCount: 1,
    buyCount: 1,
    sellCount: 1,
    progressBps: 9750,
    tokensSold: '780000000000000000000000000',
    // Per launch since #34; this fixture is the no-dev-allocation case.
    curveTokenAllocation: '800000000000000000000000000',
    // Launch terms (#36). The no-carve, standard-lock case.
    devAllocation: '0',
    devClaimed: '0',
    vestingDuration: '2592000',
    lockDuration: '31536000',
    creatorFeeBps: 7000,
    permanentLock: false,
    lock: null,
    graduation: { raisedEth: '100000000000000000' },
  })
  fetchTrades.mockResolvedValue(TRADES)
  fetchCurvePositions.mockResolvedValue([])
})

describe('TokenPage - a graduated token gets ONE card, not two', () => {
  beforeEach(() => chainSays({ graduated: true }))

  it('states that curve trading is closed exactly once', async () => {
    await renderTokenPage()
    await screen.findByRole('heading', { name: /meta test/i })

    // The pre-#29 shape: a "Trade" card whose whole content was "curve trading is closed", sitting
    // directly above a "Graduated" card repeating it and then doing something useful.
    expect(screen.getAllByText(/curve trading is closed/i)).toHaveLength(1)
    expect(screen.queryByText(/trade it on the DEX pool instead/i)).not.toBeInTheDocument()
  })

  it('keeps the pool facts and the swap route on that one card', async () => {
    await renderTokenPage()
    expect(await screen.findByText(/0xDC27…E933/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /swap meta \/ eth/i })).toBeInTheDocument()
  })

  it('offers no buy/sell tabs for a closed curve', async () => {
    await renderTokenPage()
    await screen.findByRole('heading', { name: /meta test/i })
    expect(screen.queryByRole('button', { name: /^buy$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^sell$/i })).not.toBeInTheDocument()
  })

  it('freezes the chart at graduation instead of running it to now', async () => {
    await renderTokenPage()
    await screen.findByRole('heading', { name: /meta test/i })

    const calls = setData.mock.calls
    const points = calls[calls.length - 1][0] as { time: number }[]
    expect(points.length).toBeGreaterThan(0)
    // The last trade is at t=1200. A live curve carries a flat tail to wall-clock `now`, which is
    // ~1.8e9. A graduated one must stop dead, or the page implies the market price hasn't moved.
    expect(points[points.length - 1].time).toBe(1200)
  })

  it('does not label a closed curve history as a live feed', async () => {
    await renderTokenPage()
    await screen.findByRole('heading', { name: /meta test/i })

    // The chart directly above this rail stops dead at graduation and says so. A pulsing "Live
    // trades" header over the same closed curve contradicts it on the same screen, and these rows
    // are history: the curve cannot produce another one.
    expect(screen.queryByText(/live trades/i)).not.toBeInTheDocument()
    expect(screen.getByText(/curve trades/i)).toBeInTheDocument()
  })
})

describe('TokenPage - a live curve', () => {
  beforeEach(() => chainSays({ graduated: false }))

  it('renders the trade panel rather than a graduation card', async () => {
    await renderTokenPage()
    expect(await screen.findByRole('button', { name: /^buy$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^sell$/i })).toBeInTheDocument()
    expect(screen.queryByText(/curve trading is closed/i)).not.toBeInTheDocument()
  })

  it('carries the price line to now, so a silent curve reads as silent', async () => {
    await renderTokenPage()
    await screen.findByRole('button', { name: /^buy$/i })

    const calls = setData.mock.calls
    const points = calls[calls.length - 1][0] as { time: number }[]
    expect(points[points.length - 1].time).toBeGreaterThan(1_000_000_000)
  })

  it('spaces the series by real elapsed time, not by trade index', async () => {
    await renderTokenPage()
    await screen.findByRole('button', { name: /^buy$/i })

    const calls = setData.mock.calls
    const points = calls[calls.length - 1][0] as { time: number }[]
    // Two trades 200s apart. An index-spaced series would hand the chart 2 points; a
    // time-proportional one fills the span, which is the whole point of the rework.
    expect(points.length).toBeGreaterThan(2)
    expect(points[0].time).toBe(1000)
  })
})

describe('TokenPage - the lock panel survives an indexer outage', () => {
  // ⚠️ **Found by loading the page with graph-node stopped, not by any test.** Both the lock and
  // vesting panels were gated on the indexed token row, so during an outage the page silently
  // dropped the panel a buyer reads to find out whether the liquidity is locked at all - and took
  // the creator's claim button with it. Every term on that panel is frozen at `createLaunch` and
  // readable per token, so it belongs on the chain side of the Stage 2 split, like the trade panel.
  beforeEach(() => chainSays({ graduated: false }))

  it('still states the lock term when every subgraph fetcher rejects', async () => {
    fetchToken.mockRejectedValue(new Error('ECONNREFUSED'))
    fetchTrades.mockRejectedValue(new Error('ECONNREFUSED'))
    fetchCurvePositions.mockRejectedValue(new Error('ECONNREFUSED'))

    await renderTokenPage()
    await screen.findByRole('button', { name: /^buy$/i })

    expect(screen.getByText(/liquidity lock/i)).toBeInTheDocument()
    expect(screen.getByText('1 year')).toBeInTheDocument()
    expect(screen.getByText('70% of pool fees')).toBeInTheDocument()
  })

  it('does not report an unindexed launch as having no lock', async () => {
    // The failure mode being guarded is not a blank panel but a confident wrong one: "Term: none"
    // on a launch whose liquidity is in fact locked for a year.
    fetchToken.mockRejectedValue(new Error('ECONNREFUSED'))
    const { container } = await renderTokenPage()
    await screen.findByRole('button', { name: /^buy$/i })

    expect(container.textContent).not.toMatch(/Term.{0,12}none/i)
  })
})

describe('TokenPage - the live trade feed', () => {
  beforeEach(() => chainSays({ graduated: false }))

  it('lists trades newest first - the feed answers "what just happened"', async () => {
    const { container } = await renderTokenPage()
    await screen.findAllByText(/0x8Ec5…A80C/)

    // The subgraph returns trades ascending for the chart; the feed must invert that. t2 (SELL,
    // timestamp 1200) is newer than t1 (BUY, 1000), so it leads.
    const sides = [...container.querySelectorAll('.trade-side')].map((e) => e.textContent)
    expect(sides).toEqual(['sell', 'buy'])
  })

  it('degrades to a labelled notice rather than an empty list when the indexer is unreachable', async () => {
    fetchTrades.mockRejectedValue(new Error('ECONNREFUSED'))
    await renderTokenPage()
    await screen.findByRole('button', { name: /^buy$/i })

    expect(await screen.findByText(/trade feed unavailable/i)).toBeInTheDocument()
    // "No trades yet" would be a different and worse claim than "we cannot see the trades".
    expect(screen.queryByText(/no trades yet\. the first buy/i)).not.toBeInTheDocument()
  })

  it('still renders the trade panel while the feed is down (the Stage 2 split)', async () => {
    fetchTrades.mockRejectedValue(new Error('ECONNREFUSED'))
    await renderTokenPage()
    expect(await screen.findByRole('button', { name: /^buy$/i })).toBeInTheDocument()
  })
})
