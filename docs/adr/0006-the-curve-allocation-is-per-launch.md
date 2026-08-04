# 6. The curve allocation is per launch, and it is a pre-mine

Date: 2026-08-03
Status: Accepted (retires the "no pre-mine" property asserted since #13)

## Context

Until build #34 the curve allocation was the constant `CURVE_SUPPLY = 800M`, and the whole 1B supply reached the market only by being bought.
That made "no pre-mine" a structural fact rather than a promise: the factory minted to itself and had no path that gave a creator tokens.

Settled decision 2 of [`docs/tokenomics.md`](../tokenomics.md#settled-decisions) grants creators a free allocation of 0-5% of the curve supply, vested from graduation.
It was chosen over sharing the curve trade fee because it is worth far more to a creator and costs the protocol no revenue.

## Decision

The dev allocation is **carved out of the curve allocation `C`**, never out of the 200M graduation reserve, and `C` becomes a per-launch value in `[760M, 800M]`.

Carving from the reserve would thin every graduated pool and move the FDV/raise ratio, which depends only on the reserve.
Carving from `C` leaves both untouched, at the cost of making the curve's calibration per launch.

## Consequences

**Both virtual reserves must be re-solved per launch, not just one.**
Price continuity requires `V_tok = C^2 / (C - G)` and the graduation target requires `V_eth = target * G / (C - G)`.
Both depend on `C`.

⚠️ **`V_tok` is the trap, and it is the whole reason this ADR exists.**
It had been a constant for the entire pre-tokenomics build and reads like one, and #34's own ticket scope named only `V_eth`.
Left pinned at its 800M value while a 5% allocation carves `C` to 760M, the graduated pool opens **9.25% above** the curve's closing price and the raise lands at 8.85 ETH against a 10 ETH target: the invariant broken, and an instant arbitrage gift to the first swapper.
`contracts/test/Calibration.t.sol` reconstructs that wrong calibration by hand and asserts it is wrong, so the failure mode cannot quietly return.

**Anything reading progress or concentration must read `C` off the launch.**
`curveTokenAllocation` is already carried by `LaunchCreated`, so no event had to widen.
A consumer that keeps dividing by 800M shows a sold-out carved curve as 95% complete and understates every holder's share.

**The 16x headline is now dev-dependent**, eroding to 14.44x at a 5% allocation. The FDV/raise ratio is untouched, because it depends only on `G`.

**"No pre-mine" is retired, and this is a claim change, not just a code change.**
It was live on the home page and the create page, and both now say "zero protocol allocation", which stays true: the protocol allocation is still zero (decision 5).
The property is reversible without a redeploy by setting `maxDevAllocationBps` to 0.

⚠️ **The allocation is not yet visible to buyers.**
The read model derives holders from curve trades, and a free carve emits no `Bought`, so a creator holding up to 40M tokens currently reads as 0% concentration on the panel that exists to disclose exactly that.
Closed by #36. Recorded in [`subgraph/CONTEXT.md`](../../subgraph/CONTEXT.md).

**The anti-snipe params became shares of a moving denominator.**
Both defaults are documented as shares ("1% of 800M", "15% of 800M"), and a threshold at or above a launch's own `C` is unreachable, leaving the per-wallet cap in force for that curve's whole life.
Clamping to `C` reproduces that state exactly, so #34 rescales both by `C / CURVE_SUPPLY` instead.
⚠️ This moves `maxBuyPerWallet`'s absolute level, which settled decision 6 said would not change. Unresolved, and recorded under [Amendments made during implementation](../tokenomics.md#amendments-made-during-implementation).
