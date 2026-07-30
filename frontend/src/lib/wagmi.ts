import { createConfig, fallback, http } from 'wagmi'
import { injected } from 'wagmi/connectors'
import {
  MAINNET_RPC_URLS,
  TESTNET_RPC_URLS,
  activeChain,
  robinhoodMainnet,
  robinhoodTestnet,
} from '../config/chain'

// Lean wallet setup: the browser-injected connector (MetaMask / Rabbit / etc.) only, so there's no
// WalletConnect project-id dependency for v1. A single target chain, chosen by VITE_CHAIN_ID;
// transports are declared for both known chains so the config typechecks regardless of selection.

/**
 * Ordered failover across the resolved endpoints for a chain.
 *
 * `rank: false` (viem's default, stated here because it is a deliberate choice) keeps strict
 * preference order instead of reordering by measured latency. Ranking would be wrong for us: the
 * last entry is always the public endpoint, which is rate limited and documented as unsuitable for
 * production, and a latency probe can make it look attractive precisely when the dedicated primary
 * is busy. We want the primary to serve everything it can and the rest to exist only for failure.
 *
 * What this buys, concretely (verified against viem 2.55.4 semantics):
 *   - A `-32000` "missing trie node" / "metadata is not found" - the deep-state miss that
 *     docs/rpc-capability.md measured as intermittent - is NOT in viem's retry set, so no amount of
 *     retrying one endpoint fixes it. It also does not match `shouldThrow`, so `fallback` advances
 *     to the next transport. A second provider therefore turns that failure into a served request.
 *   - A genuine `execution reverted` DOES match `shouldThrow`, so a reverting call fails fast on the
 *     first endpoint instead of being replayed against every provider in the list.
 *
 * With only one resolved URL this is equivalent to a bare `http()`, since `fallback` forces
 * `retryCount: 0` on inner transports and retries from the first one. It is not redundancy until
 * VITE_RPC_URL_2 is set.
 */
/**
 * Exported so tests exercise the SAME options the app ships. Constructing `fallback` with different
 * options in a test proves something about viem, but not about this app.
 */
export const FALLBACK_OPTIONS = { rank: false } as const

export const failover = (urls: string[]) =>
  fallback(
    urls.map((url) => http(url)),
    FALLBACK_OPTIONS,
  )

export const wagmiConfig = createConfig({
  chains: [activeChain],
  connectors: [injected()],
  transports: {
    [robinhoodMainnet.id]: failover(MAINNET_RPC_URLS),
    [robinhoodTestnet.id]: failover(TESTNET_RPC_URLS),
  },
})

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig
  }
}
