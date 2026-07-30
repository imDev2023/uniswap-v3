import { useCallback, useEffect, useState } from 'react'

/**
 * Whether an element's content actually overflows it vertically.
 *
 * The feed panels fade out their bottom edge to say "keep scrolling". CSS can express the fade but
 * cannot ask whether there is anything to scroll to, and `:has(.rail-scroll)` only proves the
 * scroll container exists - so a four-row feed that fits comfortably still got its last row dimmed,
 * which reads as a rendering fault rather than an affordance.
 *
 * Returns a callback ref, so it attaches without the caller having to thread a ref plus an effect.
 */
export function useIsScrollable(): [(node: HTMLElement | null) => void, boolean] {
  const [node, setNode] = useState<HTMLElement | null>(null)
  const [scrollable, setScrollable] = useState(false)

  useEffect(() => {
    if (!node) {
      setScrollable(false)
      return
    }

    const measure = () => setScrollable(node.scrollHeight > node.clientHeight + 1)
    measure()

    // Both are needed: the element resizes when the viewport does, and its content changes when new
    // trades arrive without the element itself changing size.
    if (typeof ResizeObserver === 'undefined') return
    const resize = new ResizeObserver(measure)
    resize.observe(node)
    const mutation =
      typeof MutationObserver === 'undefined' ? null : new MutationObserver(measure)
    mutation?.observe(node, { childList: true, subtree: true })

    return () => {
      resize.disconnect()
      mutation?.disconnect()
    }
  }, [node])

  return [useCallback((n: HTMLElement | null) => setNode(n), []), scrollable]
}
