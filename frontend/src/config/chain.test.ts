import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Shapes only. The filler is not a key, and the assertions below are about WHERE a configured
// endpoint is allowed to appear, not about its contents.
const KEYED = 'https://robinhood-testnet.g.alchemy.com/v2/aB3dEf6hIj9lMn0pQr3tUv6xYz9bCd2e'
const SECOND = 'https://frosty-x.robinhood-mainnet.quiknode.pro/7f3a91c05e2b48d6a1f09c7e3b5d820a'

const PUBLIC_TESTNET = 'https://rpc.testnet.chain.robinhood.com'
const PUBLIC_MAINNET = 'https://rpc.mainnet.chain.robinhood.com'

type Chain = typeof import('./chain')

/**
 * Load chain.ts against a given environment.
 *
 * chain.ts reads `import.meta.env` once at module scope, which is the behaviour under test - the
 * defect this file exists to catch was in the wiring, not in a pure function - so exercising it
 * means re-executing the module.
 *
 * ⚠️ Do this ONCE PER CONFIGURATION, never once per assertion. `vi.resetModules` clears the whole
 * registry, so every reload re-executes viem too; at one reload per test this file took longer than
 * vitest's 5 s default on a cold run and failed intermittently in review, on a different test each
 * time. Two configurations cover every assertion here.
 */
const loadChainWith = async (env: Record<string, string>): Promise<Chain> => {
  vi.unstubAllEnvs()
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  vi.resetModules()
  return await import('./chain')
}

afterAll(() => {
  vi.unstubAllEnvs()
})

describe('with a dedicated endpoint AND a proxy configured', () => {
  let chain: Chain

  // 20 s, not the 5 s default: this hook pays for the cold module graph, viem included.
  beforeAll(async () => {
    chain = await loadChainWith({
      VITE_RPC_URL: KEYED,
      VITE_RPC_URL_2: SECOND,
      VITE_RPC_PROXY_PATH: '/rpc',
    })
  }, 20_000)

  // wagmi's injected connector sends `rpcUrls: [chain.rpcUrls.default.http[0]]` in its
  // wallet_addEthereumChain request (@wagmi/core connectors/injected.js). MetaMask displays that URL
  // and then STORES it as the user's endpoint for the network, so anything private here is both
  // shown to every visitor and spent by every visitor's wallet from then on. Build #38 watched a
  // keyed URL go through that prompt.

  it('gives the wallet the public endpoint, never the configured one', () => {
    expect(chain.robinhoodTestnet.rpcUrls.default.http).toEqual([PUBLIC_TESTNET])
  })

  it('gives the wallet the public MAINNET endpoint too', () => {
    expect(chain.robinhoodMainnet.rpcUrls.default.http).toEqual([PUBLIC_MAINNET])
  })

  it('never offers the wallet the proxy on our own origin either', () => {
    // A proxy is ours to pay for. Handing it to the wallet would move every visitor's wallet traffic
    // onto our upstream quota permanently, which is the same bill as leaking the key and is easy to
    // wave through because "it is not a secret".
    expect(chain.robinhoodTestnet.rpcUrls.default.http).not.toContain('/rpc')
    expect(chain.robinhoodTestnet.rpcUrls.default.http[0]).toBe(PUBLIC_TESTNET)
  })

  it('offers the wallet exactly ONE url, the one the connector actually reads', () => {
    // The connector takes `http[0]` and ignores the rest, so a second entry would be a reassurance
    // nobody consumes.
    expect(chain.robinhoodTestnet.rpcUrls.default.http).toHaveLength(1)
  })

  it('sends the APP through the proxy first', () => {
    expect(chain.TESTNET_RPC_URLS[0]).toBe(`${window.location.origin}/rpc`)
  })

  it('keeps the dedicated endpoints available to the app behind the proxy', () => {
    // The wallet fix must not cost the app its good endpoint - that would trade one defect for a
    // silent downgrade onto a rate-limited public node.
    expect(chain.TESTNET_RPC_URLS).toContain(KEYED)
    expect(chain.TESTNET_RPC_URLS).toContain(SECOND)
  })

  it('keeps the public endpoint last for the app', () => {
    const urls = chain.TESTNET_RPC_URLS
    expect(urls[urls.length - 1]).toBe(PUBLIC_TESTNET)
  })
})

describe('with nothing configured', () => {
  let chain: Chain

  beforeAll(async () => {
    chain = await loadChainWith({
      VITE_RPC_URL: '',
      VITE_RPC_URL_2: '',
      VITE_RPC_PROXY_PATH: '',
    })
  }, 20_000)

  it('falls back to the public endpoint alone', () => {
    expect(chain.TESTNET_RPC_URLS).toEqual([PUBLIC_TESTNET])
  })

  it('still gives the wallet the public endpoint', () => {
    expect(chain.robinhoodTestnet.rpcUrls.default.http).toEqual([PUBLIC_TESTNET])
  })
})
