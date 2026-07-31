import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

/**
 * Guards the two things about metadata resolution that would silently regress.
 *
 * 1. **It is read over RPC, not from the subgraph.** That is the Stage 2 claim the token and swap
 *    pages make in their comments, and the only reason a launch keeps its identity through an
 *    indexer outage. A refactor that "simplified" this to a subgraph field would pass every other
 *    test while quietly re-coupling identity to the indexer.
 * 2. **No request is made when there is nothing fetchable**, which is the common case: v1 is
 *    bring-your-own-URI and most launches carry no URI at all. Fetching anyway would put a doomed
 *    request per card on a public gateway for every board render.
 */

const readContract = vi.fn()
vi.mock('wagmi', () => ({ useReadContract: (...a: unknown[]) => readContract(...a) }))

const DENIED = '0x9999999999999999999999999999999999999999'
vi.mock('../config/denylist', () => ({ DENYLIST: { [DENIED]: 'image' } }))

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { useOnchainMetadataUri, useTokenMetadata } = await import('./useTokenMetadata')

const TOKEN = '0x1111111111111111111111111111111111111111'
const CID = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku'

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

describe('useOnchainMetadataUri', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reads metadataURI from the TOKEN CONTRACT, not from the subgraph', async () => {
    readContract.mockReturnValue({ data: `ipfs://${CID}` })
    const { result } = renderHook(() => useOnchainMetadataUri(TOKEN), { wrapper })

    expect(result.current).toBe(`ipfs://${CID}`)
    const call = readContract.mock.calls[0][0]
    expect(call.address).toBe(TOKEN)
    expect(call.functionName).toBe('metadataURI')
    // Immutable on-chain, so it must never be refetched.
    expect(call.query.staleTime).toBe(Infinity)
  })

  it('does not read before a token address is known', () => {
    readContract.mockReturnValue({ data: undefined })
    renderHook(() => useOnchainMetadataUri(undefined), { wrapper })
    expect(readContract.mock.calls[0][0].query.enabled).toBe(false)
  })
})

describe('useTokenMetadata', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  it('makes no request when the launch has no URI, which is the common case', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { result } = renderHook(() => useTokenMetadata(TOKEN, ''), { wrapper })
    await waitFor(() => expect(result.current).toBeNull())
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('makes no request for a URI no gateway could serve', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { result } = renderHook(() => useTokenMetadata(TOKEN, 'http://insecure.example/m.json'), {
      wrapper,
    })
    await waitFor(() => expect(result.current).toBeNull())
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('never fetches a denylisted token, and never returns metadata for one', async () => {
    // Not merely an optimisation: fetching would put a request for content we have judged abusive
    // onto a third-party gateway on every single page view.
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { result } = renderHook(() => useTokenMetadata(DENIED, `ipfs://${CID}`), { wrapper })
    await waitFor(() => expect(result.current).toBeNull())
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('resolves a real document through the gateway', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ name: 'Octo', image: `ipfs://${CID}` })),
    } as unknown as Response)

    const { result } = renderHook(() => useTokenMetadata(TOKEN, `ipfs://${CID}`), { wrapper })
    await waitFor(() => expect(result.current?.name).toBe('Octo'))
    expect(result.current?.image).toBe(`https://dweb.link/ipfs/${CID}`)
  })
})
