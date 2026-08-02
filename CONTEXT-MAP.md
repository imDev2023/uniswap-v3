# Context Map

Octopus is a bonding-curve launchpad and DEX on Robinhood Chain.
Three contexts, and they deliberately do **not** share a language - the same real-world thing is called different names in each, because each cares about a different aspect of it.

## Contexts

- [Launchpad](./contracts/CONTEXT.md) - the on-chain domain: what a Launch is, how a Curve prices it, and what Graduation does. The source of truth.
- [Indexing](./subgraph/CONTEXT.md) - the derived read model built from Launchpad events, plus the operational vocabulary for whether that model can be trusted right now.
- [Trading UI](./frontend/CONTEXT.md) - what a person sees and does: browsing the Board, reading a Curve, trading, and launching.

## Relationships

- **Launchpad → Indexing**: one-way, event-sourced. Indexing consumes `LaunchCreated`, `Bought`, `Sold`, `Graduation` and `Graduated` and makes **no on-chain calls at all**. Everything in the read model is derived, and therefore rebuildable by re-indexing.
- **Launchpad → Trading UI**: direct. The trade path reads the chain and never the read model, so trading survives an Indexing outage. Trading UI trusts the Launchpad as the root of identity - it asks the launchpad "is this token yours?" rather than asking a token what launchpad it belongs to.
- **Indexing → Trading UI**: analytics only - charts, feeds, positions, rollups. Every surface fed by Indexing must be able to degrade on its own without taking the trade path with it.

## The one term that spans all three

**Launch** is the aggregate. It is created once and then lives in two phases:

| | on the Curve | after Graduation |
| --- | --- | --- |
| priced by | the Launch's own Curve | a Uniswap V3 pool |
| Launchpad calls it | a curve that has not `graduated` | a `graduated` curve; buys and sells revert |
| Indexing calls it | a `Token` with `graduated: false` | a `Token` with a `Graduation` |
| Trading UI calls it | a **live curve** | a **graduated** token, traded on the **swap page** |

⚠️ No context names this aggregate `Launch`, even though the Launchpad's own API does (`createLaunch`, `launchCount`, `LaunchCreated`).
Indexing calls it `Token` and keys it by the token address; the UI calls it a curve.
See the open question in [Indexing](./subgraph/CONTEXT.md#open-questions).
