import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useArrivals } from './useArrivals'

describe('useArrivals', () => {
  it('treats nothing as an arrival on the first populated load', () => {
    const { result } = renderHook(({ ids }) => useArrivals(ids), {
      initialProps: { ids: ['a', 'b', 'c'] },
    })
    expect([...result.current]).toEqual([])
  })

  it('does not adopt its baseline from the empty list a query starts with', () => {
    // Regression: the first effect run happens while the query is still loading, so the list is
    // empty. Adopting there left the seen-set empty and made the whole first page flash at once.
    const { result, rerender } = renderHook(({ ids }) => useArrivals(ids), {
      initialProps: { ids: [] as string[] },
    })
    rerender({ ids: ['a', 'b', 'c'] })
    expect([...result.current]).toEqual([])
  })

  it('reports only genuinely new ids on a later poll', () => {
    const { result, rerender } = renderHook(({ ids }) => useArrivals(ids), {
      initialProps: { ids: ['a', 'b'] },
    })
    rerender({ ids: ['c', 'a', 'b'] })
    expect([...result.current]).toEqual(['c'])
  })

  it('does not re-announce an id that scrolled off a capped feed and came back', () => {
    const { result, rerender } = renderHook(({ ids }) => useArrivals(ids), {
      initialProps: { ids: ['a', 'b'] },
    })
    rerender({ ids: ['c'] }) // 'a' and 'b' fall off the end of the capped feed
    expect([...result.current]).toEqual(['c'])
    rerender({ ids: ['a', 'c'] }) // 'a' comes back
    expect([...result.current]).toEqual(['c'])
  })

  it('holds its previous answer when a poll brings nothing new', () => {
    const { result, rerender } = renderHook(({ ids }) => useArrivals(ids), {
      initialProps: { ids: ['a'] },
    })
    rerender({ ids: ['b', 'a'] })
    expect([...result.current]).toEqual(['b'])
    rerender({ ids: ['b', 'a'] })
    expect([...result.current]).toEqual(['b'])
  })
})
