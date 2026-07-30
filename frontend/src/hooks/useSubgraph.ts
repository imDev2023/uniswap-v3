import { useQuery } from '@tanstack/react-query'
import {
  fetchActiveTokens,
  fetchFactory,
  fetchGraduatedTokens,
  fetchHolders,
  fetchRecentTrades,
  fetchToken,
  fetchTrades,
} from '../lib/subgraph'

// react-query wrappers over the subgraph fetchers. Curve state refreshes live via refetchInterval
// so buy/sell UIs and progress meters track the chain within a few seconds without a socket.

const LIVE_REFETCH_MS = 5_000

export function useActiveTokens() {
  return useQuery({
    queryKey: ['activeTokens'],
    queryFn: () => fetchActiveTokens(),
    refetchInterval: LIVE_REFETCH_MS,
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

export function useHolders(token: string | undefined) {
  return useQuery({
    queryKey: ['holders', token?.toLowerCase()],
    queryFn: () => fetchHolders(token!),
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
