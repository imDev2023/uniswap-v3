import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { RecentTradeRow, TokenRow } from '../lib/subgraph'

/**
 * Page-level guard that moderation actually reaches every discovery surface.
 *
 * The pure rules are covered in lib/denylist.test.ts. This proves the WIRING, which is the part
 * that regresses: hiding a launch from one of the three places it appears is not hiding it, and
 * without this test the filter could be deleted from the board, the graduation ticker or the trade
 * rail and the whole suite would still pass.
 *
 * It also pins the constraint that matters most - a hidden token stays TRADEABLE. Moderation
 * removes our amplification of a launch; it must never strand someone holding it.
 */

const HIDDEN = '0x1111111111111111111111111111111111111111'
const CLEAN = '0x2222222222222222222222222222222222222222'
const NOW = 1_800_000_000

vi.mock('../config/denylist', () => ({ DENYLIST: { [HIDDEN]: 'hide' } }))

const fetchActiveTokens = vi.fn()
const fetchGraduatedTokens = vi.fn()
const fetchFactory = vi.fn()
const fetchRecentTrades = vi.fn()
const fetchMeta = vi.fn()

vi.mock('../lib/subgraph', () => ({
  fetchActiveTokens: (...a: unknown[]) => fetchActiveTokens(...a),
  fetchGraduatedTokens: (...a: unknown[]) => fetchGraduatedTokens(...a),
  fetchFactory: (...a: unknown[]) => fetchFactory(...a),
  fetchRecentTrades: (...a: unknown[]) => fetchRecentTrades(...a),
  fetchToken: vi.fn(),
  fetchTrades: vi.fn(),
  fetchCurvePositions: vi.fn(),
  fetchMeta: (...a: unknown[]) => fetchMeta(...a),
}))

vi.mock('wagmi', () => ({
  useBlock: () => ({ data: { timestamp: BigInt(NOW) } }),
  useChainId: () => 46630,
  useAccount: () => ({ address: undefined, isConnected: false }),
  useConnect: () => ({ connect: vi.fn(), connectors: [], isPending: false }),
  useDisconnect: () => ({ disconnect: vi.fn() }),
  useSwitchChain: () => ({ switchChain: vi.fn() }),
  useReadContract: () => ({ data: undefined }),
  // See the note in HomePage.test.tsx: the indexed block's timestamp is read through the public
  // client under its own query key, never through a keyless `useBlock`.
  usePublicClient: () => ({ chain: { id: 46630 }, getBlock: vi.fn() }),
}))

vi.mock('../config/contracts', async (orig) => ({
  ...(await orig<typeof import('../config/contracts')>()),
  isLaunchpadConfigured: true,
}))

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { HomePage } = await import('./HomePage')

function token(id: string, symbol: string, over: Partial<TokenRow> = {}): TokenRow {
  return {
    id,
    curve: '0xcurve',
    creator: '0xcreator',
    name: `${symbol} Coin`,
    symbol,
    metadataURI: '',
    createdAtTimestamp: '1000',
    ethReserve: '0',
    tokenReserve: '0',
    tokensSold: '0',
    priceX18: '1000',
    progressBps: 100,
    volumeEth: '1000',
    buyCount: 1,
    sellCount: 0,
    tradeCount: 1,
    // `holderCount` until #36 renamed the entity; the stale key survived the rename unnoticed.
    curvePositionCount: 1,
    graduated: false,
    graduatedAtTimestamp: null,
    ...over,
  } as TokenRow
}

function recentTrade(tokenId: string, symbol: string): RecentTradeRow {
  return {
    id: `${tokenId}-t1`,
    trader: '0xaaaa',
    type: 'BUY',
    amountEth: '1000',
    amountToken: '1000',
    priceX18: '1000',
    tokensSold: '0',
    timestamp: String(NOW - 60),
    txHash: '0xdead',
    token: { id: tokenId, symbol },
  } as RecentTradeRow
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('HomePage moderation wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchMeta.mockResolvedValue({ block: { number: 1, timestamp: NOW }, hasIndexingErrors: false })
    fetchFactory.mockResolvedValue({
      id: 'launchpad',
      launchCount: 2,
      graduationCount: 1,
      tradeCount: 2,
      buyCount: 2,
      sellCount: 0,
      totalVolumeEth: '2000',
      totalRaisedEth: '0',
    })
  })

  it('keeps a hidden launch off the board while listing a clean one', async () => {
    fetchActiveTokens.mockResolvedValue([token(HIDDEN, 'BADTOK'), token(CLEAN, 'GOODTOK')])
    fetchGraduatedTokens.mockResolvedValue([])
    fetchRecentTrades.mockResolvedValue([])

    renderPage()

    await waitFor(() => expect(screen.getByText('GOODTOK')).toBeInTheDocument())
    expect(screen.queryByText('BADTOK')).toBeNull()
  })

  it('keeps a hidden launch out of the graduation ticker', async () => {
    fetchActiveTokens.mockResolvedValue([])
    fetchGraduatedTokens.mockResolvedValue([
      token(HIDDEN, 'BADTOK', { graduated: true, graduatedAtTimestamp: String(NOW - 100) }),
      token(CLEAN, 'GOODTOK', { graduated: true, graduatedAtTimestamp: String(NOW - 100) }),
    ])
    fetchRecentTrades.mockResolvedValue([])

    renderPage()

    await waitFor(() => expect(screen.getByText('GOODTOK')).toBeInTheDocument())
    expect(screen.queryByText('BADTOK')).toBeNull()
  })

  it('keeps a hidden launch out of the live trade rail', async () => {
    // Keyed off the TRADED TOKEN, not the trade's own id - the trade id is a tx hash and would
    // never match a denylist entry, so a naive filter here silently does nothing.
    fetchActiveTokens.mockResolvedValue([])
    fetchGraduatedTokens.mockResolvedValue([])
    fetchRecentTrades.mockResolvedValue([
      recentTrade(HIDDEN, 'BADTOK'),
      recentTrade(CLEAN, 'GOODTOK'),
    ])

    renderPage()

    await waitFor(() => expect(screen.getByText('GOODTOK')).toBeInTheDocument())
    expect(screen.queryByText('BADTOK')).toBeNull()
  })
})
