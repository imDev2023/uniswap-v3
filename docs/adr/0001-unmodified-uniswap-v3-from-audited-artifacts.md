# Deploy unmodified Uniswap V3 from the audited artifacts

Octopus needs a permanent home for graduated liquidity, and writing or forking an AMM would put the riskiest code in the system inside our own audit scope.
Instead we deploy Uniswap V3 **byte-for-byte from the published audited artifacts** via `vm.getCode`, so we run our own instance - we own the factory and the fee switch - without owning the AMM's correctness.

## Consequences

- **There is no AMM source in this repo, and that is deliberate.** A reader looking for pool or swap logic will not find it. Do not add it.
- Our audit scope is the *seam*: the atomic curve-to-pool handoff, the refund arithmetic on a crossing buy, and curve rounding. Everything below that seam is covered by upstream's audits, and only stays covered while the bytecode is identical.
- **Upstream names carry licence obligations and must not be renamed.** Dependency names, `IUniswapV3*` interfaces, artifact paths and `GPL-2.0-or-later` headers identify someone else's software. Product surfaces may be rebranded freely; these may not.
- The claim "byte-identical to mainnet" is checkable rather than asserted - deployed bytecode hashes match across chains.
