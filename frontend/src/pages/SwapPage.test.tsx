import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

// The Stage 2 guarantee, asserted at the page level: with the SUBGRAPH DOWN, the swap page must
// still resolve its pool from RPC and render a trade panel.
//
// The pure resolver tests (lib/onchainToken.test.ts) prove the decision table; this proves the
// WIRING - that the page reads the pool from the chain and not from an indexed entity. Without it,
// a future edit could reintroduce `token.graduation.pool` and every other test would still pass.

const POOL = '0xDC27FeCB8589c0FB0328fd98963c823a1681E933'
const CURVE = '0x81a14013d3F048BcBe4AF0fB8b88aF0ec25D799a'
const TOKEN = '0x52eEF29c3c869B4D04F3c1451b16548DEAA923bE'
const V3FACTORY = '0x158a14f6Aa8C86921e624e3ed0526F31520cB2BD'

// Every subgraph fetcher rejects, exactly as it does when graph-node is stopped.
const SUBGRAPH_DOWN = new Error('fetch failed: ECONNREFUSED')
vi.mock('../lib/subgraph', () => ({
  fetchToken: vi.fn(() => Promise.reject(SUBGRAPH_DOWN)),
  fetchTrades: vi.fn(() => Promise.reject(SUBGRAPH_DOWN)),
  fetchCurvePositions: vi.fn(() => Promise.reject(SUBGRAPH_DOWN)),
  fetchActiveTokens: vi.fn(() => Promise.reject(SUBGRAPH_DOWN)),
  fetchGraduatedTokens: vi.fn(() => Promise.reject(SUBGRAPH_DOWN)),
  fetchFactory: vi.fn(() => Promise.reject(SUBGRAPH_DOWN)),
  fetchMeta: vi.fn(() => Promise.reject(SUBGRAPH_DOWN)),
}))

// Stand in for the chain: round 1 then round 2 of useOnchainToken, both succeeding.
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
  SWAP_ROUTER_ADDRESS: '0x4507B2864CEcaBE10330d927c9608AA55A00fFD3',
  isLaunchpadConfigured: true,
  isSwapConfigured: true,
  isQuoterConfigured: false,
}))

function ok(result: unknown) {
  return { status: 'success' as const, result }
}

/** Answer whichever round useOnchainToken is asking for, by its contract shape. */
function chainIsUp() {
  readContractsMock.mockImplementation((cfg: { contracts: { functionName: string }[] }) => {
    const fns = cfg.contracts.map((c) => c.functionName)
    if (fns.includes('curveOf')) {
      return { data: [ok(CURVE), ok(V3FACTORY), ok('Meta Test'), ok('META')], isError: false }
    }
    return { data: [ok(true), ok(POOL)], isError: false }
  })
}

async function renderSwapPage() {
  const { SwapPage } = await import('./SwapPage')
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/swap/${TOKEN}`]}>
        <Routes>
          <Route path="/swap/:address" element={<SwapPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('SwapPage with the indexer down', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    chainIsUp()
  })

  it('still resolves the pool address from RPC', async () => {
    await renderSwapPage()
    // The pool is rendered short-form; this is the address the subgraph used to supply.
    expect(await screen.findByText(/0xDC27…E933/)).toBeInTheDocument()
  })

  it('still renders the swap panel rather than a "not found" dead end', async () => {
    await renderSwapPage()
    expect(await screen.findByRole('heading', { name: /swap meta \/ eth/i })).toBeInTheDocument()
    // The pre-Stage-2 failure mode.
    expect(screen.queryByText(/not found in the index/i)).not.toBeInTheDocument()
  })

  it('drops only the indexed garnish, not the page', async () => {
    await renderSwapPage()
    await screen.findByRole('heading', { name: /swap meta \/ eth/i })
    // "N ETH seeded" is the one subgraph-sourced fragment on this page.
    expect(screen.queryByText(/ETH seeded/i)).not.toBeInTheDocument()
    // Everything in the pool-facts panel is RPC-derived, so it must survive the outage intact.
    expect(screen.getByText('Locked')).toBeInTheDocument()
    expect(screen.getByText(/pool fee/i)).toBeInTheDocument()
  })

  it('never asks the subgraph for anything the trade path needs', async () => {
    const subgraph = await import('../lib/subgraph')
    await renderSwapPage()
    await screen.findByRole('heading', { name: /swap meta \/ eth/i })
    // fetchToken may be called for the garnish, but the page must have rendered without its result.
    // The real assertion is above: pool + panel present while every fetcher rejects.
    expect(vi.mocked(subgraph.fetchTrades)).not.toHaveBeenCalled()
    expect(vi.mocked(subgraph.fetchCurvePositions)).not.toHaveBeenCalled()
  })
})

describe('SwapPage when the CHAIN is down', () => {
  beforeEach(() => vi.clearAllMocks())

  it('says the RPC is unreachable instead of spinning forever', async () => {
    // viem maps a transport failure onto each entry; react-query also flags isError. Both set.
    readContractsMock.mockReturnValue({
      data: [
        { status: 'failure', error: new Error('HTTP 503') },
        { status: 'failure', error: new Error('HTTP 503') },
        { status: 'failure', error: new Error('HTTP 503') },
        { status: 'failure', error: new Error('HTTP 503') },
      ],
      isError: true,
    })
    await renderSwapPage()
    expect(await screen.findByText(/couldn’t reach the chain/i)).toBeInTheDocument()
    expect(screen.queryByText(/loading token/i)).not.toBeInTheDocument()
  })
})
