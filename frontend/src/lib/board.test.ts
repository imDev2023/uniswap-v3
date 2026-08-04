import { describe, expect, it } from 'vitest'
import { DEFAULT_SORT, orderByFor, parseSortMode, sortTokens } from './board'
import type { TokenRow } from './subgraph'

function token(over: Partial<TokenRow> & { id: string }): TokenRow {
  return {
    curve: '0xcurve',
    creator: '0xcreator',
    // Empty is the common case: v1 is bring-your-own-URI and most launches carry no URI.
    metadataURI: '',
    name: over.id,
    symbol: over.id.toUpperCase(),
    createdAtTimestamp: '1000',
    ethReserve: '0',
    tokenReserve: '0',
    tokensSold: '0',
    // The no-dev-allocation case; #34 made this per launch.
    curveTokenAllocation: '800000000000000000000000000',
    priceX18: '0',
    progressBps: 0,
    volumeEth: '0',
    buyCount: 0,
    sellCount: 0,
    tradeCount: 0,
    holderCount: 0,
    graduated: false,
    graduatedAtTimestamp: null,
    ...over,
  }
}

const ids = (rows: TokenRow[]) => rows.map((r) => r.id)

describe('parseSortMode', () => {
  it('accepts known modes and falls back for anything else', () => {
    expect(parseSortMode('volume')).toBe('volume')
    expect(parseSortMode('nonsense')).toBe(DEFAULT_SORT)
    expect(parseSortMode(null)).toBe(DEFAULT_SORT)
    expect(parseSortMode(undefined)).toBe(DEFAULT_SORT)
  })
})

describe('orderByFor', () => {
  it('maps every sort mode to the subgraph field the SERVER must order by', () => {
    // The board is paged, so this mapping is what makes a sort correct rather than cosmetic: order
    // the query newest-first and re-sort the page, and a 95% curve outside the newest N never
    // surfaces under "Closest".
    expect(orderByFor('new')).toBe('createdAtTimestamp')
    expect(orderByFor('progress')).toBe('progressBps')
    expect(orderByFor('volume')).toBe('volumeEth')
    expect(orderByFor('trades')).toBe('tradeCount')
  })

  it('falls back to the default rather than sending an undefined orderBy', () => {
    // An unknown orderBy is a hard query error from graph-node, which would blank the whole board.
    expect(orderByFor('bogus' as never)).toBe(orderByFor(DEFAULT_SORT))
  })
})

describe('sortTokens', () => {
  it('does not mutate the input array', () => {
    // The input is react-query cache data; sorting in place would make the rendered order depend
    // on whichever sort ran last.
    const input = [token({ id: 'a', progressBps: 10 }), token({ id: 'b', progressBps: 90 })]
    const snapshot = ids(input)
    sortTokens(input, 'progress')
    expect(ids(input)).toEqual(snapshot)
  })

  it('sorts newest first by default', () => {
    const rows = [
      token({ id: 'old', createdAtTimestamp: '100' }),
      token({ id: 'new', createdAtTimestamp: '300' }),
      token({ id: 'mid', createdAtTimestamp: '200' }),
    ]
    expect(ids(sortTokens(rows, 'new'))).toEqual(['new', 'mid', 'old'])
  })

  it('sorts by progress descending - closest to graduating first', () => {
    const rows = [
      token({ id: 'low', progressBps: 300 }),
      token({ id: 'high', progressBps: 9600 }),
      token({ id: 'mid', progressBps: 5800 }),
    ]
    expect(ids(sortTokens(rows, 'progress'))).toEqual(['high', 'mid', 'low'])
  })

  it('compares volume as BigInt, not Number', () => {
    // These two differ by 1 wei and are far beyond a double's integer precision. Through Number()
    // they compare equal, so the order would shuffle between renders.
    const rows = [
      token({ id: 'smaller', volumeEth: '100000000000000000000000001' }),
      token({ id: 'bigger', volumeEth: '100000000000000000000000002' }),
    ]
    expect(ids(sortTokens(rows, 'volume'))).toEqual(['bigger', 'smaller'])
  })

  it('sorts by trade count for the busiest view', () => {
    const rows = [
      token({ id: 'quiet', tradeCount: 1 }),
      token({ id: 'busy', tradeCount: 42 }),
    ]
    expect(ids(sortTokens(rows, 'trades'))).toEqual(['busy', 'quiet'])
  })

  it('breaks ties deterministically so a board of equal rows does not reshuffle on every poll', () => {
    // Nine untraded launches created in the same block: every sort key is identical.
    const rows = [
      token({ id: 'c', createdAtTimestamp: '500' }),
      token({ id: 'a', createdAtTimestamp: '500' }),
      token({ id: 'b', createdAtTimestamp: '500' }),
    ]
    const first = ids(sortTokens(rows, 'volume'))
    const again = ids(sortTokens([...rows].reverse(), 'volume'))
    expect(first).toEqual(again)
    expect(first).toEqual(['a', 'b', 'c'])
  })

  it('handles an empty board', () => {
    expect(sortTokens([], 'progress')).toEqual([])
  })
})
