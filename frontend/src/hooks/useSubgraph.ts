import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type { TokenOrderBy } from '../lib/subgraph'
import {
  fetchActiveTokens,
  fetchFactory,
  fetchGraduatedTokens,
  fetchCurvePositions,
  fetchRecentTrades,
  fetchToken,
  fetchTrades,
} from '../lib/subgraph'

// react-query wrappers over the subgraph fetchers. Curve state refreshes live via refetchInterval
// so buy/sell UIs and progress meters track the chain within a few seconds without a socket.

const LIVE_REFETCH_MS = 5_000

/**
 * How many live curves the board asks for. Exported so the page can tell "this is everything" from
 * "this is the first page" and label the count honestly rather than presenting a capped number as
 * the total.
 */
export const BOARD_PAGE_SIZE = 50

/**
 * Live curves for the board.
 *
 * `orderBy` is part of the query key AND the request: the board is paged, so changing sort has to
 * re-ask the server for a different top N, not just reshuffle the page already in hand.
 * `placeholderData` keeps the previous page on screen while the new one loads, so switching sort
 * does not flash the whole board through a skeleton.
 */
export function useActiveTokens(orderBy: TokenOrderBy = 'createdAtTimestamp') {
  return useQuery({
    queryKey: ['activeTokens', orderBy],
    queryFn: () => fetchActiveTokens(BOARD_PAGE_SIZE, orderBy),
    refetchInterval: LIVE_REFETCH_MS,
    placeholderData: keepPreviousData,
  })
}

export function useGraduatedTokens() {
  return useQuery({
    queryKey: ['graduatedTokens'],
    queryFn: () => fetchGraduatedTokens(),
    refetchInterval: LIVE_REFETCH_MS,
  })
}

export function useToken(id: string | undefined) {
  return useQuery({
    queryKey: ['token', id?.toLowerCase()],
    queryFn: () => fetchToken(id!),
    enabled: !!id,
    refetchInterval: LIVE_REFETCH_MS,
  })
}

export function useTrades(token: string | undefined) {
  return useQuery({
    queryKey: ['trades', token?.toLowerCase()],
    queryFn: () => fetchTrades(token!),
    enabled: !!token,
    refetchInterval: LIVE_REFETCH_MS,
  })
}

/**
 * Net curve positions for one launch, largest first.
 *
 * ⚠️ Not holders - see {@link CurvePositionRow}. Still polled on the live interval even though a
 * graduated launch's positions can never change again: the poll is what makes a live curve's panel
 * track its trades, and branching the interval on graduation would buy nothing but a second code
 * path. The CARD is what must say which of the two it is showing.
 */
export function useCurvePositions(token: string | undefined) {
  return useQuery({
    queryKey: ['curvePositions', token?.toLowerCase()],
    queryFn: () => fetchCurvePositions(token!),
    enabled: !!token,
    refetchInterval: LIVE_REFETCH_MS,
  })
}

/** Cross-launch trade feed powering the board's live rail. */
export function useRecentTrades(first = 25) {
  return useQuery({
    queryKey: ['recentTrades', first],
    queryFn: () => fetchRecentTrades(first),
    refetchInterval: LIVE_REFETCH_MS,
  })
}

export function useFactoryStats() {
  return useQuery({ queryKey: ['factory'], queryFn: () => fetchFactory() })
}
