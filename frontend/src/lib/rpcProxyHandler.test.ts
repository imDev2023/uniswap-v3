import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_BODY_BYTES, handleRpc } from './rpcProxyHandler'

// The key is written out in full here on purpose: several of these tests assert that this exact
// string does NOT appear somewhere, and an assertion about a placeholder would pass whatever the
// code did with a real one.
const KEY = 'aaaabbbbccccddddeeeeffff00001111'
const UPSTREAM = `https://robinhood-testnet.g.alchemy.com/v2/${KEY}`
const ENV = { RPC_UPSTREAM_URL: UPSTREAM }

const CALL = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] })

const post = (body = CALL, headers: Record<string, string> = {}): Request =>
  new Request('https://octopus.example/rpc', { method: 'POST', body, headers })

let fetchMock: ReturnType<typeof vi.fn>

/** The Request the code under test handed to `fetch`. */
const forwarded = (): Request => fetchMock.mock.calls[0][0] as Request

beforeEach(() => {
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  )
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('handleRpc', () => {
  describe('the request it forwards', () => {
    // The whole point of the proxy. `/rpc` must not survive into the upstream URL, because a
    // path-joining proxy produces `/v2/<key>/rpc` and every managed provider 404s it.
    it('sends the upstream URL verbatim, with the incoming path discarded', async () => {
      await handleRpc(post(), ENV)
      expect(forwarded().url).toBe(UPSTREAM)
      expect(forwarded().url).not.toContain('/rpc')
    })

    it('forwards the body unchanged', async () => {
      await handleRpc(post(), ENV)
      await expect(forwarded().text()).resolves.toBe(CALL)
    })

    it('forwards as POST', async () => {
      await handleRpc(post(), ENV)
      expect(forwarded().method).toBe('POST')
    })

    it("carries over the caller's content-type, defaulting to JSON", async () => {
      await handleRpc(post(CALL, { 'content-type': 'application/json-rpc' }), ENV)
      expect(forwarded().headers.get('content-type')).toBe('application/json-rpc')
    })

    // Headers are built from nothing rather than filtered, and this is the assertion that says so.
    // A denylist that forgot an entry would send a visitor's credentials to a third-party provider,
    // and would look identical in review.
    it.each(['cookie', 'authorization', 'referer', 'x-forwarded-for'])(
      'does not pass the caller\'s "%s" through to the provider',
      async (header) => {
        await handleRpc(post(CALL, { [header]: 'caller-supplied-value' }), ENV)
        expect(forwarded().headers.get(header)).toBeNull()
      },
    )

    // Host must come from the upstream URL, not from our own domain. Getting this wrong reaches the
    // wrong virtual host or fails the TLS handshake, and the symptom is a provider error rather
    // than anything that points at the header.
    //
    // ⚠️ The fixture SEEDS an inbound Host, and that is the whole test. A real Worker always
    // receives one; an earlier version of this asserted against a request that had none, so
    // `host: request.headers.get('host') ?? ''` - the realistic mutation - left it green.
    it('never forwards the inbound Host header', async () => {
      await handleRpc(post(CALL, { host: 'octopus.example' }), ENV)
      expect(forwarded().headers.get('host')).not.toBe('octopus.example')
    })

    // Stronger than any denylist of individual header names, and the reason those `it.each` cases
    // above cannot go stale: the forwarded set is asserted EXACTLY, so a header nobody thought to
    // write a case for still fails here.
    it('forwards exactly three headers and nothing else', async () => {
      await handleRpc(
        post(CALL, { host: 'octopus.example', cookie: 'session=1', 'x-real-ip': '1.2.3.4' }),
        ENV,
      )
      expect([...forwarded().headers.keys()].sort()).toEqual([
        'accept',
        'content-type',
        'user-agent',
      ])
    })
  })

  describe('the answer it returns', () => {
    it('passes a successful upstream response through with its status', async () => {
      const response = await handleRpc(post(), ENV)
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ jsonrpc: '2.0', id: 1, result: '0x1' })
    })

    it('forbids caching, so one caller never receives another caller\'s chain state', async () => {
      const response = await handleRpc(post(), ENV)
      expect(response.headers.get('cache-control')).toBe('no-store')
    })

    it('sends no CORS header, so the quota is not offered to every other origin', async () => {
      const response = await handleRpc(post(), ENV)
      expect(response.headers.get('access-control-allow-origin')).toBeNull()
    })

    // ⚠️ `_headers` does not reach a Pages Function - measured against `wrangler pages dev`, where
    // the app shell carried all eight headers and `/rpc` carried none. So the Function sets its own,
    // and these assertions are what stop that from being quietly dropped later. Asserted on EVERY
    // reply, not just the happy path, because an error reply is a response the browser sees too.
    it.each([
      ['a proxied success', async () => handleRpc(post(), ENV)],
      ['a refused method', async () => handleRpc(new Request('https://o.example/rpc'), ENV)],
      ['a configuration failure', async () => handleRpc(post(), {})],
    ])('hardens %s, since _headers never reaches this route', async (_label, act) => {
      const response = await act()
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(response.headers.get('x-frame-options')).toBe('DENY')
      expect(response.headers.get('strict-transport-security')).toContain('max-age=')
      expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
      expect(response.headers.get('cache-control')).toBe('no-store')
    })

    // The leak that runs BACKWARDS through the proxy: a provider rejecting a key quotes it, and a
    // pass-through would publish it to every visitor from inside the route built to hide it.
    it('redacts a credential the upstream quotes back in an error body', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(`{"error":"invalid api key: ${UPSTREAM}"}`, {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      )
      const response = await handleRpc(post(), ENV)
      const text = await response.text()

      expect(response.status).toBe(401)
      expect(text).not.toContain(KEY)
      // Redacted rather than swallowed - a misconfigured upstream has to stay diagnosable.
      expect(text).toContain('REDACTED')
      expect(text).toContain('invalid api key')
    })
  })

  describe('what it refuses', () => {
    it.each(['GET', 'PUT', 'DELETE', 'HEAD'])('refuses %s without contacting the upstream', async (method) => {
      const response = await handleRpc(new Request('https://octopus.example/rpc', { method }), ENV)
      expect(response.status).toBe(405)
      expect(response.headers.get('allow')).toBe('POST')
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it.each([
      ['unset', undefined],
      ['blank', ''],
      ['not a URL', 'not-a-url'],
      ['the wrong scheme', 'wss://host.example/v2/key'],
    ])('answers 500 when RPC_UPSTREAM_URL is %s, and contacts nobody', async (_label, value) => {
      const response = await handleRpc(post(), { RPC_UPSTREAM_URL: value })
      expect(response.status).toBe(500)
      expect(fetchMock).not.toHaveBeenCalled()
      // Names the variable the operator has to set - the only thing they can act on.
      await expect(response.text()).resolves.toContain('RPC_UPSTREAM_URL')
    })

    it('never echoes the misconfigured upstream back to the caller', async () => {
      const response = await handleRpc(post(), { RPC_UPSTREAM_URL: `wss://host.example/v2/${KEY}` })
      const text = await response.text()
      expect(text).not.toContain(KEY)
      expect(text).not.toContain('host.example')
    })

    it('refuses a body over the cap without spending it upstream', async () => {
      const response = await handleRpc(post('x'.repeat(MAX_BODY_BYTES + 1)), ENV)
      expect(response.status).toBe(413)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    // The boundary itself, not only the refusal. A cap that rejected the largest legal body would
    // brick real traffic and a revert-only test would never notice.
    it('accepts a body exactly at the cap', async () => {
      const response = await handleRpc(post('x'.repeat(MAX_BODY_BYTES)), ENV)
      expect(response.status).toBe(200)
      expect(fetchMock).toHaveBeenCalled()
    })

    // 502 specifically, because viem's `fallback` advances on a transport error but not on a
    // successful response carrying an unparseable body.
    it('reports an unreachable upstream as 502 rather than as a broken success', async () => {
      fetchMock.mockRejectedValueOnce(new TypeError('network error'))
      const response = await handleRpc(post(), ENV)
      expect(response.status).toBe(502)
      await expect(response.json()).resolves.toMatchObject({ jsonrpc: '2.0' })
    })

    it('does not leak the upstream URL in a connection-failure message', async () => {
      fetchMock.mockRejectedValueOnce(new TypeError(`connect ECONNREFUSED ${UPSTREAM}`))
      const response = await handleRpc(post(), ENV)
      await expect(response.text()).resolves.not.toContain(KEY)
    })
  })
})
