import { defineChain } from 'viem'

// Robinhood Chain is an Arbitrum L2 with native ETH gas (spec #11). Canonical WETH9 from
// contracts/src/Constants.sol. The Graph's hosted nets don't support 4663, so data comes from a
// self-hosted subgraph (see subgraph/README.md) and RPC is configured per-deployment.

export const WETH9_ADDRESS = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as const

const DEFAULT_RPC = import.meta.env.VITE_RPC_URL || undefined

export const robinhoodMainnet = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [DEFAULT_RPC ?? 'https://rpc.robinhood.com'] },
  },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://explorer.robinhood.com' },
  },
})

export const robinhoodTestnet = defineChain({
  id: 46630,
  name: 'Robinhood Chain Testnet',
  testnet: true,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [DEFAULT_RPC ?? 'https://testnet-rpc.robinhood.com'] },
  },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://testnet-explorer.robinhood.com' },
  },
})

const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? 46630)

/** The chain this build targets, selected by VITE_CHAIN_ID (defaults to testnet 46630). */
export const activeChain = CHAIN_ID === 4663 ? robinhoodMainnet : robinhoodTestnet
