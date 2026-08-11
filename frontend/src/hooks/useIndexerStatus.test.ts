import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useIndexerStatus } from './useIndexerStatus'

// ⚠️ These tests exist because of a defect that reached PRODUCTION and that 592 passing tests did not
// see. It was found by loading the deployed site: with the subgraph unreachable, the hook answered
// `{ state: 'ok', lagSeconds: 0 }` - a confident green light - instead of staying silent.
//
// The cause was a shared react-query key. wagmi derives `useBlock`'s key from its arguments, so the
// conditional indexed-block lookup (which passed no `blockNumber`) shared `["block",{chainId}]` with
// the head query, and `enabled: false` stops a query FETCHING but not READING. The lookup was handed
// the chain head and reported it as the indexed block.
//
// ⚠️ These tests are written against BEHAVIOUR, not against that mechanism. They say what the hook
// must answer for a given set of inputs, so they hold for any implementation - the shared key, a
// guard at the read site, or the separate query the hook now uses. An earlier draft mocked
// `useBlock` to return the head to every caller, which pinned the OLD implementation: a root-cause
// fix would have failed it. Caught in review.

const queries = vi.fn()
vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: { queryKey: unknown[] }) => queries(options),
}))

const head = vi.fn()
vi.mock('wagmi', () => ({
  useBlock: () => head(),
  usePublicClient: () => ({ chain: { id: 46630 }, getBlock: vi.fn() }),
}))

vi.mock('../lib/subgraph', () => ({ fetchMeta: vi.fn() }))

const HEAD_TS = 1_786_417_163n

/**
 * Route each `useQuery` call by the name at the head of its key, so a test states its inputs rather
 * than the order the hook happens to call them in.
 *
 * `indexedBlockTimestamp` honours `enabled`, exactly as react-query does for a key nothing else
 * writes to - which is the property the production fix restored.
 */
function setup({
  meta,
  metaIsError = false,
  indexedTs,
}: {
  meta?: { block: { number: number; timestamp: number | null }; hasIndexingErrors: boolean }
  metaIsError?: boolean
  indexedTs?: bigint
}) {
  head.mockReturnValue({ data: { timestamp: HEAD_TS } })
  queries.mockImplementation((options: { queryKey: unknown[]; enabled?: boolean }) => {
    if (options.queryKey[0] === 'indexerMeta') return { data: meta, isError: metaIsError }
    return { data: options.enabled ? indexedTs : undefined }
  })
}

beforeEach(() => {
  queries.mockReset()
  head.mockReset()
})

describe('useIndexerStatus', () => {
  // THE REGRESSION. `pending` is not only first load: react-query's default `networkMode: 'online'`
  // PAUSES a failing fetch rather than erroring it, which is the state the deployed page was found
  // in - `status: 'pending'`, `fetchStatus: 'paused'`, `error: null`, subgraph entirely unreachable.
  // The hook must be SILENT here, never `ok`.
  it('stays unknown while the meta query is pending', () => {
    setup({ meta: undefined })

    const { result } = renderHook(() => useIndexerStatus())

    expect(result.current.state).toBe('unknown')
    expect(result.current.lagSeconds).toBeNull()
  })

  // The same assertion with a timestamp available to any query that ignores `enabled`. This is what
  // the shared cache key really did, expressed as an input rather than as a mock of `useBlock`.
  it('stays unknown while pending even if a block timestamp is obtainable', () => {
    setup({ meta: undefined, indexedTs: HEAD_TS })

    const { result } = renderHook(() => useIndexerStatus())

    expect(result.current.state).toBe('unknown')
  })

  it('reports down when the subgraph is unreachable', () => {
    setup({ meta: undefined, metaIsError: true, indexedTs: HEAD_TS })

    const { result } = renderHook(() => useIndexerStatus())

    expect(result.current.state).toBe('down')
  })

  // graph-node 0.40.2 returns a real `number` with `timestamp: null`, which is why the RPC fallback
  // exists at all. Here the lookup is genuinely enabled and its answer must be used.
  it('uses the RPC fallback when graph-node withholds the timestamp', () => {
    setup({
      meta: { block: { number: 42, timestamp: null }, hasIndexingErrors: false },
      indexedTs: HEAD_TS - 600n,
    })

    const { result } = renderHook(() => useIndexerStatus())

    expect(result.current.state).toBe('stale')
    expect(result.current.lagSeconds).toBe(600)
  })

  // Pins that the fallback is not merely present but PREFERRED correctly: graph-node's own value
  // wins when it supplies one, so a future graph-node that fills `timestamp` costs no RPC call.
  it("prefers graph-node's own timestamp over the fallback", () => {
    setup({
      meta: { block: { number: 42, timestamp: Number(HEAD_TS) - 60 }, hasIndexingErrors: false },
      indexedTs: HEAD_TS - 9999n,
    })

    const { result } = renderHook(() => useIndexerStatus())

    expect(result.current.lagSeconds).toBe(60)
  })

  it('reports ok when the indexed head matches the chain head', () => {
    setup({
      meta: { block: { number: 42, timestamp: Number(HEAD_TS) }, hasIndexingErrors: false },
    })

    const { result } = renderHook(() => useIndexerStatus())

    expect(result.current.state).toBe('ok')
    expect(result.current.lagSeconds).toBe(0)
  })

  // A failed subgraph still answers queries, with data frozen at the failing block. Reachable, so
  // `down` is wrong; serving stale data as current, so silence is worse.
  it('reports stale when the subgraph has indexing errors', () => {
    setup({
      meta: { block: { number: 42, timestamp: Number(HEAD_TS) }, hasIndexingErrors: true },
    })

    const { result } = renderHook(() => useIndexerStatus())

    expect(result.current.state).toBe('stale')
  })

  // The head is its own query and can be absent while everything else is fine. Lag is undefined
  // rather than zero, and an undefined lag must not read as "up to date".
  it('stays unknown when the chain head has not arrived', () => {
    head.mockReturnValue({ data: undefined })
    queries.mockImplementation((options: { queryKey: unknown[] }) =>
      options.queryKey[0] === 'indexerMeta'
        ? { data: { block: { number: 42, timestamp: Number(HEAD_TS) }, hasIndexingErrors: false }, isError: false }
        : { data: undefined },
    )

    const { result } = renderHook(() => useIndexerStatus())

    expect(result.current.state).toBe('unknown')
  })
})
