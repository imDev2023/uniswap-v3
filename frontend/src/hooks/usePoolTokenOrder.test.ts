import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { usePoolTokenOrder } from './usePoolTokenOrder'

const readContracts = vi.fn()
vi.mock('wagmi', () => ({
  useReadContracts: (...a: unknown[]) => readContracts(...a),
}))

const TOKEN = '0x1111111111111111111111111111111111111111' as const
const WETH = '0x8888888888888888888888888888888888888888' as const
const POOL = '0x6666666666666666666666666666666666666666' as const

function mockToken0(addr: string | undefined, status: 'success' | 'failure' = 'success') {
  readContracts.mockReturnValue({
    data: addr === undefined ? undefined : [{ status, result: addr }],
  })
}

beforeEach(() => readContracts.mockReset())

describe('usePoolTokenOrder', () => {
  it('is true when the launch token is the pool token0', () => {
    mockToken0(TOKEN)
    const { result } = renderHook(() => usePoolTokenOrder(POOL, TOKEN))
    expect(result.current).toBe(true)
  })

  it('is false when the launch token is token1', () => {
    mockToken0(WETH)
    const { result } = renderHook(() => usePoolTokenOrder(POOL, TOKEN))
    expect(result.current).toBe(false)
  })

  it('⚠️ compares case-insensitively, because the two addresses arrive in different casings', () => {
    // ⚠️ This fixture must contain hex LETTERS. An all-digit address like TOKEN above is unchanged
    // by any case operation, so the same test written against it passes against a case-SENSITIVE
    // comparison too - confirmed by mutation. viem returns checksummed addresses from a contract
    // read, while a token address taken from a route param arrives lowercased.
    const mixed = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01'
    mockToken0(mixed)

    const { result } = renderHook(() =>
      usePoolTokenOrder(POOL, mixed.toLowerCase() as `0x${string}`),
    )
    expect(result.current).toBe(true)
  })

  it('⚠️ is undefined until the read lands, never a guessed default', () => {
    // Defaulting to token0 would be right about half the time and confidently wrong the rest, which
    // is worse than reporting nothing: every amount downstream would be labelled with the wrong asset.
    mockToken0(undefined)
    const { result } = renderHook(() => usePoolTokenOrder(POOL, TOKEN))
    expect(result.current).toBeUndefined()
  })

  it('is undefined when the call failed', () => {
    mockToken0(TOKEN, 'failure')
    const { result } = renderHook(() => usePoolTokenOrder(POOL, TOKEN))
    expect(result.current).toBeUndefined()
  })

  it('does not read before the pool is known', () => {
    mockToken0(undefined)
    renderHook(() => usePoolTokenOrder(undefined, TOKEN))
    expect(readContracts.mock.calls[0][0].query.enabled).toBe(false)
  })
})
