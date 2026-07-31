import { describe, expect, it, vi } from 'vitest'
import { GraphQLClient, gql } from './graphqlClient'

/**
 * The error contract is the point of this file.
 *
 * These assertions replace a dependency's behaviour, so they are not testing our own cleverness -
 * they pin the exact rejection cases Stage 2 relies on. `fetchMeta`'s throw IS the indexer-down
 * signal; react-query turns it into `isError`, which drives the global banner and every per-panel
 * degraded notice. A client that resolves where the old one rejected would silently disable all of
 * that while every test still passed - precisely the failure mode found earlier in this build,
 * where graph-node's null timestamp left the degradation system present but inert.
 */

const URL = 'https://subgraph.example/graphql'

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: () => Promise.resolve(body) } as unknown as Response
}

describe('gql', () => {
  it('concatenates the template, exactly as the passthrough tag it replaces did', () => {
    const first = 50
    expect(gql`{ tokens(first: ${first}) { id } }`).toBe('{ tokens(first: 50) { id } }')
  })

  it('handles a template with no interpolations', () => {
    expect(gql`{ id }`).toBe('{ id }')
  })
})

describe('GraphQLClient default transport', () => {
  it('calls the global fetch without rebinding `this`', async () => {
    // The regression this exists for. Storing `fetch` bare as a class field made
    // `this.fetchImpl(...)` invoke it with `this` set to the client instance, and the browser's
    // `fetch` is hard-bound to `window` - so every real request died with "Illegal invocation"
    // while all other tests passed, because they all inject a mock that has no `this` requirement.
    //
    // Constructing WITHOUT a fetchImpl is the whole point: it exercises the default, which is the
    // only path production ever takes.
    const globalFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(function (this: unknown) {
        // A real browser fetch throws when `this` is anything other than window/undefined.
        if (this !== undefined && this !== globalThis) {
          throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation")
        }
        return Promise.resolve(jsonResponse({ data: { ok: true } }))
      } as unknown as typeof fetch)

    try {
      const client = new GraphQLClient(URL)
      await expect(client.request('{ ok }')).resolves.toEqual({ ok: true })
    } finally {
      globalFetch.mockRestore()
    }
  })
})

describe('GraphQLClient.request', () => {
  it('posts the query and variables as JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: { ok: true } }))
    const client = new GraphQLClient(URL, fetchImpl)

    await client.request('{ tokens { id } }', { first: 10 })

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(URL)
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(init.body)).toEqual({ query: '{ tokens { id } }', variables: { first: 10 } })
  })

  it('unwraps `data`, so callers see the payload and not the envelope', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: { tokens: [{ id: '0x1' }] } }))
    const client = new GraphQLClient(URL, fetchImpl)
    await expect(client.request('{ tokens { id } }')).resolves.toEqual({ tokens: [{ id: '0x1' }] })
  })

  it('rejects when the request never completes - the indexer-down signal', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    const client = new GraphQLClient(URL, fetchImpl)
    await expect(client.request('{ x }')).rejects.toThrow(/failed to fetch/i)
  })

  it('rejects on a non-2xx response and keeps the status', async () => {
    // graph-node answers 5xx while restarting and 400 on a malformed query. Both are outages from
    // the UI's point of view and neither may resolve.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, false, 503))
    const client = new GraphQLClient(URL, fetchImpl)
    await expect(client.request('{ x }')).rejects.toThrow(/503/)
  })

  it('rejects on GraphQL errors returned inside a 200', async () => {
    // The "successful failure": HTTP is fine, the query is not. Treating it as success is how a UI
    // renders a confident empty state for data that never loaded.
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ errors: [{ message: 'Field "nope" does not exist' }] }),
    )
    const client = new GraphQLClient(URL, fetchImpl)
    await expect(client.request('{ nope }')).rejects.toThrow(/does not exist/)
  })

  it('mentions how many further errors there were, without dumping all of them', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ errors: [{ message: 'first' }, { message: 'second' }, { message: 'third' }] }),
    )
    const client = new GraphQLClient(URL, fetchImpl)
    await expect(client.request('{ x }')).rejects.toThrow(/first \(\+2 more\)/)
  })

  it('rejects when the body is not JSON at all', async () => {
    // A proxy error page or captive portal. Left to `res.json()` this surfaces as a SyntaxError
    // about a character offset, which tells a reader nothing about what went wrong.
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('Unexpected token <')),
    } as unknown as Response)
    const client = new GraphQLClient(URL, fetchImpl)
    await expect(client.request('{ x }')).rejects.toThrow(/non-JSON/)
  })

  it('rejects a 200 with neither data nor errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}))
    const client = new GraphQLClient(URL, fetchImpl)
    await expect(client.request('{ x }')).rejects.toThrow(/no data/)
  })

  it('resolves when `data` is present alongside an empty errors array', async () => {
    // An empty array is not an error, and rejecting on its presence would break normal responses.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: { tokens: [] }, errors: [] }))
    const client = new GraphQLClient(URL, fetchImpl)
    await expect(client.request('{ tokens { id } }')).resolves.toEqual({ tokens: [] })
  })

  it('resolves a legitimately null field without treating it as a missing payload', async () => {
    // `{ token: null }` is a real answer - the token is not indexed - and several fetchers return
    // exactly this. Only a null `data` envelope is a fault.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: { token: null } }))
    const client = new GraphQLClient(URL, fetchImpl)
    await expect(client.request('{ token { id } }')).resolves.toEqual({ token: null })
  })
})
