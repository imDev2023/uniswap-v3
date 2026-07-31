import { describe, expect, it, vi } from 'vitest'
import {
  FACTORY_QUERY,
  GRADUATED_TOKENS_QUERY,
  HOLDERS_QUERY,
  TOKENS_QUERY,
  TOKEN_QUERY,
  TRADES_QUERY,
  fetchTrades,
  subgraphClient,
  type TradeRow,
} from './subgraph'
import { TRADE_HISTORY_LIMIT } from '../config/constants'

// Guard the query shapes against schema drift: the fields the UI reads must be requested.
describe('subgraph queries', () => {
  it('token query pulls curve progress and graduation', () => {
    expect(TOKEN_QUERY).toContain('progressBps')
    expect(TOKEN_QUERY).toContain('priceX18')
    expect(TOKEN_QUERY).toContain('graduation')
    expect(TOKEN_QUERY).toContain('pool')
  })

  it('tokens list filters by graduation and takes its ordering from a variable', () => {
    // orderBy became a VARIABLE in build #28. The board is paged, so a hardcoded
    // createdAtTimestamp would mean every sort mode ranked only the newest page: a curve at 95%
    // older than that window could never appear under "Closest".
    expect(TOKENS_QUERY).toContain('graduated: $graduated')
    expect(TOKENS_QUERY).toContain('$orderBy: Token_orderBy!')
    expect(TOKENS_QUERY).toContain('orderBy: $orderBy')
    expect(TOKENS_QUERY).not.toContain('orderBy: createdAtTimestamp')
    expect(TOKENS_QUERY).toContain('orderDirection: desc')
  })

  it('trades query anchors its window to the NEWEST trades', () => {
    // The window is capped at TRADE_HISTORY_LIMIT, so the direction decides which end of history
    // gets dropped. Ascending meant that past the cap a token's chart showed only ancient trades
    // and then carried that stale price flat to `now` - asserting the price had not moved when it
    // had moved all day. Descending keeps the right-hand edge real; fetchTrades reverses the rows
    // back to ascending for callers.
    expect(TRADES_QUERY).toContain('orderBy: timestamp')
    expect(TRADES_QUERY).toContain('orderDirection: desc')
    expect(TRADES_QUERY).toContain('priceX18')
  })

  it('holders query returns only positive balances, largest first', () => {
    expect(HOLDERS_QUERY).toContain('balance_gt: 0')
    expect(HOLDERS_QUERY).toContain('orderBy: balance')
  })

  it('graduated feed orders by graduation time, newest first', () => {
    expect(GRADUATED_TOKENS_QUERY).toContain('graduated: true')
    expect(GRADUATED_TOKENS_QUERY).toContain('orderBy: graduatedAtTimestamp')
    expect(GRADUATED_TOKENS_QUERY).toContain('orderDirection: desc')
  })

  it('factory query targets the singleton rollup', () => {
    expect(FACTORY_QUERY).toContain('id: "launchpad"')
    expect(FACTORY_QUERY).toContain('totalVolumeEth')
  })
})

describe('fetchTrades', () => {
  const row = (timestamp: string): TradeRow =>
    ({
      id: timestamp,
      trader: '0xaaaa',
      type: 'BUY',
      amountEth: '0',
      amountToken: '0',
      priceX18: '1',
      tokensSold: '0',
      timestamp,
      txHash: '0xdead',
    }) as unknown as TradeRow

  it('asks for the newest page but hands callers ascending rows', async () => {
    // Both readers depend on this: the chart needs chronological order to build its grid, and the
    // trade feed re-sorts to newest-first itself. Returning the raw descending page would silently
    // reverse the chart's time axis.
    const request = vi
      .spyOn(subgraphClient, 'request')
      .mockResolvedValue({ trades: [row('300'), row('200'), row('100')] })

    const out = await fetchTrades('0xTOKEN')

    expect(out.map((t) => t.timestamp)).toEqual(['100', '200', '300'])
    expect(request).toHaveBeenCalledWith(TRADES_QUERY, {
      token: '0xtoken',
      first: TRADE_HISTORY_LIMIT,
    })
    request.mockRestore()
  })
})
