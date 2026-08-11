import { getAddress, isAddress, zeroAddress, type Address } from 'viem'
import { subgraphUrlFrom } from './subgraphUrl'

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

/** The platform's own Uniswap V3 SwapRouter — needed to trade graduated pools (#21). */
export const SWAP_ROUTER_ADDRESS = envAddress(import.meta.env.VITE_SWAP_ROUTER_ADDRESS)

/**
 * The platform's own QuoterV2 (`contracts/script/DeployQuoter.s.sol`). Optional: when unset the swap
 * page falls back to a labelled `slot0` spot-price estimate, which ignores fee and price impact.
 */
export const QUOTER_ADDRESS = envAddress(import.meta.env.VITE_QUOTER_ADDRESS)

/** Whether the launchpad contract addresses have been configured for this build. */
export const isLaunchpadConfigured = FACTORY_ADDRESS !== zeroAddress

/** Whether the swap router is configured for post-graduation trading. */
export const isSwapConfigured = SWAP_ROUTER_ADDRESS !== zeroAddress

/** Whether exact quotes are available (vs. the spot-price estimate fallback). */
export const isQuoterConfigured = QUOTER_ADDRESS !== zeroAddress

// Declared in `./subgraphUrl` rather than here, because the production CSP generator must resolve
// the SAME default - including when the variable is unset - or it names no origin for a fetch the
// app still makes. See that module for the defect this prevents.
export const SUBGRAPH_URL = subgraphUrlFrom(import.meta.env.VITE_SUBGRAPH_URL)
