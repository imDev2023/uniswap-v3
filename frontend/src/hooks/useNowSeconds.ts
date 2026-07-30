import { useEffect, useState } from 'react'

/**
 * A shared "now" in unix seconds, ticking on an interval.
 *
 * @dev Exists so every relative age in one render reads from the SAME clock. Calling Date.now()
 *      per row makes a long list drift against itself, and - worse - makes rows re-render at
 *      independent moments, so a feed visibly shimmers as ages tick over one at a time.
 *
 *      One second would be wasted work: the board polls the subgraph every five seconds, so ages
 *      cannot be fresher than that anyway.
 */
export function useNowSeconds(intervalMs = 5_000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])

  return now
}
