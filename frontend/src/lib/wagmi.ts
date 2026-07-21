import { createConfig, http } from 'wagmi'
import { injected } from 'wagmi/connectors'
import { activeChain, robinhoodMainnet, robinhoodTestnet } from '../config/chain'

// Lean wallet setup: the browser-injected connector (MetaMask / Rabbit / etc.) only, so there's no
// WalletConnect project-id dependency for v1. A single target chain, chosen by VITE_CHAIN_ID;
// transports are declared for both known chains so the config typechecks regardless of selection.
export const wagmiConfig = createConfig({
  chains: [activeChain],
  connectors: [injected()],
  transports: {
    [robinhoodMainnet.id]: http(robinhoodMainnet.rpcUrls.default.http[0]),
    [robinhoodTestnet.id]: http(robinhoodTestnet.rpcUrls.default.http[0]),
  },
})

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig
  }
}
