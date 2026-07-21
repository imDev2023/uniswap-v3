import { getAddress, isAddress, zeroAddress, type Address } from 'viem'

// Contract addresses come from the environment so the same build targets testnet or mainnet
// (docs/deploy.md). Until they're filled in, they read as the zero address and the app runs in a
// "not configured" mode (see isLaunchpadConfigured) rather than making doomed calls.

function envAddress(raw: string | undefined): Address {
  if (raw && isAddress(raw)) return getAddress(raw)
  return zeroAddress
}

export const FACTORY_ADDRESS = envAddress(import.meta.env.VITE_FACTORY_ADDRESS)
export const GRADUATION_MANAGER_ADDRESS = envAddress(
  import.meta.env.VITE_GRADUATION_MANAGER_ADDRESS,
)

/** Whether the launchpad contract addresses have been configured for this build. */
export const isLaunchpadConfigured = FACTORY_ADDRESS !== zeroAddress

export const SUBGRAPH_URL =
  import.meta.env.VITE_SUBGRAPH_URL || 'http://localhost:8000/subgraphs/name/launchpad'
