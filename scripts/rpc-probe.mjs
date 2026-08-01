#!/usr/bin/env node
// Octopus RPC capability probe.
//
// Measures the things Stage 4 depends on for a given JSON-RPC endpoint:
//   - identity (chain id, client, head, block time, chain age, clock skew)
//   - eth_getLogs retention depth   <- the one that decides whether re-indexing is possible
//   - eth_getLogs query limits (block-span threshold and matched-log cap)
//   - historical state (archive) depth, and whether `latest` is queryable
//   - presence of the contracts the stack reads (Multicall3, WETH9, USDG)
//   - batch-request support, concurrency, rate limiting, method availability
//
// The chain is the source of truth and Postgres is a derived cache, but that only
// holds while the node will still serve logs from the deploy block. If retention is
// shallower than the deployment age, a lost indexer DB becomes unrecoverable data
// loss rather than an availability incident. That is what this script measures.
//
// STRICTLY READ-ONLY. It never signs or sends a transaction.
//
// Usage:
//   node scripts/rpc-probe.mjs mainnet
//   node scripts/rpc-probe.mjs testnet
//   node scripts/rpc-probe.mjs https://some-candidate-provider.example/rpc
//   node scripts/rpc-probe.mjs mainnet --json probe-mainnet.json
//   node scripts/rpc-probe.mjs https://throttled-candidate.example/rpc --min-interval 10000
//   node scripts/rpc-probe.mjs --self-test        # offline; no network, no endpoint needed
//
// --min-interval sets a floor on the gap between calls, for a candidate whose published limit is
// already known. The floor also self-tunes upward on throttling; see the "pacing" section below.
// A full run is ~150 calls, so budget accordingly (10 s floor => ~25 min).
//
// A keyed provider URL is safe to pass here: `maskEndpoint` redacts the credential before anything
// is printed or written, so neither the terminal nor a `--json` file ends up holding it.
//
// No dependencies; needs Node 18+ for global fetch.

import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'

const ALIASES = {
  mainnet: 'https://rpc.mainnet.chain.robinhood.com',
  testnet: 'https://rpc.testnet.chain.robinhood.com',
}

/** Query parameters that carry credentials rather than routing. */
const SECRET_QUERY_KEYS = /^(api[-_]?key|key|token|access[-_]?token|auth)$/i

/** URL-safe sentinel, swapped for `<key>` after serialisation so `URL` does not escape it. */
const PLACEHOLDER = 'kEyReDaCtEdSeNtInEl'

/**
 * Redacts the credential out of an endpoint URL, for display and for `--json`.
 *
 * This probe began life against the chains' keyless public endpoints, where the URL was pure
 * routing information and printing it was free. It is now pointed at metered providers whose key
 * lives IN the URL (`https://<chain>.g.alchemy.com/v2/<key>`, `https://<host>.quiknode.pro/<key>/`),
 * so the header line and the `--json` report both became ways to spill a secret - the report
 * silently, into a file no `.gitignore` rule covers. Masking here means neither can, rather than
 * relying on whoever pastes the output to remember a `sed`.
 *
 * Keys are opaque high-entropy segments, so length is the discriminator: real path segments in
 * these URLs (`v2`, `rpc`) are short, and a 16+ character segment is not something a human typed.
 * Display-only, so over-masking a legitimately long segment costs nothing.
 */
/**
 * Redacts credential-looking URLs out of free text before it is printed.
 *
 * Needed because provider failure bodies are echoed verbatim (`provider said: ...`), and a 401 page
 * or a CDN block page routinely quotes the request URL back - key included. Masking only the
 * endpoint header would leave that path open.
 */
const redactText = (text) =>
  String(text).replace(/https?:\/\/[^\s"'<>]+/g, (m) => maskEndpoint(m))

function maskEndpoint(raw) {
  let u
  try {
    u = new URL(raw)
  } catch {
    return String(raw)
  }
  u.pathname = u.pathname
    .split('/')
    .map((seg) => (/^[A-Za-z0-9_-]{16,}$/.test(seg) ? PLACEHOLDER : seg))
    .join('/')
  for (const k of [...u.searchParams.keys()]) {
    if (SECRET_QUERY_KEYS.test(k)) u.searchParams.set(k, PLACEHOLDER)
  }
  // `URL.toString()` percent-encodes the angle brackets, which would print `%3Ckey%3E` and read as
  // gibberish rather than as a redaction. Substituting after serialisation keeps the placeholder
  // spelled the way the docs spell it.
  return u.toString().split(PLACEHOLDER).join('<key>')
}

// Canonical addresses. WETH9 differs per chain, so the probe resolves it by chain id
// after identity is known - Constants.WETH9 in Solidity is mainnet-only and has no
// code on 46630, which is exactly the kind of thing this probe should catch.
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'
const WETH9_BY_CHAIN = {
  4663: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  46630: '0x7943e237c7F95DA44E0301572D358911207852Fa',
}
const USDG_MAINNET = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'

// ---------------------------------------------------------------- rpc plumbing

const stats = { calls: 0, rateLimited: 0, timeouts: 0, paceBumps: 0 }

const hex = (n) => '0x' + BigInt(n).toString(16)
const toNum = (h) => Number(BigInt(h))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------------------ pacing
//
// Candidate providers throttle far harder than the official endpoint, and the FIRST version of this
// probe reported one of them as "endpoint unusable" when it was merely slow: NodeFlare's keyless
// endpoint allows 1 request per 10 s, so the four concurrent identity calls all 429'd and the probe
// gave up. That is measurement trap #4 - a throttle misread as an incapability - and it matters more
// now that this script is the provider-EVALUATION harness, because it would silently reject every
// aggressively-rate-limited candidate.
//
// So pacing is adaptive: every 429 raises a global floor on the interval between calls, and the
// probe keeps going at the slower rate instead of concluding the endpoint is broken. --min-interval
// sets that floor up front when the published limit is already known.

const PACE_CEILING_MS = 20_000

let minIntervalMs = 0
let lastCallAt = 0
let paceChain = Promise.resolve()

/**
 * Wait for this call's turn. Acquisition is serialized through a promise chain so that pacing still
 * holds when callers fire requests concurrently - otherwise the burst test would defeat it.
 */
function acquirePace() {
  if (minIntervalMs <= 0) return Promise.resolve()
  const turn = paceChain.then(async () => {
    const waitMs = lastCallAt + minIntervalMs - Date.now()
    if (waitMs > 0) await sleep(waitMs)
    lastCallAt = Date.now()
  })
  paceChain = turn.catch(() => {})
  return turn
}

/** Raise the pacing floor after a throttle response. Returns the new interval. */
function bumpPace() {
  const next = Math.min(minIntervalMs === 0 ? 1_000 : minIntervalMs * 2, PACE_CEILING_MS)
  if (next !== minIntervalMs) {
    minIntervalMs = next
    stats.paceBumps++
  }
  return minIntervalMs
}

/**
 * Some providers signal throttling in the BODY with HTTP 200, or with a JSON body whose `error` is a
 * bare string rather than a JSON-RPC error object. Both look like garbage to a strict parser, which
 * is how a throttle ends up reported as a protocol failure.
 */
// Deliberately NARROW. An earlier version also matched a bare "429" and the word "quota", which made
// any successful reply whose result merely contained those characters - a block number like 0x429ab1
// - read as a refusal. A false throttle is worse than a missed one: it retries a call that already
// succeeded and ratchets the global pace on the strength of a coincidence.
const RATE_LIMIT_PATTERN = /rate.?limit|too many requests|slow down|request quota/i

/** Statuses that mean "throttled/blocked" even when the body is an opaque HTML page. */
const THROTTLE_STATUSES = new Set([403, 429, 503])

// Some providers report throttling as a properly-enveloped JSON-RPC error rather than an HTTP status
// - Alchemy returns HTTP 200 with `{ code: 429 }`, and -32005 is the standard "limit exceeded". viem
// special-cases these same two codes for the same reason. Without them a throttle from the provider
// we are most likely to evaluate next would read as a real node answer, and the probe would never
// back off. Note -32000 is deliberately absent: the eth_getLogs cap refusal uses it, and that is a
// query-too-big signal which must keep its own meaning (see trap #3).
const THROTTLE_RPC_CODES = new Set([429, -32005])

/**
 * A CDN interstitial (Cloudflare challenge, WAF block, 5xx page) arrives as HTML, sometimes under
 * HTTP 200. Measured on a real candidate: it serves JSON-RPC when idle and an HTML page under load.
 */
const isHtmlBody = (text) => /^\s*(<!doctype html|<html|<\?xml)/i.test(text)

/**
 * Decide what a reply IS before deciding what it means.
 *
 * Trap #4 cuts both ways and this is where both edges live. Treating a throttle as an incapability
 * retires a working provider; treating "not an RPC endpoint at all" as a throttle is just as wrong -
 * it tells the operator to slow down when the real problem is a typo'd URL, and burns the full
 * throttle-retry ladder doing it. So an HTML body only counts as throttling when it SAYS so or
 * arrives under a status that means so. Otherwise it is simply not JSON-RPC.
 */
function classifyReply(status, text) {
  if (status === 429) return 'throttled'
  const signalsThrottle = RATE_LIMIT_PATTERN.test(text)
  if (isHtmlBody(text)) {
    return THROTTLE_STATUSES.has(status) || signalsThrottle ? 'throttled' : 'not-rpc'
  }
  const body = text.trimStart()
  const jsonShaped = body.startsWith('{') || body.startsWith('[')
  if (jsonShaped) {
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      // Malformed JSON is handled by the caller's own parse; fall through to the text heuristics.
    }
    const code =
      parsed && !Array.isArray(parsed) && parsed.error && typeof parsed.error === 'object'
        ? parsed.error.code
        : undefined
    if (typeof code === 'number' && THROTTLE_RPC_CODES.has(code)) return 'throttled'
  }
  // Any remaining throttle wording counts, wherever it sits: a bare string in `error` instead of a
  // JSON-RPC error object, a plain-text body, or a throttle reported under a non-standard code.
  // This used to additionally require the JSON-RPC envelope to be ABSENT, as a guard against a
  // legitimate result being misread. Mutation testing showed that guard was unreachable once
  // RATE_LIMIT_PATTERN was narrowed, and dropping it is strictly better: a throttle message carried
  // under a non-standard error code now backs off instead of being taken for a node answer.
  if (signalsThrottle) return 'throttled'
  if (!jsonShaped) return 'not-rpc'
  return 'proceed'
}

/** Seconds to a readable age. Retention windows range from minutes to weeks. */
function humanizeAge(sec) {
  if (sec < 3600) return `${(sec / 60).toFixed(0)} min`
  if (sec < 86400) return `${(sec / 3600).toFixed(1)} hours`
  return `${(sec / 86400).toFixed(1)} days`
}

/**
 * One JSON-RPC call. Never throws; returns a discriminated result so callers can
 * tell "the node said no" (a real capability limit) from "the network flaked".
 * Rate limits and timeouts are counted globally rather than silently absorbed,
 * so the transport section can report them instead of guessing.
 */
async function rpc(url, method, params = [], { timeoutMs = 30000, retries = 3 } = {}) {
  // Throttles get more patience than other failures, because the backoff has to be able to exceed
  // the provider's window (10 s on at least one real candidate) or every attempt burns inside it.
  // But `retries: 0` must stay honest: the burst test passes it precisely to get a raw per-request
  // verdict, and silently retrying throttles there would report "30/30 ok" for an endpoint that
  // refused most of the burst - turning the concurrency measurement into fiction.
  const throttleRetries = retries === 0 ? 0 : retries + 4
  let throttled = false
  for (let attempt = 0; ; attempt++) {
    stats.calls++
    await acquirePace()
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: ctrl.signal,
      })
      const text = await res.text()

      // Throttling is detected from status OR body, because providers signal it both ways - some
      // return HTTP 200 with a rate-limit payload, which a status-only check reads as a valid reply.
      const kind = classifyReply(res.status, text)
      if (kind === 'not-rpc') {
        // A real dead end, not a rate limit: this URL answered, but not with JSON-RPC. Retrying it
        // cannot help, so fail fast and let the caller report it as unusable.
        return {
          ok: false,
          transport: isHtmlBody(text)
            ? `not a JSON-RPC endpoint (HTML page, HTTP ${res.status}) - check the URL; a CDN page can also appear under heavy load`
            : `not a JSON-RPC endpoint (HTTP ${res.status})`,
          body: text.slice(0, 200),
        }
      }
      if (kind === 'throttled') {
        stats.rateLimited++
        throttled = true
        if (attempt < throttleRetries) {
          // The wait is the (rising) pacing floor rather than a fixed ramp, so the probe converges on
          // the provider's actual rate. Note the floor is raised ONLY on a path that retries: the
          // burst test throttles deliberately, and letting it ratchet the global pace would slow
          // every later section and report self-inflicted throttling as the provider's behaviour.
          const interval = bumpPace()
          await sleep(Math.max(interval, 1_500 * (attempt + 1)))
          continue
        }
        return {
          ok: false,
          transport: isHtmlBody(text)
            ? `CDN interstitial (HTML, HTTP ${res.status}) - challenge or throttle, not JSON-RPC`
            : 'rate limited',
          throttled: true,
          body: text.slice(0, 200),
        }
      }
      if (res.status >= 500) {
        if (attempt < retries) {
          await sleep(1500 * (attempt + 1))
          continue
        }
        return { ok: false, transport: `HTTP ${res.status}`, body: text.slice(0, 200) }
      }
      let json
      try {
        json = JSON.parse(text)
      } catch {
        return { ok: false, transport: 'non-JSON response', body: text.slice(0, 200), throttled }
      }
      // A JSON-RPC error object has a numeric `code`. A bare string (or any other shape) is the
      // provider talking about itself rather than about the request - usually an auth or plan error,
      // which must not be reported as though the chain refused the query.
      if (json.error !== undefined && json.error !== null) {
        if (typeof json.error === 'object' && typeof json.error.code === 'number') {
          // Deliberately does NOT carry `throttled` forward. A JSON-RPC error object is the node
          // answering the question, so the endpoint is usable and the error is about the request.
          // Flagging it as throttled would make probeIdentity print THROTTLED for a genuine
          // "method does not exist", which is the opposite of the distinction being drawn here.
          return { ok: false, error: json.error }
        }
        const message = typeof json.error === 'string' ? json.error : JSON.stringify(json.error)
        const detail = typeof json.message === 'string' ? `: ${json.message}` : ''
        return {
          ok: false,
          transport: `provider error (${message}${detail})`,
          throttled: throttled || RATE_LIMIT_PATTERN.test(text),
          body: text.slice(0, 200),
        }
      }
      if (json.result === undefined) {
        return { ok: false, transport: 'reply had neither result nor error', body: text.slice(0, 200) }
      }
      return { ok: true, result: json.result }
    } catch (err) {
      const timedOut = err.name === 'AbortError'
      if (timedOut) stats.timeouts++
      if (attempt < retries) {
        await sleep(500 * (attempt + 1))
        continue
      }
      return { ok: false, transport: timedOut ? 'timeout' : String(err), throttled }
    } finally {
      clearTimeout(timer)
    }
  }
}

const why = (r) => {
  if (r.error) {
    const code = r.error.code === undefined ? '?' : r.error.code
    return `${r.error.message ?? JSON.stringify(r.error)} (code ${code})`
  }
  return r.transport
}

/**
 * True when the failure is the node refusing an over-large query, not a real outage.
 *
 * Two different ceilings produce this, and BOTH have to be recognised or trap #3 comes back in a new
 * costume - a refusal that PROVES logs exist at a depth gets tallied as evidence of pruning:
 *
 *   - a RESULT-COUNT cap ("logs matched by query exceeds limit of 10000"), which is what the public
 *     Robinhood endpoints enforce, and
 *   - a BLOCK-RANGE cap ("you can make eth_getLogs requests with up to a 10 block range"), which is
 *     what a metered provider's free tier enforces. Measured 2026-08-01: Alchemy's free tier caps
 *     the range at 10 blocks on both Robinhood chains, and reports it as JSON-RPC code -32600.
 *
 * Missing the second one made this probe report `11 depth(s) failed for a NON-CAP reason` against an
 * endpoint whose logs were entirely intact - the exact inversion the doc warns about.
 *
 * The block-range clause requires a SIZE next to the words - either a number ("up to a 10 block
 * range") or an explicit "too large". A bare `/block range/` would also swallow "invalid block
 * range", i.e. a malformed request, and tally it as a cap: the mirror of the bug above, and the
 * failure mode that matters more, because widening this predicate until everything looks like a cap
 * makes the retention table incapable of ever reporting real pruning.
 */
const isQueryTooBig = (r) =>
  /exceeds limit|too many logs|response too large|\d+\s*[- ]?block range|block range (?:is )?too (?:large|big|wide)|timeout|timed out/i.test(
    why(r),
  )

/** The node states its own ceiling in the refusal text: "exceeds limit of 50000". */
const parseLimit = (r) => {
  const m = /exceeds limit of (\d+)/i.exec(why(r))
  return m ? Number(m[1]) : null
}

/**
 * A block-range refusal usually names the span it WOULD accept ("up to a 10 block range"). Honour it
 * rather than blindly dividing the span down: against a 10-block cap the divide-by-5 ladder burns
 * three extra round trips per depth, times every depth sampled.
 */
const parseRangeCap = (r) => {
  const m = /up to (?:a )?(\d+)[- ]block range/i.exec(why(r))
  return m ? Number(m[1]) : null
}

/**
 * Turns the sampled log windows into one verdict. Pure, so it can be pinned offline.
 *
 * The distinction that earns its keep: **an empty window is evidence of nothing unless the window
 * was wide enough to plausibly hold a log.** When the node's own range cap shrank the span, an empty
 * result describes the sample, not the node. Measured 2026-08-01 against a 10-block cap, windows
 * narrowed to a span of 2 came back empty on a chain whose logs were entirely intact, and the probe
 * duly warned about a possible silent pruner. Widening the span to 9 made that reading less likely
 * but not impossible - any quieter chain or tighter cap brings it straight back - so the two cases
 * are separated here rather than pooled, and a run that can only see through a keyhole reports
 * `inconclusive` instead of a verdict it has not earned.
 *
 * Ordering matters: a non-cap ERROR outranks emptiness, because a depth that failed outright tells
 * you nothing about whether logs are there, and reporting the empty-window story over it would
 * describe a broken measurement as a finding about the chain.
 */
function judgeLogRetention(samples) {
  const withLogs = samples.filter((s) => s.ok && s.count > 0)
  const oldestProven = withLogs.length ? withLogs[withLogs.length - 1] : null
  const errored = samples.filter((s) => !s.ok)
  const servedEmpty = samples.filter((s) => s.ok && s.count === 0)
  const emptyWide = servedEmpty.filter((s) => !s.capped)
  const emptyNarrow = servedEmpty.filter((s) => s.capped)

  let verdict
  if (errored.length) verdict = 'errors'
  else if (oldestProven && oldestProven.from <= 10_000) verdict = 'no-pruning'
  else if (emptyWide.length) verdict = 'empty-full-width'
  else if (emptyNarrow.length) verdict = 'inconclusive'
  else verdict = 'shallow'

  return { oldestProven, errored, emptyWide, emptyNarrow, verdict }
}

const RETENTION_VERDICT_TEXT = {
  'no-pruning': () => 'NO PRUNING - logs served and non-empty down to the genesis region',
  errors: (n) => `${n} depth(s) failed for a NON-CAP reason - inspect the table`,
  'empty-full-width': () => 'served at every depth, but full-width windows were empty - see warning',
  inconclusive: () => 'served at every depth; empty windows were all cap-narrowed - INCONCLUSIVE',
  shallow: () => 'logs served, but the deepest window with logs is above the genesis region',
}

/** One eth_getLogs call over [from, from+span], optionally address-filtered. */
async function getLogs(url, from, span, address = null, timeoutMs = 90000) {
  const filter = { fromBlock: hex(from), toBlock: hex(from + span) }
  if (address) filter.address = address
  return rpc(url, 'eth_getLogs', [filter], { timeoutMs })
}

// ------------------------------------------------------------------- reporting

const report = { probedAt: new Date().toISOString(), endpoint: null, sections: {} }
const lines = []

const section = (title) => lines.push('', `### ${title}`)
const row = (label, value) => lines.push(`  ${label.padEnd(32)} ${value}`)
const note = (text) => lines.push(`  ${text}`)

function emit(jsonOut) {
  console.log(lines.join('\n'))
  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify(report, null, 2))
    console.log(`\nJSON written to ${jsonOut}`)
  }
}

// ---------------------------------------------------------------------- probes

async function probeIdentity(url) {
  section('Identity')
  // Deliberately SEQUENTIAL. These four used to run concurrently, which is four requests in one
  // instant - enough to trip a strict per-IP limiter on the very first thing the probe does, and the
  // resulting 429 was then reported as "endpoint unusable". Identity is four cheap calls; there is
  // nothing to gain by racing them and a whole candidate to lose.
  const chainId = await rpc(url, 'eth_chainId')
  const clientVersion = await rpc(url, 'web3_clientVersion')
  const blockNumber = await rpc(url, 'eth_blockNumber')
  const syncing = await rpc(url, 'eth_syncing')

  if (!chainId.ok || !blockNumber.ok) {
    const failure = chainId.ok ? blockNumber : chainId
    if (failure.throttled) {
      // The distinction that matters for provider evaluation: this endpoint WORKS, we are just not
      // allowed to talk to it this fast. Reporting it as unusable would discard a viable candidate.
      row('THROTTLED', `cannot complete identity at this rate: ${why(failure)}`)
      if (failure.body) note(`  provider said: ${redactText(failure.body)}`)
      note('  The endpoint is responding, not broken. Re-run with a slower floor, e.g.')
      note(`  --min-interval 10000, or use an API key to lift the limit.`)
    } else {
      row('FATAL', `endpoint unusable: ${why(failure)}`)
      if (failure.body) note(`  provider said: ${redactText(failure.body)}`)
    }
    report.sections.identity = {
      reachable: false,
      throttled: Boolean(failure.throttled),
      reason: why(failure),
    }
    return null
  }
  const chain = toNum(chainId.result)
  const headBlock = toNum(blockNumber.result)
  row('chainId', `${chain}`)
  row('client', clientVersion.ok ? clientVersion.result : `unavailable (${why(clientVersion)})`)
  row('head block', headBlock.toLocaleString())
  row('eth_syncing', syncing.ok ? JSON.stringify(syncing.result) : `unavailable (${why(syncing)})`)

  const weth9 = WETH9_BY_CHAIN[chain] ?? null
  if (!weth9) row('WARN', `no known WETH9 for chain ${chain}; falling back to Multicall3 as probe target`)

  // Reference head-1: the node occasionally returns null for the block it just
  // reported as head.
  const refBlock = Math.max(1, headBlock - 1)
  const span = Math.min(10_000, refBlock)
  const [bNow, bThen, bFirst] = await Promise.all([
    rpc(url, 'eth_getBlockByNumber', [hex(refBlock), false]),
    rpc(url, 'eth_getBlockByNumber', [hex(refBlock - span), false]),
    rpc(url, 'eth_getBlockByNumber', ['0x1', false]),
  ])

  let blockTime = null
  if (bNow.ok && bThen.ok && bNow.result && bThen.result) {
    blockTime = (toNum(bNow.result.timestamp) - toNum(bThen.result.timestamp)) / span
    row('recent block time', `${blockTime.toFixed(3)} s  (over ${span.toLocaleString()} blocks)`)
  } else {
    row('recent block time', `could not measure (${why(bNow.ok ? bThen : bNow)})`)
  }

  // Chain age from block 1: block 0 carries timestamp 0 on this chain. The lifetime
  // average is reported alongside the recent rate because they differ sharply
  // (4663: ~0.35 s lifetime vs ~0.10 s recent), and extrapolating the recent rate
  // across all history would misstate every depth-to-age conversion.
  let chainAgeDays = null
  if (bFirst.ok && bFirst.result && bNow.ok && bNow.result) {
    const ageSec = toNum(bNow.result.timestamp) - toNum(bFirst.result.timestamp)
    chainAgeDays = ageSec / 86400
    row('chain age', `${chainAgeDays.toFixed(1)} days since block 1`)
    row('lifetime avg block time', `${(ageSec / refBlock).toFixed(3)} s`)
  }

  // Head timestamp vs local wall clock. Bracket the request so network latency is
  // bounded, and take the midpoint. This is only as accurate as the local clock,
  // which is stated rather than assumed away.
  const t0 = Date.now()
  const latest = await rpc(url, 'eth_getBlockByNumber', ['latest', false])
  const t1 = Date.now()
  let clockSkewSec = null
  if (latest.ok && latest.result) {
    clockSkewSec = Math.round((t0 + t1) / 2 / 1000) - toNum(latest.result.timestamp)
    row('head ts vs local clock', `${clockSkewSec >= 0 ? '+' : ''}${clockSkewSec} s (local clock assumed correct)`)
  }

  report.sections.identity = {
    chainId: chain,
    client: clientVersion.result ?? null,
    headBlock,
    recentBlockTime: blockTime,
    chainAgeDays: chainAgeDays === null ? null : Number(chainAgeDays.toFixed(1)),
    clockSkewSec,
  }

  return {
    url,
    chain,
    headBlock,
    blockTime,
    weth9,
    // A contract active across all history makes the best log filter; the state
    // probe needs one whose code must be loaded from the state trie.
    logAddr: weth9 ?? MULTICALL3,
    stateAddr: weth9 ?? MULTICALL3,
    stateData: weth9 ? '0x18160ddd' /* totalSupply() */ : '0x0f28c97d' /* getCurrentBlockTimestamp() */,
  }
}

/**
 * Find the densest of several sample regions, in logs per block.
 *
 * Sampled with a deliberately small span: measuring with a wide window would get
 * the densest regions refused as too large and silently drop them from the search,
 * which is the opposite of what this is for.
 */
async function findDenseRegion(ctx) {
  const PROBE_SPAN = 200
  const candidates = [
    ctx.headBlock - 30_000,
    Math.floor(ctx.headBlock * 0.75),
    Math.floor(ctx.headBlock * 0.5),
    Math.floor(ctx.headBlock * 0.25),
    Math.floor(ctx.headBlock * 0.1),
  ].filter((b) => b > 1)
  let best = { from: candidates[0], perBlock: 0, sampled: 0 }
  for (const from of candidates) {
    const r = await getLogs(ctx.url, from, PROBE_SPAN)
    await sleep(200)
    if (r.ok) {
      const perBlock = r.result.length / PROBE_SPAN
      if (perBlock > best.perBlock) best = { from, perBlock, sampled: r.result.length }
    }
  }
  return best
}

async function probeLogRetention(ctx) {
  section('eth_getLogs retention  [CRITICAL: decides whether re-indexing is possible]')

  // Depth ladder, unfiltered, at span 1000. Unfiltered matters: an address-filtered
  // query returning [] is ambiguous (idle contract vs pruned node), whereas on a
  // chain producing blocks continuously an empty unfiltered window is implausible
  // and therefore a real signal. Span 1000 is chosen because it sits under the
  // block-span threshold measured below, so the result cap never truncates a row.
  const depths = [
    { label: 'head', from: ctx.headBlock - 1_000 },
    { label: '0.1% back', from: Math.floor(ctx.headBlock * 0.999) },
    { label: '1% back', from: Math.floor(ctx.headBlock * 0.99) },
    { label: '10% back', from: Math.floor(ctx.headBlock * 0.9) },
    { label: '25% back', from: Math.floor(ctx.headBlock * 0.75) },
    { label: '50% back', from: Math.floor(ctx.headBlock * 0.5) },
    { label: '75% back', from: Math.floor(ctx.headBlock * 0.25) },
    { label: '99% back', from: Math.floor(ctx.headBlock * 0.01) },
    { label: 'block 100k', from: 100_000 },
    { label: 'block 10k', from: 10_000 },
    { label: 'block 0', from: 0 },
  ].filter((d) => d.from >= 0 && d.from <= ctx.headBlock)

  // A cap refusal is the node saying "too many logs here", which already proves logs
  // exist at that depth. It must never be counted as evidence of pruning, so shrink
  // the window until the node answers with an actual count.
  const sampleDepth = async (from) => {
    let span = 1000
    for (;;) {
      const r = await getLogs(ctx.url, from, span)
      if (r.ok) return { ok: true, span, count: r.result.length, capped: span < 1000 }
      if (!isQueryTooBig(r) || span <= 1) return { ok: false, span, error: why(r) }
      // Take the node at its word when it names an acceptable span; otherwise step down.
      // `getLogs` queries [from, from+span] INCLUSIVE, so a stated cap of N blocks is span N-1.
      // Using N directly asks for N+1 blocks, gets refused again, and falls through to the divide
      // ladder - which still terminates, but throws away the round trip the hint was there to save.
      const stated = parseRangeCap(r)
      const fromHint = stated === null ? null : Math.max(1, stated - 1)
      span = fromHint !== null && fromHint < span ? fromHint : Math.floor(span / 5)
    }
  }

  const samples = []
  for (const d of depths) {
    const s = await sampleDepth(d.from)
    samples.push({ ...d, blocksBack: ctx.headBlock - d.from, ...s })
    await sleep(200) // stay under the endpoint's rate limiter
  }

  note('Unfiltered log windows. A non-empty result proves logs survive at that depth.')
  note('Span starts at 1000 and shrinks if the node refuses the query as too large.')
  lines.push(`  ${'depth'.padEnd(11)} ${'from'.padStart(12)}  ${'blocks back'.padStart(12)}  ${'span'.padStart(5)}  result`)
  for (const s of samples) {
    const res = s.ok ? `${s.count.toLocaleString()} logs` : `ERROR - ${s.error}`
    lines.push(
      `  ${s.label.padEnd(11)} ${s.from.toLocaleString().padStart(12)}  ${s.blocksBack.toLocaleString().padStart(12)}  ${String(s.span).padStart(5)}  ${res}`,
    )
  }

  const { oldestProven, errored, emptyWide, emptyNarrow, verdict } = judgeLogRetention(samples)

  lines.push('')
  if (oldestProven) {
    row('oldest block with logs', `${oldestProven.from.toLocaleString()} (${oldestProven.label})`)
  }
  row('verdict', RETENTION_VERDICT_TEXT[verdict](errored.length))
  if (emptyWide.length) {
    lines.push('')
    note(`WARNING: ${emptyWide.length} FULL-WIDTH window(s) returned 0 logs WITHOUT erroring.`)
    note('         A node that prunes logs silently looks exactly like this, and a re-index')
    note('         would record the gap as "no activity" rather than failing loudly. Confirm')
    note('         by hand whether the chain was genuinely idle there.')
  }
  if (emptyNarrow.length) {
    lines.push('')
    note(`NOTE: ${emptyNarrow.length} window(s) returned 0 logs, but the node's range cap had`)
    note('      narrowed them first. That is NOT evidence of pruning - the sample was too small')
    note('      to contain a log. Re-run against an endpoint with a wider range cap to settle it.')
  }

  report.sections.logRetention = {
    samples,
    oldestBlockWithLogs: oldestProven ? oldestProven.from : null,
    erroredDepths: errored.length,
    verdict,
  }
}

async function probeQueryLimits(ctx) {
  section('eth_getLogs query limits')

  // The refusal text reads like one flat result cap, but there are TWO, and the block
  // span selects which applies. A span-1000 window happily returns ~42k logs while
  // span 1001 over the same blocks is refused at 10,000. Reading the limit out of the
  // node's own message is exact, so both are reported rather than inferred.
  const dense = await findDenseRegion(ctx)
  row('densest sample region', `block ${dense.from.toLocaleString()} (${dense.perBlock.toFixed(1)} logs/block)`)

  let narrowLimit = null
  let wideLimit = null
  // Narrow regime: stay at or below the switch point and widen until refused. Start
  // from the span that density predicts will breach a 50k-ish ceiling, so a dense
  // chain reveals the second cap instead of quietly reporting only one.
  const predicted = dense.perBlock > 0 ? Math.ceil(50_000 / dense.perBlock) : 1000
  const narrowSpans = [...new Set([Math.min(1000, predicted), 1000, 900, 700, 500])].filter((s) => s >= 1)
  for (const span of narrowSpans) {
    const r = await getLogs(ctx.url, dense.from, span)
    await sleep(300)
    if (!r.ok && parseLimit(r)) {
      narrowLimit = parseLimit(r)
      break
    }
  }
  // Wide regime: past the switch point, widening until the node states its ceiling.
  // Testing only span 1001 finds nothing on a sparse chain, where that query simply
  // succeeds and the existing cap goes unreported.
  for (const span of [1001, 2_000, 5_000, 20_000, 100_000, 500_000, 2_000_000]) {
    if (span > ctx.headBlock) break
    const r = await getLogs(ctx.url, dense.from - span, span)
    await sleep(250)
    if (!r.ok) {
      wideLimit = parseLimit(r)
      if (wideLimit) break
    }
  }

  if (narrowLimit && wideLimit && narrowLimit !== wideLimit) {
    // Find the exact span where the reported ceiling changes.
    let narrow = 1
    let wide = 5_000
    while (wide - narrow > 1) {
      const mid = Math.floor((narrow + wide) / 2)
      const r = await getLogs(ctx.url, dense.from, mid)
      await sleep(200)
      const lim = parseLimit(r)
      if (r.ok || lim === narrowLimit) narrow = mid
      else wide = mid
    }
    row('two caps, switched by span', `span <= ${narrow} allows ${narrowLimit.toLocaleString()} logs`)
    row('', `span >= ${wide} allows ${wideLimit.toLocaleString()} logs`)
    lines.push('')
    note(`PRACTICAL RULE: chunk log scans at span <= ${narrow}. That regime allows`)
    note(`${narrowLimit.toLocaleString()} matched logs, ${(narrowLimit / wideLimit).toFixed(0)}x the ${wideLimit.toLocaleString()} allowed above it, so the same`)
    note('work costs far fewer requests. Neither cap is a limit on the block span itself.')
    report.sections.queryLimits = { denseRegion: dense, switchSpan: narrow, narrowLimit, wideLimit }
  } else {
    row('matched-log cap', wideLimit ? `${wideLimit.toLocaleString()} logs` : 'no cap observed')
    note('  This chain is not dense enough here to demonstrate a second, narrower-span')
    note('  regime. Re-run against a busier region before assuming only one cap exists.')
    report.sections.queryLimits = { denseRegion: dense, switchSpan: null, narrowLimit, wideLimit }
  }
}

async function probeState(ctx) {
  section('Historical state (archive depth)')
  // Measure with eth_call, NOT eth_getBalance. On Nitro, eth_getBalance against a
  // pruned block returns 0x0 with no error, indistinguishable from a real zero
  // balance - it reports "full archive" on a node that has pruned everything.
  // eth_call surfaces the truth as `missing trie node`.
  //
  // Reported as a ladder rather than a bare binary search, because a search assumes
  // monotonicity and eth_call returns bare `0x` at blocks predating the probe
  // contract, which would read as "served".
  // Nitro reports unreadable historical state in more than one way. `missing trie
  // node` is the pruned-state error; `metadata is not found, <block>` comes from
  // nodes that cannot resolve that block at all. Operationally both mean the same
  // thing - this endpoint will not answer a historical query here.
  const STATE_ERR = /missing trie node|state .* is not available|not available|pruned|unsupported block|metadata is not found/i
  const classify = (r) => {
    if (r.ok) return r.result && r.result !== '0x' ? 'served (data)' : 'served (contract absent)'
    return STATE_ERR.test(why(r)) ? `NO STATE - ${why(r).slice(0, 52)}` : `error - ${why(r).slice(0, 52)}`
  }
  // Only a real data response proves the state trie was readable at that block.
  const servedWithData = (r) => r.ok && r.result && r.result !== '0x'

  const ladder = []
  for (const back of [
    0, 100, 1_000, 5_000, 10_000, 20_000, 50_000, 100_000,
    1_000_000, 5_000_000, 10_000_000, 20_000_000, 50_000_000,
  ]) {
    if (back > ctx.headBlock) break
    const b = ctx.headBlock - back
    const [call, bal] = await Promise.all([
      rpc(ctx.url, 'eth_call', [{ to: ctx.stateAddr, data: ctx.stateData }, hex(b)]),
      rpc(ctx.url, 'eth_getBalance', [ctx.stateAddr, hex(b)]),
    ])
    ladder.push({ back, block: b, call: classify(call), data: servedWithData(call), balanceOk: bal.ok })
  }

  note(`eth_call ${ctx.stateData} -> ${ctx.stateAddr} at increasing depth:`)
  lines.push(`  ${'blocks back'.padStart(12)}  ${'block'.padStart(12)}  ${'getBalance'.padStart(11)}  eth_call`)
  for (const s of ladder) {
    lines.push(
      `  ${s.back.toLocaleString().padStart(12)}  ${s.block.toLocaleString().padStart(12)}  ${(s.balanceOk ? 'ok' : 'error').padStart(11)}  ${s.call}`,
    )
  }

  const trap = ladder.filter((s) => s.balanceOk && !s.data && s.call.startsWith('NO STATE'))
  if (trap.length) {
    lines.push('')
    row('silent-pruning trap', `eth_getBalance succeeds at ${trap.length} unreadable depth(s)`)
    note('        where eth_call correctly errors. Never measure archive depth with')
    note('        eth_getBalance on this endpoint; it reports success on pruned state.')
  }

  // Repeat the same call rather than binary-searching for a boundary.
  //
  // A single-sample boundary is worthless on a load-balanced endpoint. Repeated
  // searches against 4663 disagreed by millions of blocks, and the ladder above is
  // visibly non-monotonic, because one URL fronts a pool of nodes retaining
  // different depths. What matters operationally is not where the boundary sits but
  // how reliably a given depth answers: a depth that answers only sometimes breaks
  // fork tests intermittently, which is far worse to debug than one that never answers.
  const REPEATS = 4
  const reliability = []
  for (const back of [1_000, 5_000, 10_000, 50_000, 100_000, 1_000_000, 5_000_000, 10_000_000, 20_000_000]) {
    if (back > ctx.headBlock) break
    const b = ctx.headBlock - back
    let served = 0
    for (let i = 0; i < REPEATS; i++) {
      const r = await rpc(ctx.url, 'eth_call', [{ to: ctx.stateAddr, data: ctx.stateData }, hex(b)])
      if (servedWithData(r)) served++
      await sleep(150)
    }
    reliability.push({ block: b, back, served, of: REPEATS })
  }

  lines.push('')
  note(`Same historical eth_call repeated ${REPEATS}x per depth (exposes node-to-node variance):`)
  lines.push(`  ${'blocks back'.padStart(12)}  ${'block'.padStart(12)}  served  verdict`)
  for (const s of reliability) {
    const verdict = s.served === s.of ? 'consistent' : s.served === 0 ? 'never served' : 'INTERMITTENT'
    lines.push(
      `  ${s.back.toLocaleString().padStart(12)}  ${s.block.toLocaleString().padStart(12)}   ${s.served}/${s.of}   ${verdict}`,
    )
  }

  // Stop at the FIRST unreliable depth rather than taking the deepest consistent one.
  // Availability here is not monotonic (a pool of nodes), so a consistent reading
  // below an intermittent one is luck, not a guarantee, and must not be sold as a
  // safe floor.
  const firstBad = reliability.findIndex((s) => s.served !== s.of)
  const safeRun = firstBad === -1 ? reliability : reliability.slice(0, firstBad)
  const deepestSafe = safeRun.length ? safeRun[safeRun.length - 1] : null
  const flaky = reliability.filter((s) => s.served > 0 && s.served < s.of)
  lines.push('')
  if (deepestSafe) {
    const blk = await rpc(ctx.url, 'eth_getBlockByNumber', [hex(deepestSafe.block), false])
    const age = blk.ok && blk.result ? Math.floor(Date.now() / 1000) - toNum(blk.result.timestamp) : null
    row('deepest consistent depth', `${deepestSafe.back.toLocaleString()} blocks back${age === null ? '' : ` (~${humanizeAge(age)})`}`)
    // The advice has to follow the measurement, not the endpoint this probe was first written
    // against. "Read the head at runtime" is correct ONLY for an endpoint that prunes: it is a
    // workaround for a moving retention window. Printing it unconditionally told an operator to
    // undo a pinned fork block on an archive node, which is the opposite of the right move - and it
    // said so directly under a table showing every sampled depth answering 4/4.
    if (firstBad === -1) {
      note('  Every sampled depth answered consistently, i.e. this endpoint behaves like an')
      note('  ARCHIVE node over the whole sampled range. PIN a block number in fork tests -')
      note('  a pinned block is reproducible and caches on disk. Deeper than the deepest row')
      note('  is still unmeasured, not proven.')
    } else {
      note('  Keep fork tests inside this. It is a MOVING window, so read the head at')
      note('  runtime rather than hardcoding a block number.')
    }
  } else {
    row('deepest consistent depth', 'none of the sampled depths answered consistently')
  }
  if (flaky.length) {
    row('INTERMITTENT depths', `${flaky.length} of ${reliability.length} sampled`)
    note('  This endpoint is a pool whose nodes retain different depths. Treat deep-state')
    note('  availability as a probability, not a boundary.')
  }

  // Testnet 46630 is documented as rejecting state at the newest block, which forces
  // fork tests to step back. Worth confirming per endpoint rather than assuming.
  const probes = [
    ['eth_call at "latest"', 'latest'],
    ['eth_call at head (numeric)', hex(ctx.headBlock)],
    ['eth_call at head-300', hex(Math.max(0, ctx.headBlock - 300))],
  ]
  const tips = {}
  for (const [label, tag] of probes) {
    const r = await rpc(ctx.url, 'eth_call', [{ to: ctx.stateAddr, data: ctx.stateData }, tag])
    tips[label] = r.ok
    row(label, r.ok ? 'works' : `REJECTED - ${why(r)}`)
  }

  report.sections.state = { ladder, reliability, deepestConsistentBack: deepestSafe ? deepestSafe.back : null, tips }
}

async function probeContracts(ctx) {
  section('Contract presence')
  const targets = [
    ['Multicall3', MULTICALL3],
    ['WETH9', ctx.weth9],
    ['USDG (mainnet)', USDG_MAINNET],
  ].filter(([, a]) => Boolean(a))

  const presence = {}
  for (const [name, addr] of targets) {
    const r = await rpc(ctx.url, 'eth_getCode', [addr, 'latest'])
    const code = r.ok && r.result ? r.result : '0x'
    const size = code === '0x' ? 0 : (code.length - 2) / 2
    // Hash the bytecode, not just its length: "same size" is not "same code", and
    // comparing chains needs something that actually distinguishes them.
    const digest = size ? createHash('sha256').update(code).digest('hex').slice(0, 16) : null
    presence[name] = { address: addr, size, sha256: digest }
    row(name, size ? `${size.toLocaleString()} B  sha256:${digest}  ${addr}` : `NO CODE at ${addr}`)
  }
  report.sections.contracts = presence
}

async function probeTransport(ctx) {
  section('Transport')
  let batch
  try {
    const res = await fetch(ctx.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
        { jsonrpc: '2.0', id: 2, method: 'eth_blockNumber', params: [] },
        { jsonrpc: '2.0', id: 3, method: 'eth_gasPrice', params: [] },
      ]),
    })
    const j = await res.json()
    batch = Array.isArray(j) ? `supported (${j.length} responses)` : 'NOT supported (non-array response)'
  } catch (err) {
    batch = `NOT supported (${String(err)})`
  }
  row('JSON-RPC batch', batch)

  const BURST = 30
  // A concurrency measurement is meaningless once pacing is on: acquirePace serializes the requests,
  // so this would time the probe's own pacer and report it as the endpoint's concurrency. Skipping it
  // and saying so is the honest option - the alternative is a confident number about the wrong thing,
  // which is the failure mode the rest of this script exists to avoid.
  if (minIntervalMs > 0) {
    row(`burst of ${BURST} concurrent`, 'SKIPPED - pacing is active, so this would measure the pacer')
    note(`  Re-run without --min-interval (and against a limit that allows it) to measure this.`)
    report.sections.transport = { batch, burstSkippedForPacing: true }
    return
  }

  const t0 = Date.now()
  const burst = await Promise.all(
    Array.from({ length: BURST }, () => rpc(ctx.url, 'eth_blockNumber', [], { retries: 0 })),
  )
  const failed = burst.filter((r) => !r.ok)
  const throttledCount = failed.filter((r) => r.throttled).length
  row(
    `burst of ${BURST} concurrent`,
    `${BURST - failed.length}/${BURST} ok in ${Date.now() - t0} ms` +
      (failed.length ? ` - first failure: ${why(failed[0])}` : ''),
  )
  if (throttledCount > 0) {
    // Distinguish "the endpoint cannot take 30 at once" from "we are not allowed 30 at once".
    note(`  ${throttledCount} of ${failed.length} failures were rate limits, not errors.`)
  }
  report.sections.transport = {
    batch,
    burstOk: BURST - failed.length,
    burstTotal: BURST,
    burstThrottled: throttledCount,
  }
}

async function probeOptionalMethods(ctx) {
  section('Optional methods')
  const optional = [
    ['eth_getBlockReceipts', [hex(ctx.headBlock - 10)]],
    ['eth_feeHistory', ['0x4', 'latest', []]],
    ['eth_maxPriorityFeePerGas', []],
    ['debug_traceTransaction', ['0x' + '00'.repeat(32)]],
    ['trace_block', [hex(ctx.headBlock - 10)]],
    ['eth_newFilter', [{ fromBlock: 'latest', toBlock: 'latest' }]],
    ['eth_getFilterChanges', ['0x1']],
  ]
  const methods = {}
  for (const [m, p] of optional) {
    const r = await rpc(ctx.url, m, p, { retries: 0 })
    // A method-level error still proves the method is routed; -32601 is the only
    // answer that means genuinely unavailable.
    const available = r.ok || (r.error && r.error.code !== -32601)
    methods[m] = available
    row(m, available ? 'available' : 'NOT available')
  }
  report.sections.optionalMethods = methods
}

// -------------------------------------------------------------------- self test
//
// classifyReply decides whether a reply is a throttle, a non-RPC endpoint, or real data, and it has
// already been wrong in both directions: it once read a successful result containing "429" as a
// refusal, and once read a typo'd URL's HTML homepage as a rate limit. Both were confident and both
// were silent. The bodies below are the real ones observed from Robinhood Chain and from two
// candidate providers, so this pins the behaviour offline, with no network and no dependencies.
//
//   node scripts/rpc-probe.mjs --self-test

const SELF_TEST_CASES = [
  ['HTTP 429 with a JSON rate-limit payload', 429, '{"error":"rate_limited","message":"Free public limit reached (1 req/10s per IP)"}', 'throttled'],
  ['HTTP 200 with a rate-limit payload, no JSON-RPC envelope', 200, '{"error":"rate_limited","message":"limit"}', 'throttled'],
  ['Cloudflare HTML naming a rate limit', 429, '<!DOCTYPE html><html><body>error code: 1015</body></html>', 'throttled'],
  ['Cloudflare HTML under a throttling status, no signal', 503, '<!DOCTYPE html><html><body>checking your browser</body></html>', 'throttled'],
  ['HTML 200 that says it is rate limiting', 200, '<html><body>You are being rate limited</body></html>', 'throttled'],
  ['plain-text rate limit', 200, 'rate limit exceeded', 'throttled'],
  ['a typo\'d URL serving an ordinary web page', 200, '<!doctype html><html><head><title>Example Domain</title></head></html>', 'not-rpc'],
  ['HTML under 405, no throttle signal', 405, '<!doctype html><html>nope</html>', 'not-rpc'],
  ['empty body', 200, '', 'not-rpc'],
  ['a good result whose value contains "429"', 200, '{"jsonrpc":"2.0","id":1,"result":"0x429ab1"}', 'proceed'],
  ['the same, with id before jsonrpc', 200, '{"id":1,"jsonrpc":"2.0","result":"0x429ab1"}', 'proceed'],
  // This one guards the PATTERN rather than the envelope check. Every other "proceed" case carries a
  // `jsonrpc` field, which short-circuits the pattern entirely - so without a case like this,
  // widening RATE_LIMIT_PATTERN back to a bare "429" passes the whole suite. Found by mutation.
  ['a batch reply whose elements omit the jsonrpc field', 200, '[{"id":1,"result":"0x429ab1"}]', 'proceed'],
  ['a real JSON-RPC error object', 200, '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"missing trie node"}}', 'proceed'],
  ['a plan refusal carried in a JSON-RPC envelope', 400, '{"id":1,"jsonrpc":"2.0","error":{"message":"chain is not available on free plan, please upgrade to paid plan","code":35}}', 'proceed'],
  // Enveloped throttles. Alchemy - the provider most likely to be evaluated next - reports rate
  // limiting this way, with HTTP 200, so a status-only or text-only check misses it entirely.
  ['an enveloped throttle, JSON-RPC code 429', 200, '{"jsonrpc":"2.0","id":1,"error":{"code":429,"message":"Too Many Requests"}}', 'throttled'],
  ['an enveloped throttle, JSON-RPC code -32005', 200, '{"jsonrpc":"2.0","id":1,"error":{"code":-32005,"message":"limit exceeded"}}', 'throttled'],
  ['a throttle message carried under a non-standard code', 200, '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"rate limit exceeded"}}', 'throttled'],
  // The single most important negative case. The eth_getLogs cap refusal is a -32000 whose message
  // contains "exceeds limit", and it must stay a query-too-big signal: the probe shrinks its window
  // in response, and per trap #3 a cap refusal PROVES logs exist at that depth. Reading it as a
  // throttle would silently break the log-cap and retention measurements at once.
  ['a log-cap refusal, which is not throttling', 200, '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"logs matched by query exceeds limit of 10000"}}', 'proceed'],
]

/**
 * Cases for the SECOND classifier: is this failure the node refusing an over-large query?
 *
 * It earns its own table because getting it wrong is silent and inverts a conclusion - an unmatched
 * cap refusal is tallied as a depth that "failed", which reads as pruning when it is in fact proof
 * that logs exist there. Each row is [name, refusal message, expected too-big?, expected range cap].
 */
const SPAN_TEST_CASES = [
  ['a result-count cap (public Robinhood endpoints)', 'logs matched by query exceeds limit of 10000', true, null],
  ['the wider result-count cap at span <= 1000', 'logs matched by query exceeds limit of 50000', true, null],
  ['a free-tier block-range cap (Alchemy)', 'Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range. Upgrade to PAYG for expanded block range.', true, 10],
  ['a block-range cap with a hyphen and a wider span', 'this endpoint allows up to 500-block range queries', true, 500],
  ['a response-size refusal', 'response too large', true, null],
  ['a timeout', 'query timed out', true, null],
  // The negatives matter more than the positives: widening the pattern until everything looks like a
  // cap would make the retention table incapable of ever reporting real pruning.
  ['pruned state, which is NOT a cap', 'missing trie node 8f3b2f47 (code -32000)', false, null],
  ['a rejected block tag, which is NOT a cap', 'unsupported block number (code -32000)', false, null],
  ['a plan refusal that mentions no range', 'chain is not available on free plan, please upgrade', false, null],
  ['a transport failure', 'fetch failed', false, null],
  // A MALFORMED request also says "block range", and reading it as a cap sends the span-shrinking
  // ladder down to 1 before giving up - burning round trips at every depth, and tallying a broken
  // request as though the node had stated a ceiling. The clause therefore requires a size next to
  // the words. Mutation: relaxing it back to a bare /block range/ fails these two.
  ['a malformed range, which is NOT a cap', 'invalid block range params', false, null],
  ['an unparseable range, which is NOT a cap', 'cannot parse block range', false, null],
  ['a range cap stated without a number', 'requested block range too large', true, null],
]

/**
 * Log-retention verdicts. This is the conclusion the whole Stage 4 "Postgres is a rebuildable cache"
 * assumption rests on, and it has already been inverted twice: once by an unrecognised cap refusal
 * (reported as pruning), once by a window too narrow to hold a log (reported as pruning). Both were
 * silent. The `capped` flag is what separates "the node has no logs here" from "we could not see
 * far enough to tell", so it gets pinned explicitly.
 *
 * Shape: [name, samples, expected verdict]. A sample is {ok, count, capped, from}.
 */
const w = (from, count, capped = false) => ({ ok: true, from, count, capped })
const RETENTION_TEST_CASES = [
  ['logs at every depth down to genesis', [w(96_000_000, 300), w(10_000, 18), w(0, 10)], 'no-pruning'],
  ['a non-cap error outranks everything else', [w(0, 10), { ok: false, from: 5_000, error: 'missing trie node' }], 'errors'],
  // The case that actually happened on 2026-08-01, and the reason this function exists.
  ['empty windows that the node\'s cap narrowed are INCONCLUSIVE, not pruning', [w(96_000_000, 300, true), w(10_000, 0, true), w(0, 0, true)], 'inconclusive'],
  ['a FULL-WIDTH empty window is the real pruning signal', [w(96_000_000, 300), w(10_000, 0), w(0, 0)], 'empty-full-width'],
  // Mixed: one full-width empty window must not be excused by narrowed ones alongside it.
  ['one full-width empty outranks any number of narrowed ones', [w(96_000_000, 300, true), w(10_000, 0, true), w(0, 0, false)], 'empty-full-width'],
  ['logs proven only above the genesis region', [w(96_000_000, 300), w(100_000, 6)], 'shallow'],
]

/**
 * Endpoint masking. `maskEndpoint` is the only thing standing between a keyed provider URL and both
 * stdout and the `--json` file, so it gets its own table: the public endpoints must survive intact
 * (masking them would make the reports unreadable) and every keyed shape must lose its secret.
 */
const MASK_TEST_CASES = [
  ['a public endpoint is untouched', 'https://rpc.mainnet.chain.robinhood.com', 'https://rpc.mainnet.chain.robinhood.com/'],
  ['an Alchemy key is masked', 'https://robinhood-testnet.g.alchemy.com/v2/AbCdEf0123456789AbCdEf01', 'https://robinhood-testnet.g.alchemy.com/v2/<key>'],
  ['a QuickNode key is masked', 'https://example.quiknode.pro/0123456789abcdef0123456789abcdef/', 'https://example.quiknode.pro/<key>/'],
  ['a key in a query parameter is masked', 'https://rpc.example.com/?apiKey=0123456789abcdef0123', 'https://rpc.example.com/?apiKey=<key>'],
  ['a short path segment is not mistaken for a key', 'https://rpc.example.com/v2/eth', 'https://rpc.example.com/v2/eth'],
  ['a non-URL is returned unchanged rather than throwing', 'not-a-url', 'not-a-url'],
]

function runSelfTest() {
  let failed = 0
  const check = (ok, name, detail) => {
    if (!ok) failed++
    console.log(`${ok ? '  ok  ' : '  FAIL'}  ${name}  ->  ${detail}`)
  }
  for (const [name, status, body, want] of SELF_TEST_CASES) {
    const got = classifyReply(status, body)
    check(got === want, name, `${got}${got === want ? '' : `  (expected ${want})`}`)
  }
  for (const [name, message, wantBig, wantCap] of SPAN_TEST_CASES) {
    // isQueryTooBig / parseRangeCap read a reply through why(), so feed them the same shape.
    const reply = { ok: false, error: { message, code: -32000 } }
    const gotBig = isQueryTooBig(reply)
    const gotCap = parseRangeCap(reply)
    const ok = gotBig === wantBig && gotCap === wantCap
    check(ok, name, `tooBig=${gotBig} cap=${gotCap}${ok ? '' : `  (expected tooBig=${wantBig} cap=${wantCap})`}`)
  }
  for (const [name, samples, want] of RETENTION_TEST_CASES) {
    const got = judgeLogRetention(samples).verdict
    check(got === want, name, `${got}${got === want ? '' : `  (expected ${want})`}`)
  }
  for (const [name, raw, want] of MASK_TEST_CASES) {
    const got = maskEndpoint(raw)
    check(got === want, name, `${got}${got === want ? '' : `  (expected ${want})`}`)
  }
  const total =
    SELF_TEST_CASES.length + SPAN_TEST_CASES.length + RETENTION_TEST_CASES.length + MASK_TEST_CASES.length
  console.log(failed === 0 ? `\nall ${total} classification cases pass` : `\n${failed} of ${total} FAILED`)
  return failed === 0
}

// ------------------------------------------------------------------------ main

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--self-test')) {
    process.exit(runSelfTest() ? 0 : 1)
  }
  const target = args[0]
  if (!target) {
    console.error(
      'usage: node scripts/rpc-probe.mjs <mainnet|testnet|url> [--json out.json] [--min-interval ms]\n' +
        '       node scripts/rpc-probe.mjs --self-test',
    )
    process.exit(2)
  }
  const jsonIdx = args.indexOf('--json')
  const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : null
  const paceIdx = args.indexOf('--min-interval')
  if (paceIdx >= 0) {
    const ms = Number(args[paceIdx + 1])
    if (!Number.isFinite(ms) || ms < 0) {
      console.error('--min-interval expects milliseconds, e.g. --min-interval 10000')
      process.exit(2)
    }
    minIntervalMs = ms
  }
  const url = ALIASES[target] ?? target
  // Masked in both sinks: `report` is what `--json` writes to disk, `lines` is what reaches stdout.
  // `url` itself stays intact - it still has to address the node.
  report.endpoint = maskEndpoint(url)

  lines.push('Octopus RPC capability probe', `endpoint: ${report.endpoint}`, `probed:   ${report.probedAt}`)
  if (minIntervalMs > 0) {
    lines.push(
      `pacing:   >= ${minIntervalMs} ms between calls (~${Math.ceil((minIntervalMs * 150) / 60000)} min for a full run)`,
    )
  }

  const ctx = await probeIdentity(url)
  if (!ctx) {
    emit(jsonOut)
    process.exit(1)
  }

  await probeLogRetention(ctx)
  await probeQueryLimits(ctx)
  await probeState(ctx)
  await probeContracts(ctx)
  await probeTransport(ctx)
  await probeOptionalMethods(ctx)

  section('Summary')
  row('rpc calls made', `${stats.calls}`)
  row('rate limited (HTTP 429)', `${stats.rateLimited}`)
  row('timeouts', `${stats.timeouts}`)
  if (minIntervalMs > 0) {
    row('final pacing floor', `${minIntervalMs} ms between calls`)
    if (stats.paceBumps > 0) {
      // Say this out loud: a run that self-throttled is not comparable to one that did not, and the
      // throughput-flavoured numbers above were measured under a different regime.
      note(`  Raised ${stats.paceBumps}x in response to throttling, from an initial 0 ms.`)
      note('  This endpoint rate limits harder than the official one. Numbers above are still')
      note('  valid capability results, but timing-derived ones are not comparable across runs.')
    }
  }
  report.sections.summary = { ...stats, finalPaceIntervalMs: minIntervalMs }

  emit(jsonOut)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
