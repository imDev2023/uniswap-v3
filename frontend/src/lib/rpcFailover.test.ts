import { getClient } from 'wagmi/actions'
import { RpcRequestError, createPublicClient, custom, fallback } from 'viem'
import { describe, expect, it } from 'vitest'
import { MAINNET_RPC_URLS, TESTNET_RPC_URLS, activeChain, robinhoodMainnet } from '../config/chain'
import { FALLBACK_OPTIONS, failover, wagmiConfig } from './wagmi'

// These tests pin viem's FAILOVER SEMANTICS, not our code. That is deliberate: the whole value of
// the fallback transport in src/lib/wagmi.ts rests on exactly which errors make viem advance to the
// next provider, and that is a property of viem's `shouldThrow`, not of anything we wrote. A viem
// upgrade that changes it would silently turn our redundancy into either dead weight (never
// advancing) or a correctness bug (replaying reverting calls against every provider).
//
// The error shapes below are the real ones measured against Robinhood Chain mainnet 4663 - see
// docs/rpc-capability.md. `-32000` is what the node returns when the pool member answering the
// request has pruned the state being asked for.

const rpcError = (code: number, message: string) =>
  new RpcRequestError({ body: {}, error: { code, message }, url: 'http://mock' })

/** A transport that always fails with `error`, recording that it was consulted. */
function failing(error: Error, log: string[], name: string) {
  return custom({
    async request() {
      log.push(name)
      throw error
    },
  })
}

/** A transport that always succeeds, recording that it was consulted. */
function serving(result: unknown, log: string[], name: string) {
  return custom({
    async request() {
      log.push(name)
      return result
    },
  })
}

// FALLBACK_OPTIONS is imported from wagmi.ts rather than restated, so these assertions describe the
// transport the app actually ships. An earlier version passed `retryCount: 0` here while production
// used viem's default of 3, which meant the tests could not have caught a retry-behaviour change.
const clientOver = (transports: ReturnType<typeof custom>[]) =>
  createPublicClient({
    chain: robinhoodMainnet,
    transport: fallback(transports, FALLBACK_OPTIONS),
  })

describe('fallback transport behaviour on real Robinhood Chain errors', () => {
  it('advances to the second provider when the first has pruned the state', async () => {
    // The measured failure mode: one URL fronts a pool of nodes with differing retention, so a
    // historical read misses intermittently. This is the entire reason for a second provider.
    const log: string[] = []
    const client = clientOver([
      failing(rpcError(-32000, 'missing trie node a8bdbae6 (path ) state 0xa8bdbae6'), log, 'a'),
      serving('0xdead', log, 'b'),
    ])

    await expect(client.request({ method: 'eth_call' } as never)).resolves.toBe('0xdead')
    expect(log).toEqual(['a', 'b'])
  })

  it('advances on the other pruned-state message the node returns', async () => {
    // The same depth returns either message depending on which node answers - both must fail over.
    const log: string[] = []
    const client = clientOver([
      failing(rpcError(-32000, 'metadata is not found, 2170256'), log, 'a'),
      serving('0xdead', log, 'b'),
    ])

    await expect(client.request({ method: 'eth_call' } as never)).resolves.toBe('0xdead')
    expect(log).toEqual(['a', 'b'])
  })

  it('does NOT replay a reverting call against the second provider', async () => {
    // A revert is a real answer, not an outage. Cascading it would double load and latency on every
    // failed quote, and every provider would return the same revert anyway.
    const log: string[] = []
    const client = clientOver([
      failing(rpcError(3, 'execution reverted: STF'), log, 'a'),
      serving('0xdead', log, 'b'),
    ])

    await expect(client.request({ method: 'eth_call' } as never)).rejects.toThrow()
    expect(log).toEqual(['a'])
  })

  it('stops on a revert reported under Nitro\'s -32000 code, not just code 3', async () => {
    // viem decides this on the MESSAGE (`ExecutionRevertedError.nodeMessage`), not the code - code 3
    // is not in shouldThrow's code list at all. That matters here because Robinhood Chain is Nitro,
    // which reports plenty of conditions under -32000. Same code as the pruned-state cases above,
    // opposite handling: this is the assertion that proves the tests discriminate on content.
    const log: string[] = []
    const client = clientOver([
      failing(rpcError(-32000, 'execution reverted'), log, 'a'),
      serving('0xdead', log, 'b'),
    ])

    await expect(client.request({ method: 'eth_call' } as never)).rejects.toThrow()
    expect(log).toEqual(['a'])
  })

  it('serves entirely from the primary while it is healthy', async () => {
    // rank: false means strict preference. The public endpoint sits last precisely so it is never
    // chosen on latency grounds while a dedicated provider is up.
    const log: string[] = []
    const client = clientOver([serving('0xbeef', log, 'a'), serving('0xdead', log, 'b')])

    await expect(client.request({ method: 'eth_call' } as never)).resolves.toBe('0xbeef')
    expect(log).toEqual(['a'])
  })

  it('surfaces the failure when every provider is down', async () => {
    // Failover is not magic: with no healthy endpoint the app must see an error, because RPC is the
    // one dependency with no degraded mode to fall back to.
    const log: string[] = []
    const client = clientOver([
      failing(rpcError(-32000, 'metadata is not found, 1'), log, 'a'),
      failing(rpcError(-32000, 'metadata is not found, 1'), log, 'b'),
    ])

    await expect(client.request({ method: 'eth_call' } as never)).rejects.toThrow()
    expect(log).toEqual(['a', 'b'])
  })
})

// The tests above prove viem fails over correctly. These prove OUR CONFIG actually asks it to.
// Without them, replacing the fallback in wagmi.ts with a plain http() passes the whole suite -
// verified by mutation, and the same wiring-vs-logic gap that SwapPage.test.tsx exists to close.
describe('wagmiConfig wiring', () => {
  it('gives the active chain a fallback transport, not a single endpoint', () => {
    const transport = getClient(wagmiConfig)!.transport
    expect(transport.type).toBe('fallback')
  })

  it('hands viem every resolved endpoint for the active chain', () => {
    const expected = activeChain.id === robinhoodMainnet.id ? MAINNET_RPC_URLS : TESTNET_RPC_URLS
    const transport = getClient(wagmiConfig)!.transport
    expect(transport.transports).toHaveLength(expected.length)
  })

  it('builds a fallback for each declared chain', () => {
    // Both chains are declared so the config typechecks regardless of VITE_CHAIN_ID; neither may
    // silently degrade to a bare http().
    for (const urls of [MAINNET_RPC_URLS, TESTNET_RPC_URLS]) {
      const built = failover(urls)({ chain: robinhoodMainnet })
      expect(built.config.type).toBe('fallback')
      expect(built.value?.transports).toHaveLength(urls.length)
    }
  })
})
