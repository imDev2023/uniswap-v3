import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TradeRail } from './TradeRail'
import { TokenTradeFeed } from './TokenTradeFeed'

/**
 * An empty feed must never be reported as "nobody has traded" while the indexer is behind.
 *
 * Both feeds already consulted indexer health on their ERROR branch, and both got the empty branch
 * wrong in the same way - which is the point worth keeping: an indexer that is merely lagging does
 * not error. It answers successfully, with an empty array, for any token it has not reached yet. So
 * the error branch never runs and "no rows" silently became an assertion.
 *
 * Caught by running the app against an indexer eleven hours behind, not by a test: the token page
 * for a curve with four on-chain trades rendered "No trades yet. The first buy shows up here."
 * under a pulsing Live dot.
 */

const NOTHING: never[] = []

function railProps(state: 'ok' | 'stale') {
  return { trades: NOTHING, now: 1_000, isError: false, isLoading: false, indexerState: state } as const
}

describe('TradeRail - empty while the indexer is behind', () => {
  it('reports the outage instead of claiming nobody has traded', () => {
    render(
      <MemoryRouter>
        <TradeRail {...railProps('stale')} />
      </MemoryRouter>,
    )
    expect(screen.getByRole('status')).toHaveTextContent(/behind the chain/i)
    expect(screen.queryByText(/no trades yet/i)).toBeNull()
  })

  it('still says "no trades yet" when the indexer is healthy and the list really is empty', () => {
    render(
      <MemoryRouter>
        <TradeRail {...railProps('ok')} />
      </MemoryRouter>,
    )
    expect(screen.getByText(/no trades yet/i)).toBeInTheDocument()
  })

  it('drops the pulsing live dot when the data is not live', () => {
    const { container: stale } = render(
      <MemoryRouter>
        <TradeRail {...railProps('stale')} />
      </MemoryRouter>,
    )
    expect(stale.querySelector('.live-dot')).toBeNull()

    const { container: ok } = render(
      <MemoryRouter>
        <TradeRail {...railProps('ok')} />
      </MemoryRouter>,
    )
    expect(ok.querySelector('.live-dot')).not.toBeNull()
  })
})

function feedProps(state: 'ok' | 'stale') {
  return {
    trades: NOTHING,
    symbol: 'ORICH',
    now: 1_000,
    explorer: 'https://explorer.example',
    indexerState: state,
    isError: false,
    isLoading: false,
  } as const
}

describe('TokenTradeFeed - empty while the indexer is behind', () => {
  it('reports the outage instead of claiming nobody has traded', () => {
    render(<TokenTradeFeed {...feedProps('stale')} />)
    expect(screen.getByRole('status')).toHaveTextContent(/behind the chain/i)
    expect(screen.queryByText(/no trades yet/i)).toBeNull()
  })

  it('still says "no trades yet" when the indexer is healthy', () => {
    render(<TokenTradeFeed {...feedProps('ok')} />)
    expect(screen.getByText(/no trades yet/i)).toBeInTheDocument()
  })

  it('drops the pulsing live dot when the data is not live', () => {
    const { container } = render(<TokenTradeFeed {...feedProps('stale')} />)
    expect(container.querySelector('.live-dot')).toBeNull()
  })

  it('keeps the graduated wording, which is history rather than an outage', () => {
    render(<TokenTradeFeed {...feedProps('ok')} graduated />)
    expect(screen.getByText(/no curve trades were recorded/i)).toBeInTheDocument()
  })
})
