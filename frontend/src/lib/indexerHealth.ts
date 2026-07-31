// Indexer health, measured honestly.
//
// graph-node's own `synced` flag compares the subgraph head against graph-node's INGESTED head, not
// the chain's - so it reads `true` while genuinely minutes behind (see subgraph/README.md). The only
// trustworthy measure is the subgraph's indexed block against the chain's real head.
//
// Lag is compared in BLOCK TIMESTAMPS rather than block numbers: both come from the chain, so
// there's no wall-clock skew to worry about, and no per-chain block-time constant to keep in sync
// (Robinhood testnet blocks are ~0.3 s, mainnet ~0.1 s - a block-count threshold would mean
// different things on each).

/**
 * How far behind the chain the subgraph may fall before the UI calls its data stale. Matches the
 * ops alerting rule in CLAUDE.md ("indexer lag > 5 min"). Steady state on the tuned compose stack
 * is ~40 s, so this fires on a real stall, not on normal jitter.
 */
export const STALE_LAG_SECONDS = 300

export type IndexerState =
  /** Indexed head is within STALE_LAG_SECONDS of the chain. */
  | 'ok'
  /** Reachable, but its data is behind the chain (or it stopped on an indexing error). */
  | 'stale'
  /** The subgraph endpoint could not be reached at all. */
  | 'down'
  /** Not enough information yet - first load, or the chain head isn't known. */
  | 'unknown'

export interface IndexerLagInput {
  /** False when the `_meta` query errored (endpoint down, DNS, CORS, 5xx). */
  reachable: boolean
  /** Chain timestamp (seconds) of the last block the subgraph indexed. */
  indexedTimestamp: number | undefined
  /** Chain timestamp (seconds) of the current head block, from RPC. */
  headTimestamp: number | undefined
  /** graph-node's own `_meta.hasIndexingErrors` - a subgraph that has failed stops advancing. */
  hasIndexingErrors: boolean | undefined
}

export interface IndexerStatus {
  state: IndexerState
  /** Seconds the subgraph is behind the chain, or null when not measurable. */
  lagSeconds: number | null
}

/**
 * Classify indexer health from the two heads. Pure, so the degradation states the UI shows are unit
 * tested without a running graph-node.
 */
export function classifyIndexer(input: IndexerLagInput): IndexerStatus {
  if (!input.reachable) return { state: 'down', lagSeconds: null }

  // A subgraph that has failed is still reachable and still answers queries - with data frozen at
  // the failing block. That is stale data being served as if current, which is the case worth
  // surfacing loudest.
  if (input.hasIndexingErrors) return { state: 'stale', lagSeconds: null }

  if (input.indexedTimestamp === undefined || input.headTimestamp === undefined) {
    return { state: 'unknown', lagSeconds: null }
  }

  // Clamp: the subgraph can briefly report a block the RPC head hasn't caught up to (different
  // nodes), and a negative lag is meaningless to a reader.
  const lagSeconds = Math.max(0, input.headTimestamp - input.indexedTimestamp)
  return { state: lagSeconds > STALE_LAG_SECONDS ? 'stale' : 'ok', lagSeconds }
}

/**
 * The indexed head's chain timestamp, from graph-node if it supplies one and from an RPC block
 * header otherwise.
 *
 * ⚠️ **graph-node does not always supply it.** Measured on graph-node 0.40.2: `_meta.block` returns
 * a real `number` and `hash` but `timestamp: null`. Folding that null into `undefined` silently
 * disabled every degraded state in the app, because a missing indexed timestamp classifies as
 * `unknown` - which is also the first-load state, and which every surface stays deliberately quiet
 * about. An indexer eleven hours behind therefore showed no banner at all, while each indexed panel
 * rendered its EMPTY state as though the data were current and genuinely empty.
 *
 * This was missed because the degradation work was validated by STOPPING graph-node, which makes it
 * unreachable and exercises the `down` path. `stale` - reachable but behind, the likelier
 * production failure and the one the 5-minute ops alert is written for - had never fired for real.
 *
 * The fallback preserves the original decision rather than replacing it: lag stays the difference
 * between two CHAIN timestamps, so there is still no per-chain block-time constant to keep in sync.
 * Only the source of one of them changes. Block headers are never pruned - unlike state, which is
 * gone after ~5,000 blocks on these chains - so reading one by number works at any depth.
 */
export function resolveIndexedTimestamp(
  metaTimestamp: number | null | undefined,
  fallbackBlockTimestamp: bigint | undefined,
): number | undefined {
  if (metaTimestamp != null) return metaTimestamp
  return fallbackBlockTimestamp === undefined ? undefined : Number(fallbackBlockTimestamp)
}

/** Whether the indexed block's timestamp has to be fetched from RPC because graph-node withheld it. */
export function needsBlockTimestampLookup(
  meta: { block: { number: number; timestamp: number | null } } | null | undefined,
): boolean {
  return !!meta && meta.block.timestamp == null
}

/** Human-readable lag, e.g. "45s" / "6m" / "2h". */
export function formatLag(lagSeconds: number | null): string {
  if (lagSeconds === null) return 'unknown'
  if (lagSeconds < 90) return `${Math.round(lagSeconds)}s`
  if (lagSeconds < 5400) return `${Math.round(lagSeconds / 60)}m`
  return `${Math.round(lagSeconds / 3600)}h`
}

/** Whether the UI should warn about indexed data. `unknown` stays quiet - it is the first-load state. */
export function isDegraded(state: IndexerState): boolean {
  return state === 'down' || state === 'stale'
}
