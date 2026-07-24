import { defineChain } from 'viem'

// Robinhood Chain is an Arbitrum L2 with native ETH gas (spec #11). The Graph's hosted nets don't
// support 4663, so data comes from a self-hosted subgraph (see subgraph/README.md) and RPC is
// configured per-deployment.

const DEFAULT_RPC = import.meta.env.VITE_RPC_URL || undefined

// Endpoints are the public documented values from research/robinhood-chain-compat.md. VITE_RPC_URL
// overrides the RPC (e.g. an Alchemy key) for reliability under load.
export const robinhoodMainnet = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [DEFAULT_RPC ?? 'https://rpc.mainnet.chain.robinhood.com'] },
  },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' },
  },
})

export const robinhoodTestnet = defineChain({
  id: 46630,
  name: 'Robinhood Chain Testnet',
  testnet: true,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [DEFAULT_RPC ?? 'https://rpc.testnet.chain.robinhood.com'] },
  },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://explorer.testnet.chain.robinhood.com' },
  },
})

const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? 46630)

/** The chain this build targets, selected by VITE_CHAIN_ID (defaults to testnet 46630). */
export const activeChain = CHAIN_ID === 4663 ? robinhoodMainnet : robinhoodTestnet

// Canonical wrapped-native per chain. Mainnet value matches contracts/src/Constants.sol; the testnet
// deployment is byte-for-byte the same proxy + implementation at a different address, so it must be
// selected per chain — a mainnet WETH9 on 46630 has no code and would break pool ordering and swap
// paths. VITE_WETH9_ADDRESS overrides for a bespoke deployment.
const WETH9_BY_CHAIN: Record<number, `0x${string}`> = {
  4663: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  46630: '0x7943e237c7F95DA44E0301572D358911207852Fa',
}

export const WETH9_ADDRESS = (import.meta.env.VITE_WETH9_ADDRESS ??
  WETH9_BY_CHAIN[activeChain.id]) as `0x${string}`
