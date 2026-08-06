import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useClaimableFees } from './useClaimableFees'

// ⚠️ The accrued read goes through the PUBLIC client, deliberately NOT `useSimulateContract`, which
// requires a connected wallet and threw `ConnectorNotConnectedError` for every disconnected visitor.
const publicClient = { simulateContract: vi.fn() }
vi.mock('wagmi', () => ({
  usePublicClient: () => publicClient,
}))

const query = vi.fn()
vi.mock('@tanstack/react-query', () => ({
  useQuery: (...a: unknown[]) => query(...a),
}))

const poolOrder = vi.fn()
vi.mock('./usePoolTokenOrder', () => ({
  usePoolTokenOrder: (...a: unknown[]) => poolOrder(...a),
}))

const LPLOCK = '0x0000000000000000000000000000000000000042'
vi.mock('./usePeriphery', () => ({
  usePeriphery: () => ({ lpLock: LPLOCK, devVesting: undefined, graduationManager: undefined }),
}))

const TOKEN = '0x1111111111111111111111111111111111111111' as const
const POOL = '0x6666666666666666666666666666666666666666' as const

/** The gross `(amount0, amount1)` a simulated `collect` would return, in the POOL's ordering. */
function mockGross(result: readonly [bigint, bigint] | undefined, isError = false) {
  query.mockReturnValue({ data: result, isError })
}

beforeEach(() => {
  query.mockReset()
  poolOrder.mockReset()
  poolOrder.mockReturnValue(true)
})

describe('useClaimableFees', () => {
  it('splits the gross simulated collection into the creator and treasury shares', () => {
    mockGross([1000n, 500n])

    const { result } = renderHook(() => useClaimableFees(77n, POOL, TOKEN, 7000))

    expect(result.current.creatorToken).toBe(700n)
    expect(result.current.creatorWeth).toBe(350n)
    expect(result.current.treasuryToken).toBe(300n)
    expect(result.current.treasuryWeth).toBe(150n)
  })

  it('⚠️ attributes the two amounts by the POOL ordering, not by position', () => {
    // When the launch token sorts ABOVE WETH it is token1, and an attribution that ignored this
    // would report the creator's WETH as launch tokens: right shape, wrong asset, wrong by orders of
    // magnitude. `CLAIM` really is token1 in its own pool, so this is the live case, not the edge.
    poolOrder.mockReturnValue(false)
    mockGross([500n, 1000n]) // amount0 is WETH here, amount1 is the launch token

    const { result } = renderHook(() => useClaimableFees(77n, POOL, TOKEN, 7000))

    expect(result.current.creatorToken).toBe(700n)
    expect(result.current.creatorWeth).toBe(350n)
  })

  it('⚠️ an unread simulation is undefined, never zero', () => {
    // Zero accrued is a real and common answer, so the unread state has to be distinguishable.
    mockGross(undefined)

    const { result } = renderHook(() => useClaimableFees(77n, POOL, TOKEN, 7000))

    expect(result.current.creatorToken).toBeUndefined()
    expect(result.current.creatorWeth).toBeUndefined()
  })

  it('⚠️ an unread pool ordering yields undefined rather than a guessed attribution', () => {
    poolOrder.mockReturnValue(undefined)
    mockGross([1000n, 500n])

    const { result } = renderHook(() => useClaimableFees(77n, POOL, TOKEN, 7000))

    expect(result.current.creatorToken).toBeUndefined()
  })

  it('⚠️ an unread fee share yields undefined rather than splitting at zero', () => {
    // A zero bps would report the creator's accrued fees as nothing while the treasury took it all.
    mockGross([1000n, 500n])

    const { result } = renderHook(() => useClaimableFees(77n, POOL, TOKEN, undefined))

    expect(result.current.creatorToken).toBeUndefined()
  })

  it('reports a failed simulation as an error rather than as nothing owed', () => {
    mockGross(undefined, true)

    const { result } = renderHook(() => useClaimableFees(77n, POOL, TOKEN, 7000))

    expect(result.current.isError).toBe(true)
    expect(result.current.creatorToken).toBeUndefined()
  })

  it('passes a genuine zero through as zero', () => {
    mockGross([0n, 0n])

    const { result } = renderHook(() => useClaimableFees(77n, POOL, TOKEN, 7000))

    expect(result.current.creatorToken).toBe(0n)
    expect(result.current.creatorWeth).toBe(0n)
  })

  it('does not read before the position exists', () => {
    mockGross(undefined)

    renderHook(() => useClaimableFees(undefined, POOL, TOKEN, 7000))

    expect(query.mock.calls[0][0].enabled).toBe(false)
  })

  it('⚠️ simulates with no account, so a disconnected visitor still sees what is waiting', () => {
    // The regression this replaces: `useSimulateContract` simulates as the connected wallet and
    // threw ConnectorNotConnectedError, blanking the panel for everyone who had not connected.
    mockGross([1000n, 500n])
    publicClient.simulateContract.mockResolvedValue({ result: [1000n, 500n] })

    renderHook(() => useClaimableFees(77n, POOL, TOKEN, 7000))
    const opts = query.mock.calls[0][0]
    expect(opts.enabled).toBe(true)

    opts.queryFn()
    expect(publicClient.simulateContract).toHaveBeenCalledWith(
      expect.not.objectContaining({ account: expect.anything() }),
    )
  })
})
