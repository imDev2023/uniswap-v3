import { describe, expect, it } from 'vitest'
import {
  FACTORY_QUERY,
  GRADUATED_TOKENS_QUERY,
  HOLDERS_QUERY,
  TOKENS_QUERY,
  TOKEN_QUERY,
  TRADES_QUERY,
} from './subgraph'

// Guard the query shapes against schema drift: the fields the UI reads must be requested.
describe('subgraph queries', () => {
  it('token query pulls curve progress and graduation', () => {
    expect(TOKEN_QUERY).toContain('progressBps')
    expect(TOKEN_QUERY).toContain('priceX18')
    expect(TOKEN_QUERY).toContain('graduation')
    expect(TOKEN_QUERY).toContain('pool')
  })

  it('tokens list filters by graduation and orders newest-first', () => {
    expect(TOKENS_QUERY).toContain('graduated: $graduated')
    expect(TOKENS_QUERY).toContain('orderBy: createdAtTimestamp')
    expect(TOKENS_QUERY).toContain('orderDirection: desc')
  })

  it('trades query orders ascending for a price series', () => {
    expect(TRADES_QUERY).toContain('orderBy: timestamp')
    expect(TRADES_QUERY).toContain('orderDirection: asc')
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
