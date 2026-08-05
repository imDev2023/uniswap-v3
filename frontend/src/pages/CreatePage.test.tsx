import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// #37's first job, and it is a live defect rather than a feature: `CreatePage` HARDCODED
// `permanentLock: false` and `devAllocationBps: 0` into every `createLaunch` it sent. The ABI
// carried both fields, so nothing errored and nothing was missing on screen - the creator was
// simply never asked, and silently took no carve and no permanent lock.
//
// These tests assert on the ARGUMENTS actually handed to `writeContract`, because that is the only
// place the defect was visible. A test that checked the controls render would have passed against
// the broken build the moment the controls existed but stayed unwired.

const CREATION_FEE = 10_000_000_000_000_000n
const CURVE_SUPPLY = 800_000_000n * 10n ** 18n

const writeContract = vi.fn()
const readContractsMock = vi.fn()

vi.mock('wagmi', () => ({
  // `chainId` lives on useAccount, not on useChainId - useWrongChain reads it from there, and
  // omitting it renders the whole form behind a "switch chain" button with no submit at all.
  useAccount: () => ({
    address: '0x8Ec5f1e04531416d337E61733DfC5d1685D9A80C',
    isConnected: true,
    chainId: 46630,
  }),
  useReadContract: () => ({ data: CREATION_FEE }),
  useReadContracts: (...a: unknown[]) => readContractsMock(...a),
  useWriteContract: () => ({ writeContract, data: undefined, isPending: false, reset: vi.fn() }),
  useWaitForTransactionReceipt: () => ({ data: undefined, isLoading: false }),
  useChainId: () => 46630,
  useConnect: () => ({ connect: vi.fn(), connectors: [], isPending: false }),
  useDisconnect: () => ({ disconnect: vi.fn() }),
  useSwitchChain: () => ({ switchChain: vi.fn() }),
}))

vi.mock('../config/contracts', async (orig) => ({
  ...(await orig<typeof import('../config/contracts')>()),
  FACTORY_ADDRESS: '0x632FD8713356aCc4ec9BdC6b378c05707bc9D1E7',
  isLaunchpadConfigured: true,
}))

function ok(result: unknown) {
  return { status: 'success' as const, result }
}

/**
 * Answer the terms read. Every one of these is owner-tunable and future-only, so the form must take
 * them from here rather than from a literal - which is what the non-default values in the tests
 * below are for.
 */
function factoryTerms({
  maxDevBps = 500,
  lockDuration = 31_536_000n,
  vestingDuration = 2_592_000n,
  creatorFeeBps = 7000,
} = {}) {
  readContractsMock.mockReturnValue({
    data: [
      ok(maxDevBps),
      ok(lockDuration),
      ok(vestingDuration),
      ok(creatorFeeBps),
      ok(CURVE_SUPPLY),
    ],
  })
}

async function renderCreatePage() {
  const { CreatePage } = await import('./CreatePage')
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CreatePage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** Fill the two required fields and tick the irreversibility acknowledgement. */
function fillRequired() {
  fireEvent.change(screen.getByLabelText(/token name/i), { target: { value: 'Robinhood Doge' } })
  fireEvent.change(screen.getByLabelText(/^symbol$/i), { target: { value: 'RDOGE' } })
  fireEvent.click(screen.getByRole('checkbox', { name: /fixed at creation/i }))
}

function lastArgs() {
  const calls = writeContract.mock.calls
  const call = calls[calls.length - 1]
  if (!call) throw new Error('writeContract was never called')
  return call[0].args[0] as {
    name: string
    symbol: string
    metadataURI: string
    permanentLock: boolean
    devAllocationBps: number
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  factoryTerms()
})

describe('CreatePage sends the creator’s actual choices', () => {
  it('sends the chosen dev allocation, not a hardcoded 0', async () => {
    await renderCreatePage()
    fillRequired()
    fireEvent.change(screen.getByLabelText(/creator allocation/i), { target: { value: '250' } })
    fireEvent.click(screen.getByRole('button', { name: /launch token/i }))

    expect(lastArgs().devAllocationBps).toBe(250)
  })

  it('sends the chosen permanent lock, not a hardcoded false', async () => {
    await renderCreatePage()
    fillRequired()
    fireEvent.click(screen.getByRole('checkbox', { name: /lock the liquidity permanently/i }))
    fireEvent.click(screen.getByRole('button', { name: /launch token/i }))

    expect(lastArgs().permanentLock).toBe(true)
  })

  it('still sends zero and false when the creator changes nothing', async () => {
    // The defaults must remain the reversible, no-pre-mine case - the launch a creator got before
    // #34. This is the assertion that would fail if a control defaulted to something generous.
    await renderCreatePage()
    fillRequired()
    fireEvent.click(screen.getByRole('button', { name: /launch token/i }))

    expect(lastArgs().devAllocationBps).toBe(0)
    expect(lastArgs().permanentLock).toBe(false)
  })
})

describe('CreatePage reads its bounds from the chain', () => {
  it('caps the allocation at the owner’s CURRENT maximum, not at 5%', async () => {
    // ⚠️ `maxDevAllocationBps` is owner-tunable and future-only, and the whole point of that design
    // is that a retune costs a transaction rather than a frontend deploy. A form with `500` baked in
    // would keep offering 5% after the owner lowered the ceiling - and every such launch reverts.
    factoryTerms({ maxDevBps: 300 })
    await renderCreatePage()
    fillRequired()

    const slider = screen.getByLabelText(/creator allocation/i) as HTMLInputElement
    expect(slider.max).toBe('300')

    // Even if a value above the ceiling reaches the control, what is SENT is clamped.
    fireEvent.change(slider, { target: { value: '500' } })
    fireEvent.click(screen.getByRole('button', { name: /launch token/i }))
    expect(lastArgs().devAllocationBps).toBe(300)
  })

  it('offers no allocation control at all when the owner has turned the pre-mine off', async () => {
    // Setting the maximum to 0 is the documented way to retire the pre-mine without a redeploy.
    // A slider pinned at 0% would imply the feature exists and is merely unattractive.
    factoryTerms({ maxDevBps: 0 })
    await renderCreatePage()
    expect(screen.queryByLabelText(/creator allocation/i)).not.toBeInTheDocument()
    expect(screen.getByText(/not currently allowing any creator allocation/i)).toBeInTheDocument()

    fillRequired()
    fireEvent.click(screen.getByRole('button', { name: /launch token/i }))
    expect(lastArgs().devAllocationBps).toBe(0)
  })

  it('distinguishes an UNREAD bound from a bound the owner set to zero', async () => {
    // ⚠️ These are not the same answer, and collapsing them recreates the exact defect this ticket
    // exists to fix: the form renders with no carve control, submits `devAllocationBps: 0`, and
    // never tells the creator the option existed - only now with a failed RPC read as the trigger
    // instead of a hardcoded literal. The carve cannot be added after creation, so silence here is
    // as permanent as the hardcoded zero was.
    readContractsMock.mockReturnValue({
      data: [
        { status: 'failure' as const },
        ok(31_536_000n),
        ok(2_592_000n),
        ok(7000),
        ok(CURVE_SUPPLY),
      ],
    })
    await renderCreatePage()

    expect(screen.queryByLabelText(/creator allocation/i)).not.toBeInTheDocument()
    expect(screen.getByText(/could not be read from the launchpad/i)).toBeInTheDocument()
    // And it must not be phrased as the owner having disallowed it, which is a different fact.
    expect(screen.queryByText(/not currently allowing/i)).not.toBeInTheDocument()
  })

  it('quotes the owner’s current lock term rather than the word "year"', async () => {
    factoryTerms({ lockDuration: 2_592_000n })
    await renderCreatePage()
    expect(screen.getByText(/30 days/)).toBeInTheDocument()
  })

  it('quotes the owner’s current creator fee share', async () => {
    factoryTerms({ creatorFeeBps: 5000 })
    await renderCreatePage()
    expect(screen.getByText('50%')).toBeInTheDocument()
  })
})

describe('CreatePage guards what cannot be undone', () => {
  it('refuses to submit a metadata URI the read side would silently drop', async () => {
    await renderCreatePage()
    fillRequired()
    fireEvent.change(screen.getByRole('textbox', { name: /metadata uri/i }), {
      target: { value: 'ipfs//QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG' },
    })

    expect(screen.getByRole('button', { name: /launch token/i })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /launch token/i }))
    expect(writeContract).not.toHaveBeenCalled()
  })

  it('still allows an empty URI, which is the common case', async () => {
    await renderCreatePage()
    fillRequired()
    fireEvent.click(screen.getByRole('button', { name: /launch token/i }))
    expect(lastArgs().metadataURI).toBe('')
  })

  it('will not launch until the irreversibility is acknowledged', async () => {
    // Both new choices are terminal and neither has a setter, for anyone, ever.
    await renderCreatePage()
    fireEvent.change(screen.getByLabelText(/token name/i), { target: { value: 'Robinhood Doge' } })
    fireEvent.change(screen.getByLabelText(/^symbol$/i), { target: { value: 'RDOGE' } })

    expect(screen.getByRole('button', { name: /launch token/i })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /launch token/i }))
    expect(writeContract).not.toHaveBeenCalled()
  })

  it('stops the name input at the length the contract accepts', async () => {
    // The input capped at 40 while validation rejected above 32, so eight characters could be typed
    // into a field that had already gone invalid.
    await renderCreatePage()
    const name = screen.getByLabelText(/token name/i) as HTMLInputElement
    expect(name.maxLength).toBe(32)
  })

  it('tells the creator the allocation only releases at graduation', async () => {
    // ⚠️ The single most consequential thing about the carve (ADR-0007): most launches never
    // graduate, and a creator who assumes a clock starts at creation has misread the offer.
    await renderCreatePage()
    fireEvent.change(screen.getByLabelText(/creator allocation/i), { target: { value: '500' } })
    expect(screen.getByText(/at graduation/i)).toBeInTheDocument()
    expect(screen.getByText(/never graduates/i)).toBeInTheDocument()
  })

  it('says a permanent lock is terminal, before it can be submitted', async () => {
    await renderCreatePage()
    fireEvent.click(screen.getByRole('checkbox', { name: /lock the liquidity permanently/i }))
    expect(screen.getByText(/terminal and cannot be undone/i)).toBeInTheDocument()
  })
})
