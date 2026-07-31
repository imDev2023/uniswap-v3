/**
 * A minimal GraphQL-over-HTTP client.
 *
 * ## Why this exists rather than `graphql-request`
 *
 * Measured from the production sourcemap, the `graphql` package was **142 kB of source, 7.7% of the
 * whole bundle** - the complete lexer, parser, visitor and printer. None of it did any work for us.
 * We send queries as strings; `graphql-request`'s `analyzeDocument` parsed each one into an AST
 * purely to read the operation name off it, then threw the AST away and sent the original string.
 * A full round trip through a parser to learn something we never used.
 *
 * No option removes it. `excludeOperationName` skips the `parse()` CALL but the import is static,
 * so the parser still ships. Dropping the dependency is the only thing that drops the bytes, and
 * what we actually need from it is one `fetch` with a JSON body.
 *
 * ⚠️ For the record, this was NOT the suspect the ticket named. The standing hypothesis was that
 * wagmi dragged in unused WalletConnect and MetaMask SDKs because we only ever use the injected
 * connector. The bundle says otherwise: it contains no WalletConnect, Coinbase or MetaMask SDK at
 * all - only a couple of connector NAME strings, which is tree-shaking already working correctly.
 * The hypothesis had been carried in the docs for several builds without being measured.
 *
 * ## The error contract, which is load-bearing
 *
 * Stage 2 made an unreachable indexer a first-class UI state, and `fetchMeta`'s own doc comment
 * says it plainly: *"Throws when the endpoint is unreachable - that throw IS the down signal."*
 * react-query turns a rejection into `isError`, which drives the global banner and every per-panel
 * degraded notice. So this client must reject in every case the old one rejected in, or those
 * states silently stop appearing - the same failure mode as the graph-node `timestamp: null` bug
 * found earlier in this build, where degradation existed but never fired.
 *
 * Three failure modes, all of which must throw:
 *   1. the request never completes (DNS, refused, CORS, offline) - `fetch` rejects on its own
 *   2. a non-2xx response - graph-node answers 400 for a malformed query and 5xx while restarting
 *   3. a 200 carrying GraphQL `errors` - the "successful failure" that is easiest to miss
 */

export interface GraphQLRequestError extends Error {
  /** HTTP status, when the failure was at the transport level rather than in the response body. */
  status?: number
}

function fail(message: string, status?: number): never {
  const error = new Error(message) as GraphQLRequestError
  if (status !== undefined) error.status = status
  throw error
}

/**
 * Convenience passthrough tag, kept so queries keep their `gql` marker.
 *
 * Purely cosmetic at runtime - it concatenates the template into a string, exactly as
 * `graphql-request`'s own `gql` did (its source calls itself a "convenience passthrough" and warns
 * it does not parse). What it buys is tooling: editors, Prettier and GraphQL linters key off a tag
 * literally named `gql` to syntax-highlight and format embedded queries.
 */
export function gql(chunks: TemplateStringsArray, ...values: unknown[]): string {
  return chunks.reduce(
    (acc, chunk, i) => acc + chunk + (i < values.length ? String(values[i]) : ''),
    '',
  )
}

export class GraphQLClient {
  private readonly fetchImpl: typeof fetch

  constructor(
    private readonly url: string,
    fetchImpl?: typeof fetch,
  ) {
    // ⚠️ Wrapped, NOT stored bare as `= fetch`. A bare reference becomes a method on the instance,
    // so `this.fetchImpl(...)` invokes it with `this` bound to the client - and the browser's
    // `fetch` is hard-bound to `window`, so it throws `TypeError: Failed to execute 'fetch' on
    // 'Window': Illegal invocation`. The arrow function keeps the global call site intact.
    //
    // Every unit test injects a mock, which has no `this` requirement, so the whole suite passed
    // while the ONLY path production takes was broken. Found by loading the page, not by testing -
    // and `defaultFetchIsCallable` below now covers the default explicitly.
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init))
  }

  async request<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    })

    if (!res.ok) fail(`Subgraph responded ${res.status}`, res.status)

    // A body that is not JSON means something other than graph-node answered - a proxy error page,
    // a captive portal, a tunnel that dropped. `res.json()` would throw a SyntaxError naming a
    // character position, which tells a reader nothing.
    let body: { data?: T; errors?: { message?: string }[] }
    try {
      body = (await res.json()) as typeof body
    } catch {
      return fail('Subgraph returned a non-JSON response')
    }

    // GraphQL reports query-level failures inside a 200. Treating that as success is how a UI ends
    // up rendering an empty state for data that failed to load.
    if (body.errors?.length) {
      const first = body.errors[0]?.message ?? 'unknown error'
      const more = body.errors.length > 1 ? ` (+${body.errors.length - 1} more)` : ''
      fail(`Subgraph query failed: ${first}${more}`)
    }

    // `data` absent with no `errors` should not happen, but a null here would surface far away as
    // "cannot read property of undefined" in whichever fetcher unwrapped it.
    if (body.data == null) fail('Subgraph returned no data')

    return body.data
  }
}
