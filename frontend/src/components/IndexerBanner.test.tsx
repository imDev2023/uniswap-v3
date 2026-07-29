import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { IndexerBanner } from './IndexerBanner'

// The Stage 2 promise is that indexer downtime is VISIBLE and bounded: the user is told what broke
// and, just as importantly, that trading did not. These assert the copy actually says both.

describe('IndexerBanner', () => {
  it('says nothing while the indexer is healthy', () => {
    const { container } = render(<IndexerBanner status={{ state: 'ok', lagSeconds: 12 }} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('says nothing on first load, before health is known', () => {
    const { container } = render(<IndexerBanner status={{ state: 'unknown', lagSeconds: null }} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('announces an outage and reassures that trading still works', () => {
    render(<IndexerBanner status={{ state: 'down', lagSeconds: null }} />)
    const banner = screen.getByRole('status')
    expect(banner).toHaveTextContent(/charts unavailable/i)
    expect(banner).toHaveTextContent(/trading is unaffected/i)
  })

  it('reports how far behind a stale indexer is', () => {
    render(<IndexerBanner status={{ state: 'stale', lagSeconds: 420 }} />)
    const banner = screen.getByRole('status')
    expect(banner).toHaveTextContent(/charts are stale/i)
    expect(banner).toHaveTextContent(/7m behind/i)
    expect(banner).toHaveTextContent(/trading is unaffected/i)
  })
})
