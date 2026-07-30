import { useEffect, useRef, useState } from 'react'

/**
 * Tracks which ids in a polled list are arriving for the FIRST time, so they can be animated in.
 *
 * This is what makes the board feel live rather than merely dense: on a 0.3s-block chain new trades
 * and new launches appear constantly, and without a cue they simply pop into place and are missed.
 *
 * @dev Two behaviours matter and both are easy to get wrong:
 *
 *      1. The FIRST load never counts as arrivals. Otherwise every row flashes on page load, which
 *         reads as a glitch and, worse, trains people to ignore the very signal it exists to give.
 *      2. Ids are remembered forever within the session, not just compared against the previous
 *         page. A trade that scrolls off the end of the feed and later comes back (the feed is
 *         capped) must not re-announce itself as new.
 *
 *      Recording happens in an effect rather than during render because render can run twice under
 *      StrictMode; mutating the seen-set inline would consume the arrival on the discarded pass and
 *      the animation would never play.
 */
export function useArrivals(ids: readonly string[]): ReadonlySet<string> {
  const seen = useRef<Set<string> | null>(null)
  const [arrivals, setArrivals] = useState<ReadonlySet<string>>(EMPTY)

  useEffect(() => {
    // Adopt the baseline from the first NON-EMPTY list, not simply the first effect run. The first
    // run happens while the query is still loading and the list is empty, so adopting there would
    // leave the seen-set empty and make the entire first page count as arrivals - every row
    // flashing at once, which is the exact glitch this hook exists to avoid.
    if (seen.current === null) {
      if (ids.length === 0) return
      seen.current = new Set(ids)
      return
    }

    const fresh = ids.filter((id) => !seen.current!.has(id))
    if (fresh.length === 0) return

    for (const id of fresh) seen.current.add(id)
    setArrivals(new Set(fresh))
  }, [ids])

  return arrivals
}

const EMPTY: ReadonlySet<string> = new Set()
