# The Stage 4 de-risking probe (2026-08-01)

Not a build ticket: no branch, no merge, nothing fixed.
The deliverable is measurement.

Three unmeasured things were carrying the entire width of the remaining-work estimate (~9 tickets if they came back clean, ~15 if they bit - 5 days versus 3 weeks).
All three were measured.
**Two came back clean, and one of those inverted a risk into an opportunity.**
The third found real gaps, all of them bounded and sized.

Headline: **the single largest risk in the project - indexer lag at 0.1 s blocks - is gone, and Ponder is off the table.**

---

## Probe 3 first, because it reframes Probe 2

### The question

Stock graph-node settings never converge at testnet's 0.3 s blocks; the tuned compose env holds ~40 s.
Mainnet is confirmed at 0.100 s, ~3x worse.
Build #26 named this the likeliest operational surprise in Stage 4 and nothing had touched it.
If tuning could not close the gap, the fallback was [Ponder](https://ponder.sh) - rewriting every mapping and discarding 13 matchstick tests, a subproject rather than a ticket.

### What the self-hosted stack actually does

The indexer came up 31,112 blocks behind (stopped since the previous session) and closed that backlog in **under 16 seconds**.
Steady state, sampled every 15 s over 45 clean samples at a measured chain rate of 3.81 blocks/s:

| | blocks behind (min / median / max) | seconds behind (median / max) |
| --- | --- | --- |
| self-hosted graph-node | 92 / 178 / 578 | 46.7 s / 151.8 s |

That reproduces the ~40 s the compose file documents, and shows the tail is considerably worse than the median.

### Where the lag lives - localised, not guessed

Prometheus on host 8140 settles it in one reading:

```
chain_head_cache_latest_block  96023172   <- what the RPC says the head is
ethereum_chain_head_number     96023046   <- graph-node's OWN ingested head
deployment_head                96023046   <- the subgraph
```

`deployment_head == ethereum_chain_head_number`, exactly.
**The mapping is fully caught up at all times; 100 % of the lag is the block ingestor.**
The log scan, the mappings and Postgres are all innocent.

### The ingestor is bursty, not throughput-limited

Pausing the container for 180 s to build a ~1,025-block ingestor backlog, then sampling recovery every 2 s, shows the ingestor does not advance continuously.
It idles ~22 s, then jumps:

| burst | blocks moved | elapsed |
| --- | --- | --- |
| 1 | 326 | ≤3 s |
| 2 | 709 | ≤3 s |
| 3 | 97 | ≤2 s |
| 4 | 67 | ≤3 s |

A 1,025-block backlog cleared in two bursts inside ~30 s, and lag returned to its ~70-200 block floor.

**This is the finding that matters.**
The steady-state lag is a *sawtooth* whose period is a fixed ~22-25 s cycle, not a rate ceiling.
Burst capacity is **≥230 blocks/s** and was observed at ~709 blocks in ≤3 s.
Mainnet produces **10 blocks/s**.
There is roughly 23x headroom on the pessimistic reading of that number.

So the naive fear - "0.1 s blocks are 3x faster, therefore lag is 3x worse" - is wrong in kind.
Because the dominant term is a fixed cycle time rather than throughput, **wall-clock lag at 0.1 s should be comparable to what we see at 0.3 s**, while lag measured *in blocks* rises ~3x.
Anything reported in blocks will look alarming and mean nothing; measure and alert in seconds.

⚠️ What this does **not** prove: the ~22-25 s cycle was measured against the rate-limited public endpoint, which is also what `docker-compose.yml` points the indexer at.
Whether that period is graph-node's own pacing or RPC round-trip latency was not separated.
It only matters for the self-hosted fallback, because of what Probe 2 found.

---

## Probe 2 - managed subgraph hosting, and the Postgres `C` collation trap

### The question

Does *any* managed subgraph host support chain 4663 at all?
And graph-node requires `C` collation, settable only at cluster creation and unfixable afterwards without recreating the DB - so picking a managed Postgres that will not give it is a decision that cannot be walked back.

### Answer: Goldsky supports Robinhood Chain, and it is documented, not a sales conversation

Goldsky lists **Robinhood Chain** by name, **Mainnet and Testnet**, with slugs `robinhood-mainnet` / `robinhood-testnet` - which are *already exactly the network keys in our `subgraph/networks.json`*.
Products listed: Mirror, **Subgraphs**, Turbo, Compose, Edge RPC.
Confirmed on their public chains page and then confirmed by doing it.

Also found, and worth recording so nobody re-treads it:

- **Alchemy Subgraphs is deprecated.** Alchemy partnered with Goldsky and directs subgraph users there. Alchemy still serves Robinhood Chain for RPC and data APIs, which is what we already use it for.
- **Ormi Subgraphs** also advertises Robinhood Chain support - an unevaluated second option, so this is not a single-vendor dependency.

### It was not just checked, it was deployed

`npx graph build --network robinhood-testnet` then `goldsky subgraph deploy octopus-probe/1.0.0 --path .`

**Goldsky accepted our existing manifest unmodified.**
No schema change, no mapping change, no network rename.

Sync from `startBlock` 94091260 to head is **1,930,606 blocks in 425 seconds = ~4,543 blocks/s**.
For comparison, the local stack's #31 recovery re-indexed ~650,000 blocks in ~10 minutes (~1,080 blocks/s).

### Steady-state lag, measured side by side against the same chain

| | blocks behind (min / median / p90 / max) | seconds behind (median / p90 / max) |
| --- | --- | --- |
| **Goldsky (managed)** | -7 / **12** / 33 / 56 | **3.1 s** / 8.7 s / 14.7 s |
| self-hosted graph-node | 92 / **178** / 442 / 1027 | **46.6 s** / 116 s / 270 s |

*(The self-hosted p90/max here are contaminated by the deliberate 180 s pause from Probe 3; the clean pre-pause figures are median 178 / max 578 blocks. Goldsky's figures are uncontaminated.)*

**Goldsky is ~15x better at the median and ~18x better at the tail.**

The negative minimum is not an error and is worth keeping: Goldsky's indexed head is sometimes *ahead* of what the public RPC reports as the chain head.
That says nothing about Goldsky and everything about the public endpoint being a load-balanced pool with stale members - the same property `docs/rpc-capability.md` documents for `eth_call`.

### Throughput headroom against mainnet

4,543 blocks/s against mainnet's 10 blocks/s is **~450x headroom**.
Whether Goldsky's 12-56 block lag is time-bound or block-bound, both extrapolations are comfortable: block-bound gives 1.2-5.6 s at 0.1 s blocks, time-bound gives the same 3-15 s.
Either sits far inside the 5-minute ops alert.

### Our app runs on it with zero code changes

The board was pointed at the Goldsky endpoint at runtime (a `fetch` rewrite, no rebuild) and rendered identically: **16 launched, 2 graduated, `totalVolumeEth` equal to the wei.**
Full reconciliation across all three sources:

| source | launchCount |
| --- | --- |
| on-chain `launchCount()` | 16 |
| Goldsky | 16 (15 at the time of the first check, before a later probe launch) |
| local graph-node | 16 |

Migrating is a one-line `VITE_SUBGRAPH_URL` change.

### Consequences

1. ⚠️ **The Postgres `C` collation question is moot on the managed path** - it is Goldsky's cluster, not ours. The irreversible decision that could not be walked back simply is not ours to make any more. It returns only if we self-host, and our own `docker-compose.yml` already proves we can set it there (`POSTGRES_INITDB_ARGS: "-E UTF8 --locale=C"`).
2. ⚠️ **Indexer tuning for 0.1 s blocks stops being on the critical path.** Goldsky already beats our tuned stack by 15x on the *same* chain.
3. ⚠️ **Ponder is off the table.** It existed only as insurance against graph-node being unable to keep up. It can keep up, and the managed host keeps up comfortably.
4. **Indexer VM + managed Postgres line items drop out of the cost model**, replaced by Goldsky's free tier (paid tiers scale with usage; not yet priced for our volume).

### What this trades away, stated honestly

Build #31's reorg deadlock was recovered by purging graph-node's block cache directly in Postgres and running `graphman rewind`.
**Neither lever exists on managed infra.** If Goldsky hits the same ~134,300-block reorg, recovery is a support ticket, not a runbook.
That is a real transfer of control, not a pure win - though it is also a transfer of the *responsibility*, and the local stack's own recovery took a session of forensics to work out.
`scripts/indexer-health.mjs` still detects the condition against any endpoint, so we keep the detection either way.
Goldsky's reorg behaviour on this chain is **unmeasured** and cannot be induced on demand.

---

## Probe 1 - the create-token flow, opened for the first time

Run end to end against live testnet 46630 through the real UI, with a real wallet, at 390 / 768 / 1440 px.

**The flow works.** A token was created through the form and the page auto-navigated to it in under 2 seconds:

- `PROBE1` / "Probe Launch" - `0xda2F85fB578E6d1eB1dDaCF031AcC008E4faBC11`
- `BROKE` / "Broke Wallet" - `0x4768228593B54Fd955092A74521BA850ef77422c`

Both appear on the board, in the subgraph, and on their token pages.
Testnet `launchCount()` is now **16** (was 14).

Responsive layout is clean: **zero horizontal overflow at 390, 768 and 1440 px**, no element extending past the viewport at any width.
The rejected-signature path is handled properly - `wagmi` surfaces it and the form shows "User rejected the request." with the button restored.
A would-revert transaction is caught by viem's pre-flight gas estimation and surfaced as an error rather than being submitted, so the "silent hang on revert" failure I expected does **not** occur.

### What is unfinished, sized

**1. The metadata URI field has no validation whatsoever, and it writes permanently.** ⚠️ *The most consequential finding.*

Every one of these was accepted with the Launch button **enabled** and **no error shown**:

| input | accepted? |
| --- | --- |
| `ipfs//bafybeig…` (missing colon - a plausible typo) | ✅ enabled |
| `my cool token image` (free text) | ✅ enabled |
| `javascript:alert(document.domain)` | ✅ enabled |
| `http://example.com/meta.json` (rejected by the read side) | ✅ enabled |
| `"   "` (whitespace) | ✅ enabled |

The field's own hint says **"permanent - it can never be changed or removed, by you or anyone else"**, which is true.
The `symbol` field next to it is regex-validated. This one, which is irreversible, is not validated at all.

The read side is not at risk - `lib/ipfs.ts` correctly returns no URLs for every one of those, and `lib/tokenMetadata.ts` allowlists `https:` for anything that becomes an `href`, so `javascript:` never reaches an anchor.
**This is a UX defect, not a security hole**, and that is precisely what makes it bad: the app will permanently record a URI it has already decided to ignore forever, and tell the creator nothing - not at creation, and not afterwards, because a broken URI and no URI both render the same identicon.
Testnet already has two tokens in exactly this state (`OCAT`, `BOOTS`, from #30).

The fix is small because the machinery exists: `gatewayUrls()` and `fetchTokenMetadata()` already do the parsing and fetching. What is missing is calling them from the create form, before the irreversible write, and showing the creator what will be stored.

**2. `maxLength={40}` on the name field, but validation rejects `> 32`.**
Eight characters can be typed that the form then silently refuses to submit ("Too long", button disabled). Measured: `value.length = 35, maxLength = 40`.

**3. There is no search, no pagination, and no address lookup on the board.**
`BOARD_PAGE_SIZE = 50`, one page, no "load more" control anywhere.
Past 50 live curves a token is reachable only if it ranks in the top 50 of one of the four sorts (New / Closest / Volume / Busiest).
There is also no input anywhere in the UI to open a token by address - the Stage 2 degraded state literally instructs users to go to `/token/<address>` and gives them no way to do it.
On a launchpad whose whole premise is a high launch rate, this is a product gap rather than a nicety.

**4. Wallet support is injected-only, which means mobile does not work.** ⚠️ *Larger than it looks.*
`wagmiConfig` declares `connectors: [injected()]` - no WalletConnect, no Coinbase Wallet SDK.
A mobile browser has no injected provider, so the app cannot connect at all on mobile except inside a wallet's in-app browser.
The responsive work is real and good, and it is currently in service of a page that cannot transact on the devices it was made for.

Secondary: `ConnectButton` picks `connectors.find(c => c.type === 'injected')` - the **first** one.
wagmi v2's EIP-6963 discovery is on by default and does register multiple wallets (verified - an announced test provider was picked up), but the UI has no picker, so a user with two extensions installed silently gets whichever wagmi lists first.

### Not found

- No layout overflow at any tested width.
- No broken metadata rendering: `OPIN`'s pinned `ipfs://` image and `ORICH`'s `data:` URI both resolve and paint on the board.
- The board's numbers agree with the chain and with both indexers.
- Price notation, heat colours, identicon fallbacks and empty-state cards all behave as #28 describes.

---

## Method notes worth keeping

**Driving the real wallet path without putting a key in the browser.**
The create flow cannot be exercised without a wallet, and the app supports only injected providers.
A ~50-line local signing relay held the testnet key and exposed a JSON-RPC endpoint; a shim installed as `window.ethereum` proxied to it.
The browser never saw the key, and the app took the ordinary `useWriteContract` path with no test hooks.
This also made fault injection trivial - a rejected signature and a value-stripped transaction were both produced by changing four lines in the shim.

**The measurement that localised Probe 3 was one Prometheus scrape, not a day of tuning.**
`deployment_head == ethereum_chain_head_number` immediately ruled out the mappings, the log scan and Postgres, and pointed at the block ingestor.
The bursty-recovery experiment then distinguished "fixed cycle" from "rate ceiling", which is the distinction the whole mainnet extrapolation turns on.
Sampling the steady state alone could never have made that distinction - it needed a *perturbation*, which is why the container was deliberately paused.

**A risk framed as an engineering problem turned out to be a procurement question.**
Probe 3 was scoped as "can we tune graph-node fast enough". The answer that mattered was "somebody else already has, on this exact chain, and will let us use it".
Both prior estimates for these rows assumed we would build our way out.
