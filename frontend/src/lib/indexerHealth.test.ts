import { describe, expect, it } from 'vitest'
import {
  STALE_LAG_SECONDS,
  classifyIndexer,
  formatLag,
  isDegraded,
  needsBlockTimestampLookup,
  resolveIndexedTimestamp,
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

describe('resolveIndexedTimestamp - graph-node withholding the timestamp', () => {
  it('prefers the timestamp graph-node supplies', () => {
    expect(resolveIndexedTimestamp(1_700_000_000, 999n)).toBe(1_700_000_000)
  })

  it('falls back to the RPC block header when graph-node returns null', () => {
    // The bug this exists for: graph-node 0.40.2 answers `_meta.block.timestamp: null` while
    // `number` and `hash` are real. Folding that to undefined classified a badly-lagging indexer as
    // `unknown`, the state every surface stays quiet about - so nothing warned, and each indexed
    // panel showed its empty state as though the data were current.
    expect(resolveIndexedTimestamp(null, 1_700_000_000n)).toBe(1_700_000_000)
  })

  it('is undefined only when neither source has an answer yet', () => {
    expect(resolveIndexedTimestamp(null, undefined)).toBeUndefined()
    expect(resolveIndexedTimestamp(undefined, undefined)).toBeUndefined()
  })

  it('classifies a real lag as stale once the fallback supplies the timestamp', () => {
    // End to end through the classifier, at the ~11h lag actually measured against live testnet.
    const head = 1_785_466_491
    const indexed = resolveIndexedTimestamp(null, BigInt(head - 40_514))
    expect(
      classifyIndexer({
        reachable: true,
        indexedTimestamp: indexed,
        headTimestamp: head,
        hasIndexingErrors: false,
      }).state,
    ).toBe('stale')
  })
})

describe('needsBlockTimestampLookup', () => {
  it('asks for a lookup exactly when the timestamp is missing', () => {
    expect(needsBlockTimestampLookup({ block: { number: 5, timestamp: null } })).toBe(true)
    expect(needsBlockTimestampLookup({ block: { number: 5, timestamp: 100 } })).toBe(false)
  })

  it('does not ask before there is any meta to look up', () => {
    // Guards against a wasted RPC round trip on every first render.
    expect(needsBlockTimestampLookup(null)).toBe(false)
    expect(needsBlockTimestampLookup(undefined)).toBe(false)
  })
})
