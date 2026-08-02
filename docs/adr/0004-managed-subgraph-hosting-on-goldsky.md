# Indexing runs on Goldsky, not a self-hosted graph-node

Robinhood Chain is not on The Graph's hosted or decentralized networks, so the read model ran on a self-hosted graph-node and the plan was to keep doing that on a VM with managed Postgres.
Measurement on 2026-08-01 changed the answer: Goldsky supports the chain by name, **accepted our existing manifest unmodified**, and indexes it far tighter than our own tuned stack.

## Considered options

Self-hosting graph-node was the incumbent. [Ponder](https://ponder.sh) was the insurance policy against graph-node being unable to keep up with 0.1 s blocks, at the cost of rewriting every mapping and discarding the matchstick suite.

Measured, on the same chain, at the same time:

| | median lag | p90 | full sync |
| --- | --- | --- | --- |
| Goldsky | **12 blocks / 3.1 s** | 33 / 8.7 s | 1.93M blocks in 425 s |
| self-hosted graph-node | **178 blocks / 46.7 s** | 442 / 116 s | ~1,080 blocks/s |

Ponder is therefore dropped: it existed only to insure against a problem that does not exist.

## Consequences

- **The Postgres `C` collation trap stops being ours.** It could only be set at cluster creation and was unfixable afterwards - an irreversible decision now made on someone else's infrastructure. It returns only if we ever self-host again.
- **Indexer tuning for fast blocks stops being work.** The lag was never throughput: it is entirely block ingestion, and there is roughly two orders of magnitude of headroom against mainnet's block rate.
- ⚠️ **We lose the recovery levers that fixed the reorg deadlock.** That incident was resolved by purging graph-node's block cache directly in Postgres and rewinding the deployment. Neither is available on managed infrastructure, so the same failure becomes a support ticket rather than a runbook. Goldsky's behaviour under a large reorg on this chain is **unmeasured and cannot be induced on demand**.
- Detection is unaffected and stays ours: lag and canonicity are computed against any endpoint.
- Not a single-vendor dependency - Ormi also supports the chain, unevaluated. Alchemy's own subgraph product is deprecated in Goldsky's favour, so Alchemy remains our RPC provider and is unaffected by this decision.
