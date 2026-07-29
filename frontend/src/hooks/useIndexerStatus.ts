import { useQuery } from '@tanstack/react-query'
import { useBlock } from 'wagmi'
import { classifyIndexer, type IndexerStatus } from '../lib/indexerHealth'
import { fetchMeta } from '../lib/subgraph'

// Measures how far the subgraph is behind the chain, by comparing the subgraph's indexed block
// timestamp against the RPC head's. See lib/indexerHealth.ts for why timestamps and not `synced`.

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

  return classifyIndexer({
    // First load is already quiet without a special case: until `meta` arrives there is no indexed
    // timestamp, so classifyIndexer returns `unknown`, which no surface warns on.
    reachable: !isError,
    indexedTimestamp: meta?.block.timestamp ?? undefined,
    headTimestamp: head ? Number(head.timestamp) : undefined,
    hasIndexingErrors: meta?.hasIndexingErrors,
  })
}
