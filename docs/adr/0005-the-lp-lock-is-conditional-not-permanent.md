# 5. The LP lock is conditional, not permanent

Date: 2026-08-02
Status: Accepted (supersedes the permanent-lock property asserted by ADR-adjacent design in #17)

## Context

Every graduated launch mints a full-range `TOKEN/WETH` position NFT straight into `LPLock`.
Until build #33 that contract's security claim was **structural**: it exposed no function that could transfer, burn, approve or `decreaseLiquidity` a position, so "the principal can never be withdrawn" was not a promise to trust but a fact anyone could verify by reading the immutable bytecode and finding the capability absent.

Two things forced a re-examination.

The first is that **a locked position is not a treasury holding the raise. It is the counterparty to every trade.**
As holders exit a graduated pool, the ETH is paid out to them and the position's composition shifts from ETH toward tokens.
A freshly graduated pool's position is worth roughly 10 ETH; a fully-exited one holds roughly 2 ETH and a billion worthless tokens.
Across every launch that graduates and then dies, that stranded value accumulates permanently and irrecoverably.

The second is that **a permanent lock is a promise about a decision nobody can revisit.**
Most launches fail. A dead pool's locked position provides liquidity to nobody, earns fees from nobody, and cannot be wound up.

## Decision

The lock becomes **conditional**:

- **1 year by default**, measured from graduation, owner-tunable within `[30 days, 100 years]` for future launches and frozen per launch at `createLaunch`.
- The creator may select a **permanent** lock at creation, and may `extend` at any time. Extension is **monotonic**: it can never shorten.
- An expired, non-permanent lock may be wound up by **anyone** via `reclaim`, but only when the pool has recorded **no activity for `inactivityPeriod`** (default 180 days). Proceeds are fixed: launch tokens burned to `0x…dEaD`, paired WETH to the treasury. There is no recipient parameter anywhere in the contract.

## Consequences

**The security model changed from "unreachable" to "guarded", and this is the whole cost of the decision.**
`reclaim` is now the highest-value attack surface in the protocol: a defect in its guards drains every graduated pool the factory has ever created.
It buys three specific mitigations in exchange:

1. **The gate is measured inactivity, not a calendar.** This is not a detail. Because a healthy position is worth ~5x a dead one, a **time-only** unlock right would be worth five times more when abused than when used as intended - it would pay best precisely when exercised against a thriving pool. Gating on liveness inverts that: the only positions `reclaim` can reach are the ones with nothing left worth taking.
2. **Destinations are fixed in code.** Nothing in `LPLock` can send principal to a caller, to the owner, or to a chosen address.
3. **`inactivityPeriod` is the one term read live rather than frozen**, which makes it a retroactive lever over locks that already exist. Its setter is therefore **monotonic - lengthen only** - so a creator can verify from the bytecode that their lock's terms can only ever move in their favour. The accepted cost is that a mistake here is permanent.

**Third-party liquidity is structurally excluded.**
A public LP-locking service for arbitrary pairs is on the roadmap, which would make `LPLock` a custodian of strangers' assets, and sweeping one of those to our treasury would be theft rather than reclamation.
Lock records therefore carry an `origin` (`None` / `Launch` / `ThirdParty`) fixed at lock time, and both `reclaim` and the creator fee split require `origin == Launch`.
`None` occupies the enum's **zero slot** deliberately: every field of an unregistered `tokenId` reads as zero, so had `Launch` sat at zero, any NFT a stranger transferred in would have read as a launch position and satisfied the guard. The ordering is load-bearing.

**Every surface claiming "locked forever" had to change.**
The claim was live in seven places across the frontend and in the `contracts/CONTEXT.md` glossary, on exactly the surfaces where someone decides whether to trust a pool. They now say "locked"; the per-position term is surfaced in #37.

**This is deliberately not reversible by redeploying alone.**
Positions locked under the old contract are held by the old contract. The change lands with the mandatory testnet redeploy, so no existing lock silently changes terms.
