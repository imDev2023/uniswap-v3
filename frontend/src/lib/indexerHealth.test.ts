import { describe, expect, it } from 'vitest'
import {
  STALE_LAG_SECONDS,
  classifyIndexer,
  formatLag,
  isDegraded,
  type IndexerLagInput,
} from './indexerHealth'

const HEAD = 1_785_266_606

function input(over: Partial<IndexerLagInput> = {}): IndexerLagInput {
  return {
    reachable: true,
    indexedTimestamp: HEAD - 40,
    headTimestamp: HEAD,
    hasIndexingErrors: false,
    ...over,
  }
}

describe('classifyIndexer', () => {
  it('calls a normally-lagging indexer healthy', () => {
    // ~40 s behind is the documented steady state of the tuned compose stack - not a warning.
    expect(classifyIndexer(input())).toEqual({ state: 'ok', lagSeconds: 40 })
  })

  it('calls an unreachable endpoint down', () => {
    expect(classifyIndexer(input({ reachable: false }))).toEqual({ state: 'down', lagSeconds: null })
  })

  it('calls a far-behind indexer stale', () => {
    const r = classifyIndexer(input({ indexedTimestamp: HEAD - (STALE_LAG_SECONDS + 1) }))
    expect(r.state).toBe('stale')
    expect(r.lagSeconds).toBe(STALE_LAG_SECONDS + 1)
  })

  it('treats exactly the threshold as still healthy', () => {
    expect(classifyIndexer(input({ indexedTimestamp: HEAD - STALE_LAG_SECONDS })).state).toBe('ok')
  })

  it('treats an indexing error as stale even when the endpoint answers', () => {
    // A failed subgraph keeps serving queries with data frozen at the failing block - reachable,
    // recent-looking, and wrong. That is the case worth surfacing loudest.
    expect(classifyIndexer(input({ hasIndexingErrors: true })).state).toBe('stale')
  })

  it('stays quiet until both heads are known', () => {
    expect(classifyIndexer(input({ indexedTimestamp: undefined })).state).toBe('unknown')
    expect(classifyIndexer(input({ headTimestamp: undefined })).state).toBe('unknown')
  })

  it('clamps a negative lag to zero', () => {
    // The subgraph can briefly report a block ahead of the RPC node's head; "-3s behind" is noise.
    expect(classifyIndexer(input({ indexedTimestamp: HEAD + 3 }))).toEqual({
      state: 'ok',
      lagSeconds: 0,
    })
  })
})

describe('isDegraded', () => {
  it('warns only for down and stale', () => {
    expect(isDegraded('down')).toBe(true)
    expect(isDegraded('stale')).toBe(true)
    expect(isDegraded('ok')).toBe(false)
    // `unknown` is the first-load state - warning on it would fire on every page load.
    expect(isDegraded('unknown')).toBe(false)
  })
})

describe('formatLag', () => {
  it('renders seconds, minutes and hours', () => {
    expect(formatLag(40)).toBe('40s')
    expect(formatLag(360)).toBe('6m')
    expect(formatLag(7200)).toBe('2h')
    expect(formatLag(null)).toBe('unknown')
  })
})
