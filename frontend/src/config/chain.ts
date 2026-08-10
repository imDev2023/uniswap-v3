import { defineChain } from 'viem'
import { resolveProxyUrl, resolveRpcUrls } from '../lib/rpcEndpoints'

// Robinhood Chain is an Arbitrum L2 with native ETH gas (spec #11). The Graph's hosted nets don't
// support 4663, so data comes from a self-hosted subgraph (see subgraph/README.md) and RPC is
// configured per-deployment.

// Documented public endpoints, per docs.robinhood.com/chain/connecting. Rate limited and stated to
// be unsuitable for production, so they serve as the last-resort entry rather than the preferred
// one - see resolveRpcUrls for the ordering policy.
const PUBLIC_RPC_BY_CHAIN: Record<number, string> = {
  4663: 'https://rpc.mainnet.chain.robinhood.com',
  46630: 'https://rpc.testnet.chain.robinhood.com',
}

// A same-origin proxy that keeps the credential on the server, when the deployment declares one.
// Resolved once, against the page's own origin. `window` is absent under SSR and in a non-DOM test
// environment, and `resolveProxyUrl` returns null there rather than guessing an origin.
const RPC_PROXY_URL = resolveProxyUrl(
  import.meta.env.VITE_RPC_PROXY_PATH,
  typeof window === 'undefined' ? undefined : window.location.origin,
)

// Two endpoints with failover is a Stage 4 requirement: RPC is the only component with no graceful
// degradation, and the official endpoint is a load-balanced pool whose nodes retain different
// history, so a deep-state read can fail on one node and succeed on another (docs/rpc-capability.md).
// A `-32000` state miss is not in viem's retry set, but it also does not stop `fallback` advancing,
// so a genuinely independent second provider is what converts that failure into a served request.
const rpcUrlsFor = (chainId: number): string[] =>
  resolveRpcUrls({
    proxy: RPC_PROXY_URL ?? undefined,
    primary: import.meta.env.VITE_RPC_URL,
    secondary: import.meta.env.VITE_RPC_URL_2,
    publicDefault: PUBLIC_RPC_BY_CHAIN[chainId],
  })

// What the APP reads through, wired into wagmi's `transports`. This is the only list that may name
// a dedicated endpoint, and it never reaches the wallet - see `walletRpcUrlsFor` below.
export const MAINNET_RPC_URLS = rpcUrlsFor(4663)
export const TESTNET_RPC_URLS = rpcUrlsFor(46630)

// ⚠️ What the WALLET is offered, and deliberately NOT the list above.
//
// wagmi's injected connector builds its `wallet_addEthereumChain` request as
// `rpcUrls = [chain.rpcUrls.default.http[0]]` (@wagmi/core connectors/injected.js). So whatever
// sits first in `rpcUrls.default` is handed to MetaMask, shown to the user in full, and then STORED
// as their network endpoint - after which that visitor's own wallet traffic runs through it for as
// long as the network entry survives. Build #38 watched exactly that happen with a keyed URL.
//
// The public endpoint is the only correct answer here. It is not a downgrade for the wallet: a
// wallet needs nonce, balance and broadcast at the chain head, which is precisely what a public
// endpoint serves well, while the deep historical reads that justify a dedicated provider all
// happen in the app, through `transports`.
//
// Do not "unify" these two lists. They have different audiences and different threat models.
const walletRpcUrlsFor = (chainId: number): [string, ...string[]] => [PUBLIC_RPC_BY_CHAIN[chainId]]

// Multicall3 is deployed at its canonical CREATE2 address on BOTH Robinhood chains — confirmed with
// eth_getCode against 4663 and 46630 (same 7.6 kB runtime). Declaring it lets viem fold the
// RPC-first trade reads (curveOf / graduated / getPool) into a single eth_call evaluated at one
// block: fewer round-trips, and a consistent snapshot rather than a torn read across blocks.
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11' as const

// VITE_RPC_PROXY_PATH points the app at a same-origin proxy that holds the credential server-side;
// VITE_RPC_URL and VITE_RPC_URL_2 are direct endpoints and are public by construction, because Vite
// inlines them into the bundle.
export const robinhoodMainnet = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: walletRpcUrlsFor(4663) },
  },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' },
  },
  contracts: { multicall3: { address: MULTICALL3_ADDRESS } },
})

export const robinhoodTestnet = defineChain({
  id: 46630,
  name: 'Robinhood Chain Testnet',
  testnet: true,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: walletRpcUrlsFor(46630) },
  },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://explorer.testnet.chain.robinhood.com' },
  },
  contracts: { multicall3: { address: MULTICALL3_ADDRESS } },
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
