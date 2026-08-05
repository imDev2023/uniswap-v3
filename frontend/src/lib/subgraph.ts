import { GraphQLClient, gql } from './graphqlClient'
import { SUBGRAPH_URL } from '../config/contracts'
import { TRADE_HISTORY_LIMIT } from '../config/constants'

// The subgraph (Build 08 / #19) is the canonical read model: curve progress, trades, holders, and
// the graduation feed. All numeric fields come back as decimal strings (GraphQL BigInt) — callers
// convert with BigInt(...) at the edge.

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

export interface HolderRow {
  id: string
  account: string
  balance: string
  bought: string
  sold: string
  tradeCount: number
  lastTradeTimestamp: string
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

export const TOKEN_QUERY = gql`
  ${TOKEN_FIELDS}
  query Token($id: ID!) {
    token(id: $id) {
      ...TokenFields
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

export const HOLDERS_QUERY = gql`
  query Holders($token: String!, $first: Int!) {
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

export type TokenWithGraduation = TokenRow & { graduation: GraduationRow | null }

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
// looks exactly like "nobody has traded". Both must be changed together.
export async function fetchHolders(token: string, first = 100): Promise<HolderRow[]> {
  const data = await subgraphClient.request<{ curvePositions: HolderRow[] }>(HOLDERS_QUERY, {
    token: token.toLowerCase(),
    first,
  })
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
