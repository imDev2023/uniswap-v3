# Trading UI

What a person sees and does: browsing launches, reading a curve, trading, and launching their own.

The organising constraint is that this context is fed by two sources with very different trustworthiness - the chain, which is authoritative, and the read model, which may be stale.
The vocabulary below exists largely to keep those two apart on screen.

## Language

### Surfaces

**Board**:
The browse surface listing live curves. Dense and kinetic by design - it should read as a heat map before any single number is parsed.
_Avoid_: home, feed, explore page, listing

**Card**:
One Launch's tile on the Board. Its progress meter is the primary element, carrying both a length and a heat colour.
_Avoid_: row, item, tile

**Rail**:
A narrow column of recent activity beside a main surface - trades across all launches on the Board, or one Launch's trades on its page.
_Avoid_: sidebar, ticker (a ticker is the graduated strip), activity feed

**Trade Panel** / **Swap Panel**:
Where a person buys or sells. A Trade Panel works against a Curve, a Swap Panel against a Pool. They are different markets and are deliberately not the same surface.
_Avoid_: buy box, widget, exchange

### Honesty about data

**Trade Path**:
Everything needed to actually transact - resolving a Launch, quoting, and submitting. It reads the chain only, so it works when the read model does not.
_Avoid_: happy path, core flow

**Indexed Panel**:
Any surface fed by the read model - charts, positions, feeds, rollups. Each one degrades independently and says so.
_Avoid_: analytics, secondary content

**Degraded State**:
What an Indexed Panel shows when the read model cannot be trusted. It is a designed state, not an error, and it must be distinguishable from genuine emptiness.
_Avoid_: error state, loading state, fallback

⚠️ **An empty Indexed Panel and a degraded one must never look alike.** "No trades yet" on a curve that has traded all day is a worse lie than an error, because it reads as fact.

**Identicon**:
The generated avatar shown when a Launch has no usable image. Derived from the token address, never the symbol - a symbol is creator-chosen and duplicable, so deriving from it would let two Launches wear the same face.
_Avoid_: placeholder, default avatar, fallback image

### Moderation

**Denylist**:
The list of Launches whose presentation is restricted. Two tiers: suppress the imagery, or remove the Launch from browse surfaces entirely.
_Avoid_: blocklist, ban list, blacklist

⚠️ **Neither tier ever blocks trading, deliberately.** Someone may already hold a Launch we later hide, and refusing to render their Trade Panel would strand them in a position they cannot exit. Moderation governs discovery, never exit.

Keyed by token address - never by symbol, which is creator-chosen and duplicable, and never by metadata document, which can be re-published to escape.

### Presentation

**Subscript Notation**:
How launch-scale prices are written, compressing leading zeros rather than falling back to exponent form. Every price on this product is small enough to need it.
_Avoid_: scientific notation, exponential

**Curve Position**:
An address's net stake in one Curve. The Curve Positions panel shows these, and they are blind to transfers and frozen at graduation - so the label says what it counts, and presents a graduated Launch's positions as final rather than current.
_Avoid_: **holder**, holding, balance

✅ **Settled 2026-08-01, shipped in #36 (schema) and #37 (identifiers and visible copy).** See [Indexing](../subgraph/CONTEXT.md#resolved). The model stayed; the words changed.

**Launch Terms**:
The lock duration, creator fee share, permanent-lock choice and dev allocation, all frozen at `createLaunch` and readable per token from the chain.

⚠️ **Terms are Trade Path, not Indexed Panel**, and this was learned the hard way in #37: the lock and vesting panels were first built off the indexed row, and an Indexing outage silently removed the panel a buyer reads to decide whether the liquidity is locked - taking the Creator's claim button with it. Nothing frozen at creation should depend on the read model, because the chain answers it directly and always.

**Dev Allocation**:
The Creator's free carve out of the Curve Allocation, custodied by the vault and released linearly from Graduation. Always presented as **two** numbers - granted and released - because they differ for the whole vesting window.
_Avoid_: creator holdings, premine (accurate, but it names the mechanism rather than the term the product uses)

⚠️ **Vested-so-far is computed, never stored.** It is a continuous function of wall-clock time, so any indexed figure is stale between events. See [Indexing](../subgraph/CONTEXT.md#resolved).

## Open questions

### A "curve" on the Board is a Launch

The Board says **live curves**, which is precise while a Launch is on its Curve and stops being true the moment it graduates - at which point the same thing becomes a "graduated" entry in the ticker.
There is currently no single word here for the thing that persists across both phases.
