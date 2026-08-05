import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { RecentTradeRow, TokenRow } from '../lib/subgraph'

// Page-level guard for the build #28 board.
//
// The pure tests (lib/board.test.ts, lib/heat.test.ts) prove the sort and heat logic. This proves
// the WIRING: that the board actually leads the page, that the sort control is connected to the
// rendered order, and that each indexer-derived panel degrades to a labelled notice rather than to
// an empty region. Without it, someone could reinstate the old graduated-cards-first layout, or
// wire the sort buttons to nothing, and every other test would still pass.

const SUBGRAPH_DOWN = new Error('fetch failed: ECONNREFUSED')

const fetchActiveTokens = vi.fn()
const fetchGraduatedTokens = vi.fn()
const fetchFactory = vi.fn()
const fetchRecentTrades = vi.fn()
const fetchMeta = vi.fn()

/** Chain head used by both the indexer-health mock and the subgraph meta fixture. */
const NOW = 1_800_000_000

vi.mock('../lib/subgraph', () => ({
  fetchActiveTokens: (...a: unknown[]) => fetchActiveTokens(...a),
  fetchGraduatedTokens: (...a: unknown[]) => fetchGraduatedTokens(...a),
  fetchFactory: (...a: unknown[]) => fetchFactory(...a),
  fetchRecentTrades: (...a: unknown[]) => fetchRecentTrades(...a),
  fetchToken: vi.fn(),
  fetchTrades: vi.fn(),
  fetchHolders: vi.fn(),
  fetchMeta: (...a: unknown[]) => fetchMeta(...a),
}))

// The rail now diagnoses WHY the feed is missing rather than asserting the indexer is unreachable
// for any failure, so the page reads indexer health, which reads the chain head through wagmi.
vi.mock('wagmi', () => ({
  useBlock: () => ({ data: { timestamp: BigInt(NOW) } }),
  useChainId: () => 46630,
  useAccount: () => ({ address: undefined, isConnected: false }),
  useConnect: () => ({ connect: vi.fn(), connectors: [], isPending: false }),
  useDisconnect: () => ({ disconnect: vi.fn() }),
  useSwitchChain: () => ({ switchChain: vi.fn() }),
}))

vi.mock('../config/contracts', async (orig) => ({
  ...(await orig<typeof import('../config/contracts')>()),
  isLaunchpadConfigured: true,
}))

function token(over: Partial<TokenRow> & { id: string; symbol: string }): TokenRow {
  return {
    curve: '0xcurve',
    creator: '0xcreator',
    // Empty is the common case: v1 is bring-your-own-URI and most launches carry no URI.
    metadataURI: '',
    // Distinct from the symbol so a query for "RDOGE" matches the symbol element alone - a card
    // renders both, and identical values make every text query ambiguous.
    name: `${over.symbol} Coin`,
    createdAtTimestamp: '1000',
    ethReserve: '0',
    tokenReserve: '0',
    tokensSold: '0',
    // The no-dev-allocation case; #34 made this per launch.
    curveTokenAllocation: '800000000000000000000000000',
    priceX18: '31249999',
    progressBps: 0,
    volumeEth: '0',
    buyCount: 0,
    sellCount: 0,
    tradeCount: 1,
    curvePositionCount: 1,
    graduated: false,
    graduatedAtTimestamp: null,
    ...over,
  }
}

// Mirrors the seeded testnet spread: a nearly-full curve, a mid one, and an untraded one.
const LIVE: TokenRow[] = [
  token({ id: '0xa', symbol: 'RDOGE', progressBps: 9_600, createdAtTimestamp: '100', volumeEth: '86500000000000000' }),
  token({ id: '0xb', symbol: 'DIAMOND', progressBps: 5_800, createdAtTimestamp: '200', volumeEth: '25900000000000000' }),
  token({ id: '0xc', symbol: 'QUIET', progressBps: 0, createdAtTimestamp: '300', volumeEth: '0', tradeCount: 0, curvePositionCount: 0 }),
]

const GRADUATED: TokenRow[] = [
  token({ id: '0xd', symbol: 'SEND', progressBps: 10_000, graduated: true, graduatedAtTimestamp: '400', volumeEth: '101000000000000000' }),
]

const TRADES: RecentTradeRow[] = [
  {
    id: '0xt1',
    trader: '0xtrader',
    type: 'BUY',
    amountEth: '17100000000000000',
    amountToken: '1000',
    priceX18: '71199715',
    tokensSold: '1000',
    timestamp: '900',
    txHash: '0xtx',
    token: { id: '0xe', symbol: 'BOOTS' },
  },
]

async function renderHome() {
  const { HomePage } = await import('./HomePage')
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** Symbols in the order the board renders them. */
function boardOrder(): string[] {
  return screen
    .getAllByRole('link')
    .map((el) => el.querySelector('.tcard-symbol')?.textContent ?? '')
    .filter(Boolean)
}

describe('HomePage board', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchActiveTokens.mockResolvedValue(LIVE)
    fetchGraduatedTokens.mockResolvedValue(GRADUATED)
    fetchRecentTrades.mockResolvedValue(TRADES)
    fetchFactory.mockResolvedValue({
      id: 'launchpad',
      launchCount: 12,
      graduationCount: 2,
      tradeCount: 23,
      buyCount: 21,
      sellCount: 2,
      totalVolumeEth: '473674069667208930',
      totalRaisedEth: '202000000000000000',
    })
  })

  it('leads with the live board, not with graduated tokens', async () => {
    await renderHome()
    await screen.findByText('RDOGE')

    // The pre-#28 layout put a grid of graduated CARDS above the live curves. Graduations now
    // appear only in the ticker, so no graduated token may render as a board card.
    expect(boardOrder()).not.toContain('SEND')
    expect(screen.getByRole('heading', { name: /live curves/i })).toBeInTheDocument()
  })

  it('shows graduations in the ticker', async () => {
    const { container } = await renderHome()
    expect(await screen.findByText('SEND')).toBeInTheDocument()
    // Scoped to the ticker: "Graduated" is also a masthead stat label.
    const ticker = container.querySelector('.ticker')
    expect(ticker).not.toBeNull()
    expect(within(ticker as HTMLElement).getByText('SEND')).toBeInTheDocument()
  })

  it('defaults to newest-first', async () => {
    await renderHome()
    await screen.findByText('RDOGE')
    expect(boardOrder()).toEqual(['QUIET', 'DIAMOND', 'RDOGE'])
  })

  it('reorders the board when a sort is chosen', async () => {
    await renderHome()
    await screen.findByText('RDOGE')

    fireEvent.click(screen.getByRole('button', { name: 'Closest' }))
    expect(boardOrder()).toEqual(['RDOGE', 'DIAMOND', 'QUIET'])

    fireEvent.click(screen.getByRole('button', { name: 'Volume' }))
    expect(boardOrder()).toEqual(['RDOGE', 'DIAMOND', 'QUIET'])

    fireEvent.click(screen.getByRole('button', { name: 'New' }))
    expect(boardOrder()).toEqual(['QUIET', 'DIAMOND', 'RDOGE'])
  })

  it('re-queries the server when the sort changes, rather than reshuffling one page', async () => {
    await renderHome()
    await screen.findByText('RDOGE')
    expect(fetchActiveTokens).toHaveBeenCalledWith(50, 'createdAtTimestamp')

    fireEvent.click(screen.getByRole('button', { name: 'Closest' }))
    // The board is paged: without a server-side orderBy, a 95% curve outside the newest page could
    // never appear under "Closest" no matter how the client sorts.
    await waitFor(() => expect(fetchActiveTokens).toHaveBeenCalledWith(50, 'progressBps'))

    fireEvent.click(screen.getByRole('button', { name: 'Volume' }))
    await waitFor(() => expect(fetchActiveTokens).toHaveBeenCalledWith(50, 'volumeEth'))

    fireEvent.click(screen.getByRole('button', { name: 'Busiest' }))
    await waitFor(() => expect(fetchActiveTokens).toHaveBeenCalledWith(50, 'tradeCount'))
  })

  it('keeps graduations visible as a labelled notice when only that query fails', async () => {
    fetchGraduatedTokens.mockRejectedValue(SUBGRAPH_DOWN)
    await renderHome()
    await screen.findByText('RDOGE')
    // Vanishing silently would claim nothing has ever graduated.
    expect(await screen.findByText(/unavailable - the indexer is unreachable/i)).toBeInTheDocument()
  })

  it('marks the active sort for assistive tech, not just visually', async () => {
    await renderHome()
    await screen.findByText('RDOGE')
    expect(screen.getByRole('button', { name: 'New' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Busiest' }))
    expect(screen.getByRole('button', { name: 'Busiest' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'New' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('distinguishes a never-traded launch from one with a tiny position', async () => {
    await renderHome()
    await screen.findByText('QUIET')
    // The untraded card must not read as "0% to graduation, 0 ETH volume", which looks broken.
    expect(screen.getByText(/not traded yet/i)).toBeInTheDocument()

    // Scoped to the card: "New" is also the default sort button's label.
    const card = screen.getByText('QUIET').closest('.tcard') as HTMLElement
    expect(within(card).getByText('New')).toBeInTheDocument()
    // ...and it shows when it launched instead of a meaningless 0 ETH volume.
    expect(within(card).getByText(/launched/i)).toBeInTheDocument()
  })

  it('renders prices without exponential notation', async () => {
    await renderHome()
    await screen.findByText('RDOGE')
    expect(screen.queryByText(/e-\d+/)).not.toBeInTheDocument()
  })

  it('degrades the board to a labelled notice when the indexer is down', async () => {
    fetchActiveTokens.mockRejectedValue(SUBGRAPH_DOWN)
    await renderHome()

    // Says what broke AND that trading still works - an empty grid would imply "nothing launched".
    expect(await screen.findByText(/can.t reach the indexer/i)).toBeInTheDocument()
    expect(screen.getByText(/trading is unaffected/i)).toBeInTheDocument()
  })

  it('degrades the trade rail independently of the board', async () => {
    fetchRecentTrades.mockRejectedValue(SUBGRAPH_DOWN)
    await renderHome()
    await screen.findByText('RDOGE')

    const rail = screen.getByRole('complementary', { name: /recent trades/i })
    expect(within(rail).getByText(/trade feed unavailable/i)).toBeInTheDocument()
    // The board itself is untouched by the rail's failure.
    expect(boardOrder()).toEqual(['QUIET', 'DIAMOND', 'RDOGE'])
  })

  it('does not blame the indexer when the indexer is demonstrably healthy', async () => {
    // The rail used to assert "the indexer is unreachable" for ANY failure of the trades query.
    // Here the indexer is provably fine - its indexed head is level with the chain head - and only
    // this one query failed. Blaming the indexer would state something the page can see is false,
    // the same class of confident wrong claim as a chart carrying a stale price. It must diagnose,
    // not guess: the feed is missing, and trading is unaffected.
    fetchMeta.mockResolvedValue({ block: { number: 100, timestamp: NOW }, hasIndexingErrors: false })
    fetchRecentTrades.mockRejectedValue(SUBGRAPH_DOWN)
    await renderHome()
    await screen.findByText('RDOGE')

    const rail = screen.getByRole('complementary', { name: /recent trades/i })
    await waitFor(() =>
      expect(within(rail).queryByText(/indexer is unreachable/i)).not.toBeInTheDocument(),
    )
    expect(within(rail).getByText(/trading still works/i)).toBeInTheDocument()
  })

  it('says the board is empty rather than rendering a bare grid', async () => {
    fetchActiveTokens.mockResolvedValue([])
    await renderHome()
    expect(await screen.findByText(/no live curves yet/i)).toBeInTheDocument()
  })
})
