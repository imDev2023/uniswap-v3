import { GraphQLClient, gql } from './graphqlClient'
import { SUBGRAPH_URL } from '../config/contracts'
import { TRADE_HISTORY_LIMIT } from '../config/constants'

// The subgraph (Build 08 / #19) is the canonical read model: curve progress, trades, curve
// positions, launch terms, and the graduation feed. All numeric fields come back as decimal strings
// (GraphQL BigInt) - callers convert with BigInt(...) at the edge.

export const subgraphClient = new GraphQLClient(SUBGRAPH_URL)

// --- row shapes (raw, string-encoded numbers straight from GraphQL) ---

export interface TokenRow {
  id: string
  curve: string
  creator: string
  name: string
  symbol: string
  /**
   * On-chain `LaunchToken.metadataURI`, indexed from `LaunchCreated` (#24). Always present as a
   * string, but very often empty - v1 is bring-your-own-URI, so no URI at all is the common case.
   */
  metadataURI: string
  createdAtTimestamp: string
  ethReserve: string
  tokenReserve: string
  tokensSold: string
  /**
   * This launch's own curve allocation. ⚠️ NOT the 800M constant since #34: a dev allocation carves
   * it down to as little as 760M, so progress and share denominators must come from here per launch.
   */
  curveTokenAllocation: string
  priceX18: string
  progressBps: number
  volumeEth: string
  buyCount: number
  sellCount: number
  tradeCount: number
  curvePositionCount: number
  graduated: boolean
  graduatedAtTimestamp: string | null
}

export interface TradeRow {
  id: string
  trader: string
  type: 'BUY' | 'SELL'
  amountEth: string
  amountToken: string
  priceX18: string
  tokensSold: string
  timestamp: string
  txHash: string
}

/** A trade plus the launch it belongs to - the shape the cross-launch live feed needs. */
export interface RecentTradeRow extends TradeRow {
  token: { id: string; symbol: string }
}

/**
 * An address's net stake in one CURVE, netted from its own buys and sells.
 *
 * ⚠️ **This is not a holder**, and the entity stopped being called one in #36. Three separate ways
 * the two differ, each of which has already misled a reader of this panel:
 *  - It ignores ERC-20 transfers. Buy on the curve, send the tokens away, and this still names you.
 *  - It ignores the pool. After graduation the curve stops trading forever, so every position here
 *    is FINAL rather than current, while the real holders change with every swap.
 *  - It ignores the creator's dev allocation, which is a free carve rather than a curve buy. That
 *    figure is read from the chain (`hooks/useLaunchTerms.ts`), not from a row here.
 */
export interface CurvePositionRow {
  id: string
  account: string
  balance: string
  bought: string
  sold: string
  tradeCount: number
  lastTradeTimestamp: string
}

/**
 * The LP lock on a graduated position (#33/#36).
 *
 * ⚠️ `permanent` is DERIVED by the indexer from the `lockUntil == type(uint64).max` sentinel; there
 * is no permanent flag on-chain. Branch on it before comparing `lockUntil` to any clock, or a
 * permanent lock renders as expiring in the year 584942417355. `lib/lock.ts` does this for you.
 */
/**
 * One `LPLock.collect` call.
 *
 * ⚠️ `sentBy` is the transaction's SENDER, not the caller. `FeesCollected` carries no `msg.sender`,
 * so the mapping records `transaction.from`, which differs whenever a contract sits in between.
 * Label it as the sender wherever it is rendered.
 */
export interface FeeCollectionRow {
  id: string
  sentBy: string
  collectedAtTimestamp: string
}

export interface LockRow {
  id: string
  pool: string
  origin: 'None' | 'Launch' | 'ThirdParty'
  lockUntil: string
  permanent: boolean
  creatorFeeBps: number
  extendCount: number
  reclaimed: boolean
  reclaimedEth: string | null
  reclaimedTokensBurned: string | null
  reclaimedAtTimestamp: string | null
  /**
   * How many times fees have been COLLECTED from this position (#39).
   *
   * ⚠️ This is what distinguishes "nothing has been collected" from "nothing has been earned", and
   * the lifetime totals below cannot do it alone. `collect` is permissionless, so zero collections
   * on a position with a year of real trading is an ordinary state, not an anomaly. What has accrued
   * but not been collected is a CHAIN read: see `hooks/useClaimableFees.ts`.
   */
  collectionCount: number
  /**
   * Lifetime fees paid out to the creator, in the POOL's token0/token1 ordering.
   *
   * ⚠️ **NOT "launch token" and "WETH".** V3 sorts a pair by address, so which side the launch token
   * is on differs per launch, and the mapping deliberately does not resolve it: the `token0()` call
   * that would deadlocks the subgraph against our pruning RPC. Attribute these with
   * `usePoolTokenOrder` before showing them to anyone.
   */
  creatorFees0: string
  creatorFees1: string
  /** Lifetime fees paid out to the treasury - the other side of the split. Same ordering. */
  treasuryFees0: string
  treasuryFees1: string
  /** The most recent collection only. Empty until one happens. */
  collections: FeeCollectionRow[]
}

export interface GraduationRow {
  id: string
  pool: string
  tokenId: string
  tokensSeeded: string
  wethSeeded: string
  sqrtPriceX96: string
  raisedEth: string
  timestamp: string
  txHash: string
}

export interface FactoryRow {
  id: string
  launchCount: number
  graduationCount: number
  tradeCount: number
  buyCount: number
  sellCount: number
  totalVolumeEth: string
  totalRaisedEth: string
}

/**
 * Token fields the board can order by, server-side. Narrowed to the four the sort control exposes
 * rather than mirroring graph-node's whole `Token_orderBy` enum: an unsupported value is a query
 * error at runtime, so the type is the guard.
 */
export type TokenOrderBy = 'createdAtTimestamp' | 'progressBps' | 'volumeEth' | 'tradeCount'

// --- queries ---

const TOKEN_FIELDS = gql`
  fragment TokenFields on Token {
    id
    curve
    creator
    name
    symbol
    metadataURI
    createdAtTimestamp
    ethReserve
    tokenReserve
    tokensSold
    curveTokenAllocation
    priceX18
    progressBps
    volumeEth
    buyCount
    sellCount
    tradeCount
    curvePositionCount
    graduated
    graduatedAtTimestamp
  }
`

// `orderBy` is a VARIABLE, not a constant, because the board pages this query. Ordering
// newest-first here and re-sorting the returned window client-side would rank only the 50 newest
// launches: the 51st-newest curve sitting at 95% would never appear under "Closest", which is the
// one view where it matters most. Letting the server order means each mode gets the true top N.
export const TOKENS_QUERY = gql`
  ${TOKEN_FIELDS}
  query Tokens($first: Int!, $graduated: Boolean, $orderBy: Token_orderBy!) {
    tokens(
      first: $first
      orderBy: $orderBy
      orderDirection: desc
      where: { graduated: $graduated }
    ) {
      ...TokenFields
    }
  }
`

// Graduated tokens, most-recently-graduated first — the "just graduated" feed (spec story 28).
export const GRADUATED_TOKENS_QUERY = gql`
  ${TOKEN_FIELDS}
  query GraduatedTokens($first: Int!) {
    tokens(
      first: $first
      orderBy: graduatedAtTimestamp
      orderDirection: desc
      where: { graduated: true }
    ) {
      ...TokenFields
    }
  }
`

// The realised lock record (#36), selected ONLY here and deliberately not folded into `TokenFields`.
// The board fetches 50 rows on a 5s poll and renders none of it.
//
// ⚠️ **`devAllocation`, `devClaimed`, `vestingDuration`, `lockDuration`, `creatorFeeBps` and
// `permanentLock` are all indexed but deliberately NOT selected here.** #37 moved every one of them
// to a direct chain read (`useLaunchTerms`), because all six are frozen at `createLaunch` and can
// never change - so the read model was only a second route to the same immutable facts, and gating
// the panels on it meant an indexer outage removed them from the page entirely. Asking for them
// anyway would put six fields on the wire that nothing reads, and would make this file look like
// the source of truth for terms that it is not.
const TOKEN_LOCK_FIELDS = gql`
  fragment TokenLockFields on Token {
    lock {
      id
      pool
      origin
      lockUntil
      permanent
      creatorFeeBps
      extendCount
      reclaimed
      reclaimedEth
      reclaimedTokensBurned
      reclaimedAtTimestamp
      collectionCount
      creatorFees0
      creatorFees1
      treasuryFees0
      treasuryFees1
      collections(first: 1, orderBy: collectedAtTimestamp, orderDirection: desc) {
        id
        sentBy
        collectedAtTimestamp
      }
    }
  }
`

export const TOKEN_QUERY = gql`
  ${TOKEN_FIELDS}
  ${TOKEN_LOCK_FIELDS}
  query Token($id: ID!) {
    token(id: $id) {
      ...TokenFields
      ...TokenLockFields
      graduation {
        id
        pool
        tokenId
        tokensSeeded
        wethSeeded
        sqrtPriceX96
        raisedEth
        timestamp
        txHash
      }
    }
  }
`

export const TRADES_QUERY = gql`
  query Trades($token: String!, $first: Int!) {
    trades(
      first: $first
      orderBy: timestamp
      orderDirection: desc
      where: { token: $token }
    ) {
      id
      trader
      type
      amountEth
      amountToken
      priceX18
      tokensSold
      timestamp
      txHash
    }
  }
`

export const CURVE_POSITIONS_QUERY = gql`
  query CurvePositions($token: String!, $first: Int!) {
    curvePositions(
      first: $first
      orderBy: balance
      orderDirection: desc
      where: { token: $token, balance_gt: 0 }
    ) {
      id
      account
      balance
      bought
      sold
      tradeCount
      lastTradeTimestamp
    }
  }
`

// Cross-launch trade feed for the board's live rail. Not filtered by token - this is the "something
// is happening right now" signal, and restricting it to one launch would defeat the point. The
// nested token selection is why Trade.token is a relation rather than a bare address.
export const RECENT_TRADES_QUERY = gql`
  query RecentTrades($first: Int!) {
    trades(first: $first, orderBy: timestamp, orderDirection: desc) {
      id
      trader
      type
      amountEth
      amountToken
      priceX18
      tokensSold
      timestamp
      txHash
      token {
        id
        symbol
      }
    }
  }
`

// graph-node's built-in health field. `block.timestamp` is a CHAIN timestamp, so comparing it to the
// RPC head's timestamp gives real lag with no clock skew — unlike `synced`, which compares against
// graph-node's own ingested head and reads true while genuinely behind.
export const META_QUERY = gql`
  query IndexerMeta {
    _meta {
      block {
        number
        timestamp
      }
      hasIndexingErrors
    }
  }
`

export const FACTORY_QUERY = gql`
  query FactoryStats {
    factory(id: "launchpad") {
      id
      launchCount
      graduationCount
      tradeCount
      buyCount
      sellCount
      totalVolumeEth
      totalRaisedEth
    }
  }
`

// --- fetchers ---

export async function fetchActiveTokens(
  first = 50,
  orderBy: TokenOrderBy = 'createdAtTimestamp',
): Promise<TokenRow[]> {
  const data = await subgraphClient.request<{ tokens: TokenRow[] }>(TOKENS_QUERY, {
    first,
    graduated: false,
    orderBy,
  })
  return data.tokens
}

export async function fetchGraduatedTokens(first = 20): Promise<TokenRow[]> {
  const data = await subgraphClient.request<{ tokens: TokenRow[] }>(GRADUATED_TOKENS_QUERY, {
    first,
  })
  return data.tokens
}

/**
 * The realised LP lock on a graduated launch.
 *
 * ⚠️ **The launch TERMS are deliberately not here.** `devAllocation`, `devClaimed`,
 * `vestingDuration`, `lockDuration`, `creatorFeeBps` and `permanentLock` are all indexed, but #37
 * reads every one of them from the chain instead: all six are frozen at `createLaunch` and can
 * never change, so this context was only a second route to the same immutable facts - and depending
 * on it meant an indexer outage removed the lock and vesting panels from the page entirely. See
 * `hooks/useLaunchTerms.ts`.
 */
export interface TokenLockRow {
  /** The lock record. Null until the launch graduates and the position exists. */
  lock: LockRow | null
}

export type TokenWithGraduation = TokenRow & TokenLockRow & { graduation: GraduationRow | null }

export async function fetchToken(id: string): Promise<TokenWithGraduation | null> {
  const data = await subgraphClient.request<{ token: TokenWithGraduation | null }>(TOKEN_QUERY, {
    id: id.toLowerCase(),
  })
  return data.token
}

/**
 * The most recent `first` trades for a token, oldest-first.
 *
 * The query orders DESCENDING so the window is anchored to the present: asking for the oldest 200
 * instead means that once a token passes 200 trades the page silently stops at ancient history,
 * and the chart then carries that stale price flat to `now` - asserting the price has not moved
 * when it has moved all day. Anchoring to the newest keeps the right-hand edge real.
 *
 * The rows are reversed back to ascending here because that is what every caller wants to reason
 * about; only the *window* is newest-first, not the result.
 */
export async function fetchTrades(
  token: string,
  first = TRADE_HISTORY_LIMIT,
): Promise<TradeRow[]> {
  const data = await subgraphClient.request<{ trades: TradeRow[] }>(TRADES_QUERY, {
    token: token.toLowerCase(),
    first,
  })
  return [...data.trades].reverse()
}

export async function fetchRecentTrades(first = 25): Promise<RecentTradeRow[]> {
  const data = await subgraphClient.request<{ trades: RecentTradeRow[] }>(RECENT_TRADES_QUERY, {
    first,
  })
  return data.trades
}

// ⚠️ The response key is `curvePositions` since #36 renamed the entity. The request type here is an
// ASSERTION, not something derived from the schema, so tsc cannot catch a mismatch between this key
// and the query text - it would surface as `undefined` at runtime and render an empty panel, which
// looks exactly like "nobody has traded". Both must be changed together, and `subgraph.test.ts`
// pins the key against the query text for exactly that reason.
export async function fetchCurvePositions(token: string, first = 100): Promise<CurvePositionRow[]> {
  const data = await subgraphClient.request<{ curvePositions: CurvePositionRow[] }>(
    CURVE_POSITIONS_QUERY,
    { token: token.toLowerCase(), first },
  )
  return data.curvePositions
}

export interface MetaRow {
  block: { number: number; timestamp: number | null }
  hasIndexingErrors: boolean
}

/** Indexer head + health. Throws when the endpoint is unreachable — that throw IS the "down" signal. */
export async function fetchMeta(): Promise<MetaRow | null> {
  const data = await subgraphClient.request<{ _meta: MetaRow | null }>(META_QUERY)
  return data._meta
}

export async function fetchFactory(): Promise<FactoryRow | null> {
  const data = await subgraphClient.request<{ factory: FactoryRow | null }>(FACTORY_QUERY)
  return data.factory
}
