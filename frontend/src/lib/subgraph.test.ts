import { describe, expect, it, vi } from 'vitest'
import {
  FACTORY_QUERY,
  GRADUATED_TOKENS_QUERY,
  CURVE_POSITIONS_QUERY,
  TOKENS_QUERY,
  TOKEN_QUERY,
  TRADES_QUERY,
  fetchCurvePositions,
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

  it('token query pulls the realised lock record', () => {
    // The lock record is the ONE thing on these panels only the read model knows: it is keyed by
    // position-NFT id and exists only after graduation.
    for (const field of ['lockUntil', 'permanent', 'extendCount', 'reclaimed', 'reclaimedEth']) {
      expect(TOKEN_QUERY).toContain(field)
    }
  })

  it('does NOT ask for the frozen launch terms, which are read from the chain', () => {
    // ⚠️ #37 moved all six to `useLaunchTerms`, because every one is frozen at `createLaunch` and can
    // never change - so this context was only a second route to the same immutable facts, and gating
    // the panels on it meant an indexer outage removed them from the page entirely. Selecting them
    // anyway would put six fields on the wire that nothing reads. The previous version of this test
    // asserted all six were present "because each feeds a panel", which stopped being true the
    // moment the panels moved: a test passing for a reason that no longer holds.
    //
    // `TokenFields` is checked too, so a field cannot creep back in via the shared fragment.
    for (const field of ['devAllocation', 'devClaimed', 'vestingDuration', 'permanentLock']) {
      expect(TOKEN_QUERY).not.toContain(field)
    }
    // `lockDuration` and `creatorFeeBps` need care: `Lock.creatorFeeBps` IS selected, and is a
    // different field on a different entity. Only the Token-level ones must be absent.
    expect(TOKEN_QUERY).not.toContain('lockDuration')
  })

  it('keeps the lock record OFF the board’s fragment', () => {
    // The board fetches 50 rows every five seconds and renders none of this.
    expect(TOKENS_QUERY).not.toContain('lockUntil')
    expect(GRADUATED_TOKENS_QUERY).not.toContain('lockUntil')
  })

  it('never asks for a vested-so-far figure, which does not and must not exist', () => {
    // ⚠️ Vested-so-far is a continuous function of wall-clock time, and a subgraph only writes when
    // an event fires - so any stored figure is silently stale between trades, worst on a quiet
    // launch where it would be most trusted. It is computed client-side in lib/vesting.ts.
    expect(TOKEN_QUERY).not.toContain('devVested')
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

  it('curve positions query returns only positive balances, largest first', () => {
    expect(CURVE_POSITIONS_QUERY).toContain('balance_gt: 0')
    expect(CURVE_POSITIONS_QUERY).toContain('orderBy: balance')
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

describe('fetchCurvePositions reads the key the query actually asks for', () => {
  // ⚠️ **This is the trap that shipped an empty panel through 302 green tests in #36.** A GraphQL
  // response key is an ASSERTION, not a type: `request<{ holders: Row[] }>(QUERY)` typechecks
  // against whatever you write, so renaming the entity in the query text while leaving the
  // destructure alone yields `undefined` at runtime and a panel indistinguishable from "nobody has
  // traded". tsc cannot see it and a component test with its own fixtures cannot either.
  //
  // So the fetcher is driven with a response shaped like the SERVER's, keyed off the query text.
  it('returns rows served under the entity name in the query', async () => {
    const match = /\{\s*(\w+)\s*\(/.exec(CURVE_POSITIONS_QUERY.slice(CURVE_POSITIONS_QUERY.indexOf('{', CURVE_POSITIONS_QUERY.indexOf('query'))))
    const entity = match?.[1]
    expect(entity).toBe('curvePositions')

    const row = { id: 'p1', account: '0xaaaa', balance: '5', bought: '5', sold: '0', tradeCount: 1, lastTradeTimestamp: '1' }
    const request = vi
      .spyOn(subgraphClient, 'request')
      .mockResolvedValue({ [entity as string]: [row] })

    const out = await fetchCurvePositions('0xTOKEN')

    // The assertion that bites: with a mismatched destructure this is `undefined`, not `[]`.
    expect(out).toEqual([row])
    expect(request).toHaveBeenCalledWith(CURVE_POSITIONS_QUERY, { token: '0xtoken', first: 100 })
    request.mockRestore()
  })

  it('does not read a key the query never asked for', async () => {
    // A server answering only `holders` - the pre-#36 shape - must not silently produce rows.
    const request = vi
      .spyOn(subgraphClient, 'request')
      .mockResolvedValue({ holders: [{ id: 'p1' }] })
    await expect(fetchCurvePositions('0xTOKEN')).resolves.toBeUndefined()
    request.mockRestore()
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
