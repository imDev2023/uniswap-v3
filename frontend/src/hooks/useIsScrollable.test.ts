import { renderHook, act, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useIsScrollable } from './useIsScrollable'

/**
 * jsdom does no layout, so scrollHeight/clientHeight are both 0 and have to be stubbed. That is
 * fine for what these tests are for: the hook's job is deciding WHEN to re-measure, and the two
 * defects worth guarding are both about that - measuring once and never again, and losing the
 * content watcher in an environment that lacks only ResizeObserver.
 */
function makeNode(scrollHeight: number, clientHeight: number) {
  const node = document.createElement('div')
  Object.defineProperty(node, 'scrollHeight', { value: scrollHeight, configurable: true })
  Object.defineProperty(node, 'clientHeight', { value: clientHeight, configurable: true })
  document.body.appendChild(node)
  return node
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('useIsScrollable', () => {
  it('reports false when the content fits, so a short feed is not dimmed', () => {
    // The bug this encodes: a four-row feed that fits comfortably still had its last row faded,
    // which reads as a rendering fault rather than a "keep scrolling" affordance.
    const { result } = renderHook(() => useIsScrollable())
    act(() => result.current[0](makeNode(100, 100)))
    expect(result.current[1]).toBe(false)
  })

  it('reports true only once the content genuinely overflows', () => {
    const { result } = renderHook(() => useIsScrollable())
    act(() => result.current[0](makeNode(400, 100)))
    expect(result.current[1]).toBe(true)
  })

  it('tolerates a sub-pixel overflow rather than fading on a rounding error', () => {
    const { result } = renderHook(() => useIsScrollable())
    act(() => result.current[0](makeNode(100.5, 100)))
    expect(result.current[1]).toBe(false)
  })

  it('re-measures when rows arrive without the container resizing', async () => {
    // The live feeds grow by appending rows into a fixed-height scroller, so the element's own box
    // never changes and ResizeObserver never fires. MutationObserver is what catches this.
    const node = makeNode(100, 100)
    const { result } = renderHook(() => useIsScrollable())
    act(() => result.current[0](node))
    expect(result.current[1]).toBe(false)

    Object.defineProperty(node, 'scrollHeight', { value: 900, configurable: true })
    act(() => void node.appendChild(document.createElement('span')))

    await waitFor(() => expect(result.current[1]).toBe(true))
  })

  it('still watches content when the environment has no ResizeObserver', async () => {
    // The observers are guarded separately for this reason: a single combined guard meant an
    // environment lacking only ResizeObserver silently lost the content watcher too.
    vi.stubGlobal('ResizeObserver', undefined)

    const node = makeNode(100, 100)
    const { result } = renderHook(() => useIsScrollable())
    act(() => result.current[0](node))

    Object.defineProperty(node, 'scrollHeight', { value: 900, configurable: true })
    act(() => void node.appendChild(document.createElement('span')))

    await waitFor(() => expect(result.current[1]).toBe(true))
  })
})
