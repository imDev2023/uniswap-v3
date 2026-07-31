import { useQuery } from '@tanstack/react-query'
import { useBlock } from 'wagmi'
import {
  classifyIndexer,
  needsBlockTimestampLookup,
  resolveIndexedTimestamp,
  type IndexerStatus,
} from '../lib/indexerHealth'
import { fetchMeta } from '../lib/subgraph'

// Measures how far the subgraph is behind the chain, by comparing the subgraph's indexed block
// timestamp against the RPC head's. See lib/indexerHealth.ts for why timestamps and not `synced`.
//
// ⚠️ **graph-node does not reliably supply the indexed block's timestamp.** Measured against
// graph-node 0.40.2 on this stack: `_meta.block` returns a real `number` and `hash` but
// `timestamp: null`. That single null used to disable the whole degradation system - a null
// `indexedTimestamp` makes classifyIndexer return `unknown`, which every surface deliberately stays
// quiet about because it is also the first-load state. The result was an indexer eleven hours
// behind with no banner anywhere, while each indexed panel rendered its EMPTY state: a token page
// showing "No trades yet - be the first to buy this curve" for a curve that had already traded.
//
// This was not caught earlier because the degradation work was validated by STOPPING graph-node,
// which makes it unreachable and exercises the `down` path. `stale` - reachable but behind, the far
// likelier production failure, and the one the 5-minute ops alert is written for - had never once
// fired against a real indexer.
//
// The fix keeps the original decision intact rather than working around it. Lag is still the
// difference between two CHAIN timestamps, with no per-chain block-time constant to drift: the
// indexed block's timestamp is simply read from RPC by number when graph-node declines to provide
// it. Block headers are not pruned (unlike state), so this resolves at any depth - verified at
// 5.3M blocks back on testnet.

const POLL_MS = 20_000

export function useIndexerStatus(): IndexerStatus {
  const { data: meta, isError } = useQuery({
    queryKey: ['indexerMeta'],
    queryFn: fetchMeta,
    refetchInterval: POLL_MS,
    // One failed poll shouldn't flash a scary banner, but the banner also mustn't take a minute to
    // appear during a real outage. One quick retry is the compromise.
    retry: 1,
  })

  const { data: head } = useBlock({ query: { refetchInterval: POLL_MS } })

  // Only fetched when graph-node withheld the timestamp, so a future graph-node that supplies it
  // costs nothing. A block header for a given number is immutable, hence `staleTime: Infinity`;
  // the key changes as the indexer advances, so it still tracks.
  const needsLookup = needsBlockTimestampLookup(meta)
  const { data: indexedBlock } = useBlock({
    blockNumber: needsLookup && meta ? BigInt(meta.block.number) : undefined,
    query: { enabled: needsLookup, staleTime: Infinity },
  })

  return classifyIndexer({
    // First load is already quiet without a special case: until `meta` arrives there is no indexed
    // timestamp, so classifyIndexer returns `unknown`, which no surface warns on.
    reachable: !isError,
    indexedTimestamp: resolveIndexedTimestamp(meta?.block.timestamp, indexedBlock?.timestamp),
    headTimestamp: head ? Number(head.timestamp) : undefined,
    hasIndexingErrors: meta?.hasIndexingErrors,
  })
}
