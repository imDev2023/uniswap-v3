#!/usr/bin/env node
// Octopus RPC capability probe.
//
// Measures the things Stage 4 depends on for a given JSON-RPC endpoint:
//   - identity (chain id, client, head, observed block time)
//   - eth_getLogs retention depth   <- the one that decides whether re-indexing is possible
//   - eth_getLogs span and result caps
//   - historical state (archive) depth, and whether `latest` is queryable
//   - presence of the contracts the stack reads (Multicall3, WETH9, USDG)
//   - batch-request support, concurrency behaviour, optional method availability
//
// The chain is the source of truth and Postgres is a derived cache, but that only
// holds while the node will still serve logs from the deploy block. If retention is
// shallower than the deployment age, a lost indexer DB becomes unrecoverable data
// loss rather than an availability incident. That is what this script measures.
//
// Usage:
//   node scripts/rpc-probe.mjs mainnet
//   node scripts/rpc-probe.mjs testnet
//   node scripts/rpc-probe.mjs https://some-candidate-provider.example/rpc
//   node scripts/rpc-probe.mjs mainnet --json probe-mainnet.json
//
// No dependencies; needs Node 18+ for global fetch.

const ALIASES = {
  mainnet: 'https://rpc.mainnet.chain.robinhood.com',
  testnet: 'https://rpc.testnet.chain.robinhood.com',
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

let rpcCallCount = 0

const hex = (n) => '0x' + BigInt(n).toString(16)
const toNum = (h) => Number(BigInt(h))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * One JSON-RPC call. Never throws; returns a discriminated result so callers can
 * tell "the node said no" (a real capability limit) from "the network flaked".
 */
async function rpc(url, method, params = [], { timeoutMs = 30000, retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    rpcCallCount++
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
      if (res.status === 429 || res.status >= 500) {
        if (attempt < retries) {
          await sleep(500 * (attempt + 1))
          continue
        }
        return { ok: false, transport: `HTTP ${res.status}`, body: text.slice(0, 200) }
      }
      let json
      try {
        json = JSON.parse(text)
      } catch {
        return { ok: false, transport: 'non-JSON response', body: text.slice(0, 200) }
      }
      if (json.error) return { ok: false, error: json.error }
      return { ok: true, result: json.result }
    } catch (err) {
      if (attempt < retries) {
        await sleep(500 * (attempt + 1))
        continue
      }
      return { ok: false, transport: err.name === 'AbortError' ? 'timeout' : String(err) }
    } finally {
      clearTimeout(timer)
    }
  }
}

const why = (r) => (r.error ? `${r.error.message} (code ${r.error.code})` : r.transport)

/** Seconds to a readable age. Retention windows range from minutes to weeks. */
function humanizeAge(sec) {
  if (sec < 3600) return `${(sec / 60).toFixed(0)} min`
  if (sec < 86400) return `${(sec / 3600).toFixed(1)} hours`
  return `${(sec / 86400).toFixed(1)} days`
}

/**
 * Largest depth-style boundary search. `works(block)` must be monotonic in the
 * sense that if a block is served, every newer block is too. Returns the oldest
 * block number that still works.
 */
async function oldestServed(head, works) {
  if (await works(0)) return 0
  let bad = 0 // known-failing
  let good = head // known-working
  if (!(await works(good))) return null // nothing works at all
  while (good - bad > 1) {
    const mid = Math.floor((bad + good) / 2)
    if (await works(mid)) good = mid
    else bad = mid
  }
  return good
}

// ------------------------------------------------------------------- reporting

const report = { probedAt: new Date().toISOString(), endpoint: null, sections: {} }
const lines = []

function head(title) {
  lines.push('')
  lines.push(`### ${title}`)
}
function row(label, value) {
  lines.push(`  ${label.padEnd(34)} ${value}`)
}

// ---------------------------------------------------------------------- probes

async function main() {
  const args = process.argv.slice(2)
  const target = args[0]
  if (!target) {
    console.error('usage: node scripts/rpc-probe.mjs <mainnet|testnet|url> [--json out.json]')
    process.exit(2)
  }
  const jsonIdx = args.indexOf('--json')
  const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : null
  const url = ALIASES[target] ?? target
  report.endpoint = url

  lines.push(`Octopus RPC capability probe`)
  lines.push(`endpoint: ${url}`)
  lines.push(`probed:   ${report.probedAt}`)

  // -- identity ------------------------------------------------------------
  head('Identity')
  const [chainId, clientVersion, blockNumber, syncing] = await Promise.all([
    rpc(url, 'eth_chainId'),
    rpc(url, 'web3_clientVersion'),
    rpc(url, 'eth_blockNumber'),
    rpc(url, 'eth_syncing'),
  ])
  if (!chainId.ok || !blockNumber.ok) {
    row('FATAL', `endpoint unusable: ${why(chainId.ok ? blockNumber : chainId)}`)
    console.log(lines.join('\n'))
    process.exit(1)
  }
  const chain = toNum(chainId.result)
  const headBlock = toNum(blockNumber.result)
  row('chainId', `${chain}`)
  row('client', clientVersion.ok ? clientVersion.result : `unavailable (${why(clientVersion)})`)
  row('head block', headBlock.toLocaleString())
  row('eth_syncing', syncing.ok ? JSON.stringify(syncing.result) : `unavailable (${why(syncing)})`)

  const weth9 = WETH9_BY_CHAIN[chain]
  if (!weth9) row('WARN', `no known WETH9 for chain ${chain}; log probes will use Multicall3`)
  // Probe address for log queries: prefer WETH9, which is active across all history.
  const logProbeAddress = weth9 ?? MULTICALL3
  // State probe: an eth_call that must touch the state trie. WETH9.totalSupply()
  // where known, else Multicall3.getCurrentBlockTimestamp() - either still has to
  // load the account and code, so pruned state surfaces as an error.
  const stateProbeAddress = weth9 ?? MULTICALL3
  const stateProbeData = weth9 ? '0x18160ddd' : '0x0f28c97d'

  // Observed block time over the last 10k blocks. Reference head-1, not head: the
  // node occasionally returns null for the block it just reported as head.
  const refBlock = Math.max(1, headBlock - 1)
  const SPAN = Math.min(10_000, refBlock)
  const [bNow, bThen] = await Promise.all([
    rpc(url, 'eth_getBlockByNumber', [hex(refBlock), false]),
    rpc(url, 'eth_getBlockByNumber', [hex(refBlock - SPAN), false]),
  ])
  let blockTime = null
  if (bNow.ok && bThen.ok && bNow.result && bThen.result) {
    blockTime = (toNum(bNow.result.timestamp) - toNum(bThen.result.timestamp)) / SPAN
    row('observed block time', `${blockTime.toFixed(3)} s  (over ${SPAN.toLocaleString()} blocks)`)
  } else {
    row('observed block time', `could not measure (${why(bNow.ok ? bThen : bNow)})`)
  }
  report.sections.identity = { chainId: chain, client: clientVersion.result ?? null, headBlock, blockTime }

  // Chain age. Block 0 carries timestamp 0 on this chain, so read block 1. The
  // lifetime average matters because it differs sharply from the recent rate
  // (4663: ~0.24 s lifetime vs ~0.10 s recent), and extrapolating the recent rate
  // across all history would misstate every depth-to-age conversion.
  const firstBlk = await rpc(url, 'eth_getBlockByNumber', ['0x1', false])
  const genesisTs = firstBlk.ok && firstBlk.result ? toNum(firstBlk.result.timestamp) : null
  if (genesisTs && bNow.ok && bNow.result) {
    const ageSec = toNum(bNow.result.timestamp) - genesisTs
    row('chain age', `${(ageSec / 86400).toFixed(1)} days since block 1`)
    row('lifetime avg block time', `${(ageSec / refBlock).toFixed(3)} s`)
    report.sections.identity.chainAgeDays = Number((ageSec / 86400).toFixed(1))
    report.sections.identity.lifetimeBlockTime = Number((ageSec / refBlock).toFixed(4))
  }

  const blocksToDays = (n) => (blockTime ? `${((n * blockTime) / 86400).toFixed(1)} days` : 'unknown')

  // -- log retention -------------------------------------------------------
  head('eth_getLogs retention  [CRITICAL: decides whether re-indexing is possible]')

  // Does the node ERROR on old ranges, and if so where is the boundary?
  const logWorks = async (b) => {
    const r = await rpc(url, 'eth_getLogs', [
      { fromBlock: hex(b), toBlock: hex(b), address: logProbeAddress },
    ])
    return r.ok
  }
  const oldestLogBlock = await oldestServed(headBlock, logWorks)
  if (oldestLogBlock === null) {
    row('boundary', 'eth_getLogs failed even at head - see errors below')
  } else if (oldestLogBlock === 0) {
    row('boundary', 'block 0 served - NO log pruning detected')
  } else {
    row('boundary', `oldest served block ${oldestLogBlock.toLocaleString()}`)
    row('depth from head', `${(headBlock - oldestLogBlock).toLocaleString()} blocks (~${blocksToDays(headBlock - oldestLogBlock)})`)
  }

  // Explicit `earliest` keyword, which is what a naive re-index would use.
  const earliest = await rpc(url, 'eth_getLogs', [
    { fromBlock: 'earliest', toBlock: hex(Math.min(500, headBlock)), address: logProbeAddress },
  ])
  row('fromBlock: "earliest"', earliest.ok ? `accepted (${earliest.result.length} logs)` : `REJECTED - ${why(earliest)}`)

  // A node that silently returns [] instead of erroring is the dangerous case:
  // graph-node would index a gap as "no activity" rather than failing loudly. So
  // sample at several depths with NO address filter: on a chain producing blocks
  // continuously, an empty unfiltered window is implausible and means pruning.
  //
  // The window has to adapt. Mainnet caps results at 10k logs and runs ~0.1 s
  // blocks, so a fixed 5k-block window errors everywhere and measures nothing.
  // Shrink until the node answers, and report the width that worked.
  const logsAdaptive = async (from, filter) => {
    for (let width = 5_000; width >= 1; width = Math.floor(width / 5)) {
      const params = { fromBlock: hex(from), toBlock: hex(from + width) }
      if (filter) params.address = filter
      const r = await rpc(url, 'eth_getLogs', [params], { timeoutMs: 60000 })
      if (r.ok) return { ok: true, width, count: r.result.length }
      // A result-cap error means logs are plentiful there, which already answers
      // the retention question; only keep shrinking to get an exact count.
      if (!/exceeds limit|too many|timed out/i.test(why(r)) ) return { ok: false, width, error: why(r) }
    }
    return { ok: false, width: 0, error: 'no window small enough' }
  }

  const depthSamples = []
  for (const frac of [0, 0.001, 0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.95]) {
    const from = Math.max(1, Math.floor(headBlock * (1 - frac)))
    const any = await logsAdaptive(from, null)
    depthSamples.push({ fromBlock: from, blocksBack: headBlock - from, ...any })
  }
  lines.push('')
  lines.push('  Unfiltered log windows at increasing depth (width auto-shrunk to fit the result cap).')
  lines.push('  Any window that is served proves logs still exist at that depth.')
  lines.push(`  ${'blocks back'.padStart(13)}  ${'from'.padStart(12)}  ${'width'.padStart(7)}  result`)
  for (const s of depthSamples) {
    const res = s.ok ? `${s.count.toLocaleString()} logs` : `ERROR - ${s.error}`
    lines.push(
      `  ${s.blocksBack.toLocaleString().padStart(13)}  ${s.fromBlock.toLocaleString().padStart(12)}  ${String(s.width).padStart(7)}  ${res}`,
    )
  }
  const silentlyEmpty = depthSamples.filter((s) => s.ok && s.count === 0)
  if (silentlyEmpty.length > 0) {
    lines.push('')
    lines.push(`  WARNING: ${silentlyEmpty.length} unfiltered window(s) returned 0 logs WITHOUT erroring.`)
    lines.push('           On a chain producing blocks continuously that is implausible, and is the')
    lines.push('           signature of a node that prunes logs silently. A re-index would record')
    lines.push('           the gap as "no activity" rather than failing loudly. Investigate before')
    lines.push('           relying on this endpoint as the rebuild source.')
  } else {
    lines.push('')
    lines.push('  All sampled depths returned logs. No silent-pruning signature.')
  }
  report.sections.logRetention = { oldestServedBlock: oldestLogBlock, earliestAccepted: earliest.ok, depthSamples }

  // -- getLogs span cap ----------------------------------------------------
  head('eth_getLogs span and result caps')
  const spanWorks = async (span) => {
    const from = Math.max(0, headBlock - span)
    const r = await rpc(url, 'eth_getLogs', [
      { fromBlock: hex(from), toBlock: hex(headBlock), address: logProbeAddress, topics: ['0x' + '00'.repeat(32)] },
    ])
    return r.ok
  }
  // Grow until it breaks, then binary search between the last good and first bad.
  let goodSpan = 0
  let badSpan = null
  for (const span of [1, 10, 100, 1_000, 10_000, 100_000, 1_000_000, 10_000_000, headBlock]) {
    if (span > headBlock) break
    if (await spanWorks(span)) goodSpan = span
    else {
      badSpan = span
      break
    }
  }
  if (badSpan === null) {
    row('max span (filtered)', `no cap found up to ${goodSpan.toLocaleString()} blocks (full history)`)
  } else {
    let lo = goodSpan
    let hi = badSpan
    while (hi - lo > Math.max(1, Math.floor(lo * 0.05))) {
      const mid = Math.floor((lo + hi) / 2)
      if (await spanWorks(mid)) lo = mid
      else hi = mid
    }
    row('max span (filtered)', `~${lo.toLocaleString()} blocks; ${badSpan.toLocaleString()} rejected`)
    const rej = await rpc(url, 'eth_getLogs', [
      { fromBlock: hex(Math.max(0, headBlock - badSpan)), toBlock: hex(headBlock), address: logProbeAddress },
    ])
    if (!rej.ok) row('rejection message', why(rej))
  }

  // Result-count cap: widen an unfiltered-topic query until the node complains.
  let maxLogs = 0
  let resultCapMsg = 'no cap hit'
  for (const span of [100, 1_000, 10_000, 100_000, 1_000_000]) {
    if (span > headBlock) break
    const r = await rpc(url, 'eth_getLogs', [
      { fromBlock: hex(Math.max(0, headBlock - span)), toBlock: hex(headBlock), address: logProbeAddress },
    ], { timeoutMs: 60000 })
    if (r.ok) maxLogs = Math.max(maxLogs, r.result.length)
    else {
      resultCapMsg = `${why(r)} (at ${span.toLocaleString()}-block span)`
      break
    }
  }
  row('largest result seen', `${maxLogs.toLocaleString()} logs`)
  row('result cap', resultCapMsg)
  report.sections.logCaps = { maxSpan: badSpan === null ? 'uncapped' : goodSpan, maxLogsSeen: maxLogs, resultCap: resultCapMsg }

  // -- historical state ----------------------------------------------------
  head('Historical state (archive depth)')
  // Measure with eth_call, NOT eth_getBalance. On Nitro, eth_getBalance against a
  // pruned block returns 0x0 with no error, which is indistinguishable from a real
  // zero balance - it reports "full archive" on a node that has pruned everything.
  // eth_call surfaces the truth as `missing trie node`. Confirmed on 46630, where
  // the two methods disagree from ~20k blocks back.
  //
  // Reported as a ladder rather than a binary search. A search assumes monotonicity,
  // but eth_call returns bare `0x` (no error) at blocks predating the probe contract,
  // which reads as "served" and would report full archive on a pruned node. The ladder
  // shows the real pattern and separates "state served" from "contract not yet
  // deployed", so a false full-archive claim cannot hide in it.
  const STATE_ERR = /missing trie node|state .* is not available|not available|pruned|unsupported block/i
  const classify = (r) => {
    if (r.ok) return r.result && r.result !== '0x' ? 'served (data)' : 'served (contract absent)'
    return STATE_ERR.test(why(r)) ? `NO STATE - ${why(r).slice(0, 60)}` : `error - ${why(r).slice(0, 60)}`
  }
  const stateLadder = []
  for (const back of [
    0, 100, 1_000, 5_000, 10_000, 20_000, 50_000, 100_000,
    1_000_000, 5_000_000, 10_000_000, 20_000_000, 50_000_000,
  ]) {
    if (back > headBlock) break
    const b = headBlock - back
    const [call, bal] = await Promise.all([
      rpc(url, 'eth_call', [{ to: stateProbeAddress, data: stateProbeData }, hex(b)]),
      rpc(url, 'eth_getBalance', [stateProbeAddress, hex(b)]),
    ])
    stateLadder.push({ back, block: b, call: classify(call), callOk: call.ok, balanceOk: bal.ok })
  }
  lines.push('')
  lines.push(`  eth_call ${stateProbeData} -> ${stateProbeAddress} at increasing depth:`)
  lines.push(`  ${'blocks back'.padStart(12)}  ${'block'.padStart(12)}  ${'getBalance'.padStart(11)}  eth_call`)
  for (const s of stateLadder) {
    lines.push(
      `  ${s.back.toLocaleString().padStart(12)}  ${s.block.toLocaleString().padStart(12)}  ${(s.balanceOk ? 'ok' : 'error').padStart(11)}  ${s.call}`,
    )
  }
  const firstNoState = stateLadder.find((s) => s.call.startsWith('NO STATE'))
  let stateBoundary = null
  lines.push('')
  if (firstNoState) {
    const lastGood = [...stateLadder].reverse().find((s) => s.callOk && s.back < firstNoState.back)
    // Narrow the exact boundary between the deepest served and shallowest pruned
    // sample. Only run when the ladder itself evidenced the transition, so this is
    // not assuming monotonicity, it is refining an interval the ladder established.
    if (lastGood) {
      let good = lastGood.block
      let bad = firstNoState.block
      while (good - bad > 2_000) {
        const mid = Math.floor((good + bad) / 2)
        const r = await rpc(url, 'eth_call', [{ to: stateProbeAddress, data: stateProbeData }, hex(mid)])
        if (r.ok) good = mid
        else bad = mid
      }
      stateBoundary = good
      // Express the depth in wall-clock time from the block's own timestamp.
      // Extrapolating from the recent block time is wrong here: on 4663 the recent
      // rate is ~0.10 s while the lifetime average is ~0.24 s.
      const bBlk = await rpc(url, 'eth_getBlockByNumber', [hex(good), false])
      const nowSec = Math.floor(Date.now() / 1000)
      const ageStr = bBlk.ok && bBlk.result ? humanizeAge(nowSec - toNum(bBlk.result.timestamp)) : 'age unknown'
      row('oldest state served', `block ${good.toLocaleString()} (+/- 2k)`)
      row('state retention depth', `${(headBlock - good).toLocaleString()} blocks = ~${ageStr}`)
    } else {
      row('state pruned beyond', `~${firstNoState.back.toLocaleString()} blocks`)
    }
    // The trap that made the first version of this probe report "full archive".
    const trap = stateLadder.filter((s) => s.balanceOk && !s.callOk)
    if (trap.length) {
      row('silent-pruning trap', `eth_getBalance succeeds at ${trap.length} pruned depth(s)`)
      lines.push('        where eth_call correctly errors. Never measure archive depth with')
      lines.push('        eth_getBalance on this endpoint; it reports success on pruned state.')
    }
  } else {
    row('state pruning', 'none observed at any sampled depth (archive node)')
  }

  // Testnet 46630 rejects state at the newest block outright; fork tests have to
  // step back. Worth knowing per endpoint rather than assuming.
  const callLatest = await rpc(url, 'eth_call', [{ to: MULTICALL3, data: '0x0f28c97d' }, 'latest'])
  row('eth_call at "latest"', callLatest.ok ? 'works' : `REJECTED - ${why(callLatest)}`)
  const callHeadNum = await rpc(url, 'eth_call', [{ to: MULTICALL3, data: '0x0f28c97d' }, hex(headBlock)])
  row('eth_call at head (numeric)', callHeadNum.ok ? 'works' : `REJECTED - ${why(callHeadNum)}`)
  const callBack = await rpc(url, 'eth_call', [{ to: MULTICALL3, data: '0x0f28c97d' }, hex(Math.max(0, headBlock - 300))])
  row('eth_call at head-300', callBack.ok ? 'works' : `REJECTED - ${why(callBack)}`)
  report.sections.state = {
    ladder: stateLadder,
    prunedBeyondBlocks: firstNoState ? firstNoState.back : null,
    oldestStateBlock: stateBoundary,
    latestQueryable: callLatest.ok,
    headNumericQueryable: callHeadNum.ok,
  }

  // -- contract presence ---------------------------------------------------
  head('Contract presence')
  const targets = [['Multicall3', MULTICALL3], ['WETH9', weth9], ['USDG (mainnet)', USDG_MAINNET]].filter(
    ([, a]) => Boolean(a),
  )
  const presence = {}
  for (const [name, addr] of targets) {
    const r = await rpc(url, 'eth_getCode', [addr, 'latest'])
    const size = r.ok && r.result && r.result !== '0x' ? (r.result.length - 2) / 2 : 0
    presence[name] = size
    row(name, size > 0 ? `${size.toLocaleString()} bytes at ${addr}` : `NO CODE at ${addr}`)
  }
  report.sections.contracts = presence

  // -- transport behaviour -------------------------------------------------
  head('Transport')
  const batchRes = await (async () => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([
          { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
          { jsonrpc: '2.0', id: 2, method: 'eth_blockNumber', params: [] },
          { jsonrpc: '2.0', id: 3, method: 'eth_gasPrice', params: [] },
        ]),
      })
      const j = await res.json()
      return Array.isArray(j) ? `supported (${j.length} responses)` : 'NOT supported (non-array response)'
    } catch (err) {
      return `NOT supported (${String(err)})`
    }
  })()
  row('JSON-RPC batch', batchRes)

  const BURST = 30
  const t0 = Date.now()
  const burst = await Promise.all(
    Array.from({ length: BURST }, () => rpc(url, 'eth_blockNumber', [], { retries: 0 })),
  )
  const failed = burst.filter((r) => !r.ok)
  row(
    `burst of ${BURST} concurrent`,
    `${BURST - failed.length}/${BURST} ok in ${Date.now() - t0} ms` +
      (failed.length ? ` - first failure: ${why(failed[0])}` : ''),
  )
  report.sections.transport = { batch: batchRes, burstOk: BURST - failed.length, burstTotal: BURST }

  // -- optional methods ----------------------------------------------------
  head('Optional methods')
  const optional = [
    ['eth_getBlockReceipts', [hex(headBlock - 10)]],
    ['eth_feeHistory', ['0x4', 'latest', []]],
    ['eth_maxPriorityFeePerGas', []],
    ['debug_traceTransaction', ['0x' + '00'.repeat(32)]],
    ['trace_block', [hex(headBlock - 10)]],
    ['eth_getFilterChanges', ['0x1']],
    ['eth_newFilter', [{ fromBlock: 'latest', toBlock: 'latest' }]],
  ]
  const methods = {}
  for (const [m, p] of optional) {
    const r = await rpc(url, m, p, { retries: 0 })
    // A method-level error still proves the method is routed; "method not found"
    // (-32601) is the only answer that means genuinely unavailable.
    const available = r.ok || (r.error && r.error.code !== -32601)
    methods[m] = available
    row(m, available ? 'available' : 'NOT available')
  }
  report.sections.optionalMethods = methods

  // -- summary -------------------------------------------------------------
  head('Summary')
  row('rpc calls made', `${rpcCallCount}`)

  console.log(lines.join('\n'))
  if (jsonOut) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(jsonOut, JSON.stringify(report, null, 2))
    console.log(`\nJSON written to ${jsonOut}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
