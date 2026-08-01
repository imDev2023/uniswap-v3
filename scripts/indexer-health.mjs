#!/usr/bin/env node
// Octopus indexer health probe.
//
// Answers one question that graph-node itself will not answer honestly: is the subgraph
// actually keeping up with the chain, and if not, is it stuck in a way that can never recover?
//
// WHY THIS EXISTS. On 2026-07-31 the local subgraph froze at block 95309531 and stayed there
// while the block ingestor kept pace with the chain head. graph-node reported
// `synced: true`, `health: healthy`, `fatalError: null` the entire time it was ~500,000 blocks
// behind. Every field a monitor would naturally alert on was green. The cause was a
// ~134,000-block reorg on testnet 46630: the subgraph's stored head hash was left on an
// orphaned branch, and graph-node cannot revert a reorg whose blocks the RPC will no longer
// serve, because reverting means walking back through those very blocks. It crash-looped
// forever instead. See subgraph/README.md for the full diagnosis and the recovery runbook.
//
// THE THREE THINGS THAT LIE, and why:
//
//   `synced`      A STICKY COLUMN, not a comparison. It is `synced_at is not null` in Postgres,
//                 set once when the deployment first reached chain head and never re-evaluated.
//                 It does not compare anything at read time. It cannot go false.
//   `health`      Only reflects subgraph-level errors raised by the mappings. A crash-restart
//                 loop in the block stream never touches it.
//   `fatalError`  Only set for DETERMINISTIC errors. A missing block is classified as
//                 non-deterministic and retried forever, so it stays null.
//
// The only trustworthy signals are the two this probe computes from outside graph-node:
//
//   1. TRUE LAG      the deployment's latestBlock vs the chain's own eth_blockNumber.
//                    Never graph-node's chainHeadBlock, which is its own ingested head and
//                    can itself be stale.
//   2. CANONICITY    is the deployment's stored head hash the hash the chain actually has at
//                    that height? This is the decisive check. It is what separates "behind but
//                    catching up", which fixes itself, from "wedged on an orphaned branch",
//                    which never does and needs a graphman rewind.
//
// WHAT THIS DOES NOT DETECT, stated plainly so nobody reads a green run as more than it is.
// Canonicity catches the reorg deadlock, which is the crash loop that actually happened and the
// only one that is permanent by construction. It does NOT catch a crash-restart loop from any
// other non-deterministic cause - a flapping provider, an OOMing container, the retry ladder
// stalling on a block that IS canonical. Those present as a deployment that is simply behind,
// and this probe will call them `lagging`, which is indistinguishable here from healthy catch-up.
// Closing that gap needs a signal this script cannot see from the status API: restart counts or
// the log stream. graph-node's Prometheus endpoint (container 8040 -> host 8140) is where that
// would come from, and wiring it up is unbuilt Stage 4 work. Until then: `lagging` that does not
// clear on its own deserves a look at `docker compose logs graph-node`.
//
// A NOTE ON WHAT IS DELIBERATELY *NOT* A SIGNAL. "The head number did not advance between two
// samples" is NOT used to declare a stall, and must not be. During a catch-up scan over ranges
// with no matching logs, graph-node legitimately leaves the stored head pointer untouched for
// long stretches - measured during the #31 recovery, the pointer read 95175342 while the
// scanner was already past 95212453. A non-advancing head is therefore normal during a large
// re-index, and alerting on it would fire loudest exactly when an operator is mid-recovery.
// Canonicity is the signal; non-advancement is at most a hint, reported and never alerted on.
//
// STRICTLY READ-ONLY. It never writes to Postgres, never calls graphman, and never signs.
//
// Usage:
//   node scripts/indexer-health.mjs
//   node scripts/indexer-health.mjs --status http://localhost:8130/graphql --rpc testnet
//   node scripts/indexer-health.mjs --lag-blocks 2000
//   node scripts/indexer-health.mjs --json health.json
//   node scripts/indexer-health.mjs --self-test        # offline; no network, no services needed
//
// Exit code is 0 only when every deployment is `ok`, so it drops straight into a cron or a
// container healthcheck.
//
// No dependencies; needs Node 18+ for global fetch.

import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const RPC_ALIASES = {
  mainnet: 'https://rpc.mainnet.chain.robinhood.com',
  testnet: 'https://rpc.testnet.chain.robinhood.com',
}

const DEFAULT_STATUS = 'http://localhost:8130/graphql'

// `octopus/octopus` is the name the frontend queries. The older `launchpad/launchpad` name still
// exists in the local DB pointing at the same deployment; checking the one the product actually
// reads is the point, so it is the default.
const DEFAULT_NAMES = ['octopus/octopus']

// Blocks, not seconds. The ops alert in CLAUDE.md is written in minutes ("lag > 5 min"), but a
// block threshold needs no per-chain block-time constant, and block time is exactly the thing
// that differs 3x between testnet (0.3s) and mainnet (0.1s). 3000 blocks is ~15 min at 0.3s and
// ~5 min at 0.1s, so it is deliberately conservative on the chain that matters.
const DEFAULT_LAG_BLOCKS = 3000

// ------------------------------------------------------------------ the pure core
//
// classify() takes a fully-gathered observation and returns a verdict. It is pure so the
// precedence rules can be pinned offline, with no graph-node and no chain. Those rules are the
// whole point of this script, and every one of them was learned from a real failure.

export function classify(obs, lagBlocks = DEFAULT_LAG_BLOCKS) {
  // Nothing answered. Distinct from every other state: we know nothing, rather than knowing
  // something is wrong. Callers must not read this as healthy.
  if (!obs || obs.reachable === false) {
    return { verdict: 'unreachable', reason: 'status API did not answer' }
  }

  // A deterministic mapping error. graph-node has genuinely given up here, and unlike the
  // reorg deadlock it does say so. Outranks lag: a failed subgraph's lag is a consequence.
  if (obs.fatalError) {
    return { verdict: 'failed', reason: `fatalError: ${obs.fatalError}` }
  }

  // Absence of evidence, on BOTH sides. If either hash is missing we cannot run the canonicity
  // check, and we must not silently fall through to a lag-only verdict that would report `ok`.
  // This is measurement trap #1 from docs/rpc-capability.md in a new place: a probe that treats
  // an unanswered question as a passed one reports health it never checked.
  //
  // Guarding only `canonicalHash` was the original bug: a null or empty `headHash` fell straight
  // through to the lag check and could return `ok`, skipping the one check this script exists
  // for. Same defect, opposite side. Caught in review, pinned by the self-test below.
  if (!normHash(obs.canonicalHash)) {
    return { verdict: 'unknown', reason: 'chain would not serve the block at the indexed head' }
  }
  if (!normHash(obs.headHash)) {
    return { verdict: 'unknown', reason: 'status API reported no hash for the indexed head' }
  }

  // A non-finite threshold or head would make every comparison below false, so `lag > threshold`
  // silently reports `ok`. Refuse rather than reassure.
  if (!Number.isFinite(obs.headNumber) || !Number.isFinite(obs.chainHead) || !Number.isFinite(lagBlocks)) {
    return { verdict: 'unknown', reason: 'block heights or lag threshold are not finite numbers' }
  }

  // THE DECISIVE CHECK. The stored head is on a branch the chain no longer has, so graph-node
  // needs to revert through blocks no node will serve. It cannot, and it will crash-loop
  // forever. This outranks `lagging` on purpose: such a deployment is always also far behind,
  // and reporting the lag alone would describe a permanent deadlock as a temporary delay.
  if (normHash(obs.headHash) !== normHash(obs.canonicalHash)) {
    return {
      verdict: 'orphaned',
      reason: `indexed head ${obs.headNumber} is ${short(obs.headHash)} but the chain has ${short(obs.canonicalHash)}; needs a rewind`,
    }
  }

  const lag = obs.chainHead - obs.headNumber
  if (lag > lagBlocks) {
    return { verdict: 'lagging', reason: `${lag.toLocaleString()} blocks behind chain head` }
  }

  return { verdict: 'ok', reason: `${Math.max(0, lag)} blocks behind chain head` }
}

// graph-node's status API returns block hashes WITHOUT the 0x prefix ("8097c538…"), while
// eth_getBlockByNumber returns them with it ("0x8097c538…"). Comparing the two raw strings makes
// every healthy deployment look permanently orphaned - the loudest possible false alarm, for the
// one verdict that tells an operator to go rewind a database. Normalising in the pure core keeps
// that fact pinned by the self-test rather than living in the fetch path.
export function normHash(h) {
  if (typeof h !== 'string' || h === '') return null
  const bare = h.startsWith('0x') || h.startsWith('0X') ? h.slice(2) : h
  return '0x' + bare.toLowerCase()
}

const short = (h) => (typeof h === 'string' && h.length > 14 ? `${h.slice(0, 10)}…${h.slice(-4)}` : String(h))

// ---------------------------------------------------------------------- plumbing

async function postJson(url, body, timeoutMs = 15000) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    })
    return await res.json()
  } finally {
    clearTimeout(t)
  }
}

async function rpc(url, method, params = []) {
  const j = await postJson(url, { jsonrpc: '2.0', id: 1, method, params })
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`)
  return j.result
}

// Queried BY NAME, not via the argument-less `indexingStatuses`.
//
// On graph-node 0.40.2 the obvious query - `{ indexingStatuses { … } }` with no arguments -
// returns an EMPTY ARRAY even when deployments are assigned, resumed and actively indexing,
// while `indexingStatusesForSubgraphName` returns them correctly. A monitor built on the obvious
// query therefore reports "nothing to check" forever and never alerts on anything. Measured
// against the live stack during #31.
const STATUS_FIELDS = `
    subgraph
    synced
    health
    paused
    fatalError { message }
    chains {
      network
      chainHeadBlock { number }
      latestBlock { number hash }
    }`

async function readStatuses(statusUrl, names) {
  const statuses = []
  for (const name of names) {
    let j
    try {
      j = await postJson(statusUrl, {
        query: `{ indexingStatusesForSubgraphName(subgraphName: "${name}") {${STATUS_FIELDS} } }`,
      })
    } catch (err) {
      return { reachable: false, error: err.message }
    }
    if (j.errors) return { reachable: false, error: JSON.stringify(j.errors) }
    for (const st of j.data?.indexingStatusesForSubgraphName ?? []) statuses.push({ ...st, name })
  }
  return { reachable: true, statuses }
}

// ------------------------------------------------------------------------- run

async function run({ statusUrl, rpcUrl, lagBlocks, names }) {
  const out = { statusUrl, rpcUrl, lagBlocks, names, checkedAt: new Date().toISOString(), deployments: [] }

  const chainHead = await rpc(rpcUrl, 'eth_blockNumber').then((h) => Number(BigInt(h)))
  out.chainHead = chainHead

  const s = await readStatuses(statusUrl, names)
  if (!s.reachable) {
    out.deployments.push({
      subgraph: '(status API)',
      ...classify({ reachable: false }, lagBlocks),
      detail: s.error,
    })
    return out
  }

  if (s.statuses.length === 0) {
    out.deployments.push({
      subgraph: '(none)',
      verdict: 'unknown',
      reason: `status API answered but reported no deployments for ${names.join(', ')}`,
    })
    return out
  }

  for (const st of s.statuses) {
    const chain = st.chains?.[0] ?? {}
    const headNumber = Number(chain.latestBlock?.number ?? NaN)
    const headHash = chain.latestBlock?.hash ?? null

    // Ask the chain what it actually has at the indexed height. A null result is not a failure
    // of this probe - it is itself informative - so it is passed through to classify() as
    // `unknown` rather than thrown.
    let canonicalHash = null
    if (Number.isFinite(headNumber)) {
      try {
        const blk = await rpc(rpcUrl, 'eth_getBlockByNumber', ['0x' + headNumber.toString(16), false])
        canonicalHash = blk?.hash ?? null
      } catch {
        canonicalHash = null
      }
    }

    const obs = {
      reachable: true,
      headNumber,
      headHash,
      canonicalHash,
      chainHead,
      fatalError: st.fatalError?.message ?? null,
    }

    out.deployments.push({
      subgraph: st.name ? `${st.name} (${st.subgraph})` : st.subgraph,
      network: chain.network ?? null,
      paused: st.paused ?? null,
      headNumber,
      headHash,
      canonicalHash,
      lag: Number.isFinite(headNumber) ? chainHead - headNumber : null,
      graphNodeChainHead: Number(chain.chainHeadBlock?.number ?? NaN) || null,
      // Reported verbatim, and labelled in the output as untrustworthy. Recording them is
      // still worth it: the gap between what graph-node claims and what is true is the single
      // most useful thing to have in a log when diagnosing this class of failure later.
      reportedSynced: st.synced,
      reportedHealth: st.health,
      ...classify(obs, lagBlocks),
    })
  }

  return out
}

function render(out) {
  const bad = []
  console.log(`chain head (RPC)   : ${out.chainHead.toLocaleString()}`)
  console.log(`status API         : ${out.statusUrl}`)
  console.log(`lag threshold      : ${out.lagBlocks.toLocaleString()} blocks`)
  for (const d of out.deployments) {
    console.log(`\n  deployment       : ${d.subgraph}`)
    if (d.headNumber !== undefined && Number.isFinite(d.headNumber)) {
      console.log(`  indexed head     : ${d.headNumber.toLocaleString()}  (${d.lag?.toLocaleString()} behind)`)
      console.log(`  head hash        : ${short(d.headHash)}`)
      console.log(`  chain has        : ${d.canonicalHash ? short(d.canonicalHash) : '(no answer)'}`)
    }
    if (d.reportedSynced !== undefined) {
      console.log(`  graph-node says  : synced=${d.reportedSynced} health=${d.reportedHealth}   <- not trustworthy, see header`)
    }
    console.log(`  VERDICT          : ${d.verdict.toUpperCase()}  (${d.reason})`)
    if (d.detail) console.log(`  detail           : ${d.detail}`)
    if (d.verdict !== 'ok') bad.push(d)
  }
  if (bad.some((d) => d.verdict === 'orphaned')) {
    console.log(`\nAn ORPHANED deployment will never recover on its own. Recovery runbook:`)
    console.log(`  subgraph/README.md  ->  "Recovering from a reorg deadlock"`)
  }
  return bad.length === 0
}

// -------------------------------------------------------------------- self-test
//
// Every case below is a precedence rule that a plausible implementation gets wrong, and the
// first two are the exact shape of the failure this script was written for: graph-node
// reporting perfect health while permanently wedged.

const H_A = '0x91bc2eaa9fde0da432573a186c4643aeda5c33d18c9091a78df21b03dc8beadb'
const H_B = '0xf471195fd4aed5a8e7f47c849f748057047637e880f60f37d81f845b0b664c8f'

const SELF_TEST_CASES = [
  [
    'the #31 failure verbatim: healthy, synced, no fatal error, wedged on an orphan',
    { reachable: true, headNumber: 95309531, headHash: H_A, canonicalHash: H_B, chainHead: 95638224, fatalError: null },
    'orphaned',
  ],
  [
    'orphaned OUTRANKS lagging (an orphan is always also far behind)',
    { reachable: true, headNumber: 95309531, headHash: H_A, canonicalHash: H_B, chainHead: 99999999, fatalError: null },
    'orphaned',
  ],
  [
    'a deployment merely behind, on the canonical branch, is lagging and will recover',
    { reachable: true, headNumber: 95000000, headHash: H_A, canonicalHash: H_A, chainHead: 95638224, fatalError: null },
    'lagging',
  ],
  [
    'caught up',
    { reachable: true, headNumber: 95638200, headHash: H_A, canonicalHash: H_A, chainHead: 95638224, fatalError: null },
    'ok',
  ],
  [
    'exactly at the threshold is still ok (boundary is exclusive)',
    { reachable: true, headNumber: 95635224, headHash: H_A, canonicalHash: H_A, chainHead: 95638224, fatalError: null },
    'ok',
  ],
  [
    'one block past the threshold is lagging',
    { reachable: true, headNumber: 95635223, headHash: H_A, canonicalHash: H_A, chainHead: 95638224, fatalError: null },
    'lagging',
  ],
  [
    'hash comparison is case-insensitive (graph-node and RPC differ in casing)',
    { reachable: true, headNumber: 95638200, headHash: H_A.toUpperCase().replace('0X', '0x'), canonicalHash: H_A, chainHead: 95638224, fatalError: null },
    'ok',
  ],
  // graph-node 0.40.2 really does return bare hashes from the status API while the RPC returns
  // 0x-prefixed ones. Without normalisation this reports a healthy, caught-up deployment as
  // ORPHANED and tells the operator to rewind a perfectly good database. Found by running the
  // probe against the live stack, not by reasoning about it.
  [
    'graph-node returns a BARE hash, the RPC returns 0x-prefixed: same block, so ok',
    { reachable: true, headNumber: 95638200, headHash: H_A.slice(2), canonicalHash: H_A, chainHead: 95638224, fatalError: null },
    'ok',
  ],
  [
    'a bare hash that genuinely differs is still orphaned',
    { reachable: true, headNumber: 95309531, headHash: H_A.slice(2), canonicalHash: H_B, chainHead: 95638224, fatalError: null },
    'orphaned',
  ],
  [
    'a fatal error outranks lag',
    { reachable: true, headNumber: 95000000, headHash: H_A, canonicalHash: H_A, chainHead: 95638224, fatalError: 'boom' },
    'failed',
  ],
  [
    'a fatal error outranks an orphan too - graph-node has already given up, say so',
    { reachable: true, headNumber: 95309531, headHash: H_A, canonicalHash: H_B, chainHead: 95638224, fatalError: 'boom' },
    'failed',
  ],
  // The most important negative case. If the chain will not answer, we cannot run the
  // canonicity check - and a caught-up-looking lag must NOT be allowed to produce `ok`, or the
  // probe reports a check it never performed. Without this case, deleting the null-guard in
  // classify() still passes every other case here.
  [
    'chain would not serve the block: unknown, NOT ok, even when the lag looks fine',
    { reachable: true, headNumber: 95638200, headHash: H_A, canonicalHash: null, chainHead: 95638224, fatalError: null },
    'unknown',
  ],
  [
    'chain would not serve the block and it is also far behind: still unknown, not lagging',
    { reachable: true, headNumber: 95000000, headHash: H_A, canonicalHash: null, chainHead: 95638224, fatalError: null },
    'unknown',
  ],
  // The mirror of the case above, and the one the original code got wrong: it guarded only
  // canonicalHash, so a missing HEAD hash fell through to the lag check and could report `ok` -
  // skipping the canonicity check entirely while looking healthy.
  [
    'status API reported no head hash: unknown, NOT ok, even when the lag looks fine',
    { reachable: true, headNumber: 95638200, headHash: null, canonicalHash: H_A, chainHead: 95638224, fatalError: null },
    'unknown',
  ],
  [
    'an empty-string head hash is treated as missing, not as a mismatch',
    { reachable: true, headNumber: 95638200, headHash: '', canonicalHash: H_A, chainHead: 95638224, fatalError: null },
    'unknown',
  ],
  // A fat-fingered --lag-blocks used to make `lag > NaN` false for everything, i.e. a probe that
  // always reports ok. classify() refuses non-finite inputs; main() also exits 2 on the flag.
  [
    'a non-finite lag threshold refuses rather than reporting ok',
    { reachable: true, headNumber: 95000000, headHash: H_A, canonicalHash: H_A, chainHead: 95638224, fatalError: null },
    'unknown',
    NaN,
  ],
  [
    'a non-finite head number refuses rather than reporting ok',
    { reachable: true, headNumber: NaN, headHash: H_A, canonicalHash: H_A, chainHead: 95638224, fatalError: null },
    'unknown',
  ],
  [
    'status API down',
    { reachable: false },
    'unreachable',
  ],
  [
    'nothing at all',
    null,
    'unreachable',
  ],
]

function runSelfTest() {
  let failed = 0
  for (const [name, obs, want, lagBlocks] of SELF_TEST_CASES) {
    const got = classify(obs, lagBlocks === undefined ? DEFAULT_LAG_BLOCKS : lagBlocks).verdict
    const ok = got === want
    if (!ok) failed++
    console.log(`${ok ? '  ok  ' : '  FAIL'}  ${name}  ->  ${got}${ok ? '' : `  (expected ${want})`}`)
  }
  console.log(
    failed === 0
      ? `\nall ${SELF_TEST_CASES.length} verdict-precedence cases pass`
      : `\n${failed} of ${SELF_TEST_CASES.length} FAILED`,
  )
  return failed === 0
}

// ------------------------------------------------------------------------ main

function arg(args, name, fallback) {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

async function main() {
  const args = process.argv.slice(2)

  if (args.includes('--self-test')) process.exit(runSelfTest() ? 0 : 1)

  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node scripts/indexer-health.mjs [--status <url>] [--rpc <mainnet|testnet|url>]')
    console.log('                                       [--name a/b,c/d] [--lag-blocks <n>]')
    console.log('                                       [--json <file>] [--self-test]')
    process.exit(0)
  }

  const statusUrl = arg(args, '--status', DEFAULT_STATUS)
  const rpcArg = arg(args, '--rpc', 'testnet')
  const rpcUrl = RPC_ALIASES[rpcArg] ?? rpcArg
  // Validate rather than coerce. `Number('300O')` is NaN, and an unvalidated NaN threshold makes
  // `lag > lagBlocks` false for every deployment, so a typo in a cron entry would turn the probe
  // into something that always reports `ok`. classify() refuses NaN too; this is the second
  // layer, and it is the one that tells the operator which flag they fat-fingered. Exit 2 for
  // usage errors, matching scripts/rpc-probe.mjs.
  const lagRaw = arg(args, '--lag-blocks', String(DEFAULT_LAG_BLOCKS))
  const lagBlocks = Number(lagRaw)
  if (!Number.isFinite(lagBlocks) || lagBlocks < 0) {
    console.error(`--lag-blocks expects a non-negative number of blocks, got ${JSON.stringify(lagRaw)}`)
    process.exit(2)
  }

  const names = arg(args, '--name', DEFAULT_NAMES.join(',')).split(',').map((n) => n.trim()).filter(Boolean)
  if (names.length === 0) {
    console.error('--name expects at least one subgraph name, e.g. octopus/octopus')
    process.exit(2)
  }

  let out
  try {
    out = await run({ statusUrl, rpcUrl, lagBlocks, names })
  } catch (err) {
    console.error(`probe failed: ${err.message}`)
    process.exit(1)
  }

  const jsonPath = arg(args, '--json', null)
  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify(out, null, 2))
    console.log(`wrote ${jsonPath}`)
  }

  process.exit(render(out) ? 0 : 1)
}

// Only run when invoked directly, so the pure core can be imported by a test.
//
// pathToFileURL, not a `file://` template. This repo's checkout path contains a space
// ("Work Folder"), so import.meta.url is percent-encoded and never equals the raw argv[1].
// The naive comparison silently ran nothing at all - no error, no output.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`probe failed: ${err.message}`)
    process.exit(1)
  })
}
