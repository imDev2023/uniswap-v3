import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { IndexedDataNotice } from './IndexedDataNotice'

// Inline per-panel degradation copy: says what is missing and that trading is unaffected.

describe('IndexedDataNotice', () => {
  it('replaces an indexed panel with a labelled explanation when the indexer is down', () => {
    render(<IndexedDataNotice state="down" what="Price history" />)
    const note = screen.getByRole('status')
    expect(note).toHaveTextContent(/price history unavailable/i)
    expect(note).toHaveTextContent(/unreachable/i)
    expect(note).toHaveTextContent(/trading still works/i)
  })

  it('distinguishes stale from unreachable', () => {
    render(<IndexedDataNotice state="stale" what="Curve positions" />)
    expect(screen.getByRole('status')).toHaveTextContent(/behind the chain/i)
  })

  it('renders nothing when the indexer is healthy', () => {
    const { container } = render(<IndexedDataNotice state="ok" what="Price history" />)
    expect(container).toBeEmptyDOMElement()
  })
})
