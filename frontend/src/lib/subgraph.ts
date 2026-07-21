import { GraphQLClient, gql } from 'graphql-request'
import { SUBGRAPH_URL } from '../config/contracts'

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
  createdAtTimestamp: string
  ethReserve: string
  tokenReserve: string
  tokensSold: string
  priceX18: string
  progressBps: number
  volumeEth: string
  buyCount: number
  sellCount: number
  tradeCount: number
  holderCount: number
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

// --- queries ---

const TOKEN_FIELDS = gql`
  fragment TokenFields on Token {
    id
    curve
    creator
    name
    symbol
    createdAtTimestamp
    ethReserve
    tokenReserve
    tokensSold
    priceX18
    progressBps
    volumeEth
    buyCount
    sellCount
    tradeCount
    holderCount
    graduated
    graduatedAtTimestamp
  }
`

export const TOKENS_QUERY = gql`
  ${TOKEN_FIELDS}
  query Tokens($first: Int!, $graduated: Boolean) {
    tokens(
      first: $first
      orderBy: createdAtTimestamp
      orderDirection: desc
      where: { graduated: $graduated }
    ) {
      ...TokenFields
    }
  }
`

export const ALL_TOKENS_QUERY = gql`
  ${TOKEN_FIELDS}
  query AllTokens($first: Int!) {
    tokens(first: $first, orderBy: createdAtTimestamp, orderDirection: desc) {
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
      orderDirection: asc
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
    holders(
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

export async function fetchTokens(first = 50): Promise<TokenRow[]> {
  const data = await subgraphClient.request<{ tokens: TokenRow[] }>(ALL_TOKENS_QUERY, { first })
  return data.tokens
}

export async function fetchActiveTokens(first = 50): Promise<TokenRow[]> {
  const data = await subgraphClient.request<{ tokens: TokenRow[] }>(TOKENS_QUERY, {
    first,
    graduated: false,
  })
  return data.tokens
}

export async function fetchGraduatedTokens(first = 50): Promise<TokenRow[]> {
  const data = await subgraphClient.request<{ tokens: TokenRow[] }>(TOKENS_QUERY, {
    first,
    graduated: true,
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

export async function fetchTrades(token: string, first = 200): Promise<TradeRow[]> {
  const data = await subgraphClient.request<{ trades: TradeRow[] }>(TRADES_QUERY, {
    token: token.toLowerCase(),
    first,
  })
  return data.trades
}

export async function fetchHolders(token: string, first = 100): Promise<HolderRow[]> {
  const data = await subgraphClient.request<{ holders: HolderRow[] }>(HOLDERS_QUERY, {
    token: token.toLowerCase(),
    first,
  })
  return data.holders
}

export async function fetchFactory(): Promise<FactoryRow | null> {
  const data = await subgraphClient.request<{ factory: FactoryRow | null }>(FACTORY_QUERY)
  return data.factory
}
