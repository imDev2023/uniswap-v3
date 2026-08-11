import { useQuery } from '@tanstack/react-query'
import { useBlock, usePublicClient } from 'wagmi'
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
  //
  // ⚠️ THIS IS DELIBERATELY NOT `useBlock`, and the reason is a defect that reached production.
  // wagmi derives `useBlock`'s react-query key from its arguments, so a call with no `blockNumber`
  // gets the key `["block",{chainId}]` - byte for byte the key of the head query above. `enabled`
  // stops a query FETCHING, not READING, so the disabled lookup was served the HEAD from cache and
  // reported it as the INDEXED block. Measured on the deployed site: one cache entry, FOUR observers.
  //
  // The consequence inverted this hook's quietest promise. With `meta` unarrived the indexed
  // timestamp equalled the head timestamp, lag computed to 0, and `classifyIndexer` answered `ok` -
  // a confident green light - where every surface expects the silent `unknown`. It is masked in the
  // ordinary outage, because an unreachable subgraph errors and `!reachable` short-circuits to
  // `down` first. It is NOT masked while the query is merely pending, which is first load, and which
  // is also what react-query's default `networkMode: 'online'` produces when it PAUSES a failing
  // fetch instead of erroring it - the exact state the deployed page was found in.
  //
  // Reading through the public client under a key of our own removes the collision at its source. A
  // guard at the read site would have fixed the symptom while leaving the shared key one inlined
  // expression away from returning.
  const needsLookup = needsBlockTimestampLookup(meta)
  const publicClient = usePublicClient()
  const { data: indexedTimestamp } = useQuery({
    queryKey: ['indexedBlockTimestamp', publicClient?.chain.id, meta?.block.number ?? null],
    queryFn: async () => {
      const block = await publicClient!.getBlock({ blockNumber: BigInt(meta!.block.number) })
      return block.timestamp
    },
    enabled: needsLookup && publicClient !== undefined,
    staleTime: Infinity,
  })

  return classifyIndexer({
    // First load is quiet: until `meta` arrives there is no indexed timestamp, so classifyIndexer
    // returns `unknown`, which no surface warns on. That holds only while the lookup above keeps a
    // key of its own - it was untrue for as long as the lookup shared the head query's key.
    reachable: !isError,
    indexedTimestamp: resolveIndexedTimestamp(meta?.block.timestamp, indexedTimestamp),
    headTimestamp: head ? Number(head.timestamp) : undefined,
    hasIndexingErrors: meta?.hasIndexingErrors,
  })
}
