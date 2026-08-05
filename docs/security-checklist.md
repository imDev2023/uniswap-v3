# Security checklist

Every requirement from the four documents in [`web3-security.md`](../web3-security.md), mapped to where Octopus satisfies it or why it deliberately does not.

Sources:
[SlowMist Web3 Project Security Practice Requirements](https://github.com/slowmist/Web3-Project-Security-Practice-Requirements),
[Alchemy smart contract security best practices](https://www.alchemy.com/overviews/smart-contract-security-best-practices),
[Consensys Diligence smart contract best practices](https://consensysdiligence.github.io/smart-contract-best-practices/),
[WTF gas optimization](https://github.com/WTFAcademy/WTF-gas-optimization).

Written in build #35a, 2026-08-04.
⚠️ This is a **living document and a statement of intent, not a certificate**.
It records what we checked and what we chose; it is not a substitute for the audit, and nothing here should be read as a claim that the contracts are free of defects.

**Scope**: the five contracts in `contracts/src/` that we wrote.
The AMM itself is unmodified Uniswap V3 deployed byte-for-byte from audited artifacts ([ADR-0001](adr/0001-unmodified-uniswap-v3-from-audited-artifacts.md)) and is explicitly out of scope.

---

## Known attack classes (Consensys)

| Class | Status | Where |
| --- | --- | --- |
| Reentrancy | ⚠️ **Partially.** `nonReentrant` plus CEI ordering on the value-moving external functions listed at right. Two exceptions, both deliberate: `createLaunch` (its own row below) and `collectProtocolFees`, which is permissionless and unguarded but can only ever send a pool's accrued fees to `treasury`, a stored address the caller cannot influence | `buy`, `sell`, `graduate`, `collect`, `reclaim`, `claim` |
| Reentrancy - `createLaunch` | ⚠️ **Deliberately unguarded.** It refunds via `.call`, but CEI holds and re-entry only buys another launch at the same fee. Judged gas for no threat, and recorded as an open decision in `CLAUDE.md` rather than settled | `LaunchpadFactory.createLaunch` |
| Oracle manipulation | ✅ No price oracle is consulted for any economic decision. The one oracle read is the pool's observation ring, used **only** as a liveness signal for `reclaim`, never as a price | `LPLock.secondsSincePoolActivity` |
| Front-running | ⚠️ Partially. Slippage bounds (`minTokensOut`, `minEthOut`) protect traders. The anti-snipe cap raises the cost of opening-block accumulation but does not prevent it: a determined sniper uses 15 wallets. **Adversarial MEV is untested and unscoped** | `BondingCurve` |
| Timestamp dependence | ✅ Used only for durations measured in months (1-year lock, 180-day inactivity, 30-day vesting). A validator's ~15s of influence is ~7 orders of magnitude below the shortest window | `LPLock`, `DevVesting` |
| Insecure arithmetic | ✅ Solidity 0.8 checked arithmetic everywhere except two `unchecked` blocks, each with a written proof of why it cannot overflow | `LaunchpadFactory._solveCalibration`, `LPLock.secondsSincePoolActivity` |
| Denial of service | ✅ No unbounded loops over user-controlled arrays. `launches` grows without bound but is only ever indexed, never iterated on-chain | |
| Griefing | ✅ `reclaim` is gated on measured pool inactivity, not a calendar, so it cannot be aimed at a live pool | [ADR-0005](adr/0005-the-lp-lock-is-conditional-not-permanent.md) |
| Force-feeding ether | ✅ Graduation seeds the `GRADUATION_RESERVE` **constant**, never `balanceOf`, so ETH or tokens force-fed into the manager cannot skew the pool's opening price | `GraduationManager.graduate` |
| `tx.origin` auth | ✅ Never used. Verified by grep across all of `src/` | |
| `delegatecall` / `selfdestruct` | ✅ Neither appears anywhere in `src/` | |
| Signature replay | ✅ N/A - no signature-based authorisation exists | |

## Development recommendations

| Requirement | Status |
| --- | --- |
| Build on well-known libraries (SlowMist) | ✅ OpenZeppelin for `Ownable2Step`, `ERC20`, `SafeERC20`, `ReentrancyGuard`, `Math` |
| Solidity 0.8+ for overflow protection | ✅ `0.8.24` |
| **Lock the pragma** (Consensys) | ✅ **Fixed in #35a** for everything that ships. Was `^0.8.24` floating across 13 files; now `0.8.24` exact in all of `src/` and `script/`, verified by grep returning zero `pragma solidity ^` in either tree. `foundry.toml` already pinned `solc`. The pre-existing files in `contracts/test/` still float, deliberately: nothing there is deployed, and both files #35a added are pinned |
| Explicit visibility on everything | ✅ |
| Check return values on external calls | ✅ All three `.call{value:}` sites check `ok` and revert with a custom error. All token moves go through `SafeERC20` |
| Checks-Effects-Interactions | ✅ Explicit in `reclaim` (`r.reclaimed = true` before any external call), `claim`, `createLaunch` |
| Custom errors over require-strings | ✅ In all new code. Six `require` strings remain: four in `BondingCurve`'s constructor, one in `V3Deployer` and one in `GraduationManager.sol:87`, all deployment-time invariants that can never fire in production |
| Events on every key parameter change | ⚠️ **Partially.** All 8 owner setters emit, and `setInactivityPeriod` emits old→new. But three emit only the NEW value, so the previous setting has to be reconstructed from an earlier log: `setCurveParams` (`LaunchpadFactory.sol:599`), `setLockParams` (`:615`) and `setPoolProtocolFee` (`:674`). Not a security hole, but it weakens after-the-fact monitoring of a privileged change and an auditor will ask |
| Multiply before divide | ✅ Throughout the calibration solve; each value truncates exactly once |
| Avoid excessive storage loops | ✅ None |
| Zero-address validation | ⚠️ **Partially.** Every constructor and every setter that STORES an address validates it. The two that take a `pool` address and only pass it straight to an external call do not: `setPoolProtocolFee` and `collectProtocolFees`. Both revert anyway on any address without a V3 pool's code, so a zero or wrong address wastes gas rather than causing harm |
| Setting `treasury` to a contract that rejects ETH | ⚠️ **A live operational risk, not theoretical.** `setTreasury` accepts any non-zero address, including one with no `receive`, and that bricks `createLaunch` for everyone because the creation fee can no longer be forwarded. Owner-only and recoverable by setting a payable treasury, so it is a footgun rather than a vulnerability. Pinned by `test_CreateLaunch_RevertsWhenTreasuryRejectsEth`, which reached the branch for the first time in #35a |
| Deflationary / rebasing / ERC-777 token risk | ✅ N/A - the only tokens handled are `LaunchToken` (a plain fixed-supply OZ ERC20 we deploy) and WETH9 |
| Linear inheritance | ✅ Shallow and linear; no diamond patterns |

## Access control and privileged roles

| Requirement | Status |
| --- | --- |
| Avoid excessive authority concentration (SlowMist) | ⚠️ **Partially.** Ownership transfers to a Safe multisig via `Ownable2Step`, which satisfies SlowMist's "multi-signature" option. The `SAFE` address is still a lead-time item, not yet a real multisig |
| Timelock on key parameters | ❌ **Deliberately not built**, decided 2026-08-04. See [Deliberate omissions](#deliberate-omissions) |
| Least privilege | ✅ The owner can tune future-launch parameters and flip the pool fee switch. It **cannot** touch locked LP principal, vesting grants, curve reserves, or any user's tokens |
| Every privileged change is future-only | ✅ Every curve, lock and vesting parameter is frozen per launch at `createLaunch`, so no in-flight launch changes under a trader. Two exceptions, both documented: `setPoolProtocolFee` and `setInactivityPeriod` |
| Retroactive levers minimised | ⚠️ Two remain. `setInactivityPeriod` is **monotonic (lengthen-only)** so it can only move in a creator's favour. `setPoolProtocolFee` is genuinely retroactive on a live pool and is the residual risk we accept |

## Testing and quality assurance

SlowMist requires **>95% unit test coverage, 100% on core code**. Measured with `forge coverage --ir-minimum`, `contracts/src/` only:

| Contract | Lines | Statements | Branches | Functions |
| --- | --- | --- | --- | --- |
| `DevVesting` | 100% | 100% | **100%** | 100% |
| `GraduationManager` | 100% | 100% | **100%** | 100% |
| `LaunchToken` | 100% | 100% | **100%** | 100% |
| `LPLock` | 97.80% | 99.19% | **100%** | 92.31% |
| `LaunchpadFactory` | 98.08% | 98.35% | 95.65% | 100% |
| `BondingCurve` | 98.99% | 96.40% | **56.00%** | 100% |

⚠️ **`BondingCurve`'s branch figure is the one number here that does not meet the bar, and it is reported rather than explained away.**
Every remaining uncovered branch is enumerated below with the reason. Three are a coverage-tool limitation, two are deliberately unreachable safety nets, and three are genuinely uncovered:

| Line | Branch | Why uncovered |
| --- | --- | --- |
| 123, 124, 125 | Constructor `require`s: bad reserves, bad fee, bad cap | **All three ARE tested** (`SecurityHardening.t.sol::test_BondingCurve_ConstructorInvariants`, including the value just inside each bound). A reverting `CREATE` is rolled back and leaves no runtime trace for `forge coverage` to attribute, which is consistent with the tool's known behaviour |
| 202 | `NoTokensOut` | **Unreachable at the current calibration.** Open price is ~3.125e-9 ETH per whole token against 18 decimals, so even a 1-wei buy yields ~3e8 token-wei. Kept because `virtualEthReserve` is owner-tunable and a large enough retune would make it reachable. Documented by a passing test that asserts the dust buy succeeds |
| 203 | `CurveSoldOut` | **Unreachable by construction** - the source comment says so. A defensive net behind the allocation check above it |
| 183, 235 | `if (crossing)` | Both sides are exercised across the suite (every graduation test takes the true path, every ordinary buy the false one). Reported uncovered under `--ir-minimum`; not chased further |
| 192 | The crossing-buy clamp `grossNeeded > msg.value` | ⚠️ **Genuinely uncovered.** It only binds when the fee floor and the ceil gross-up fail to compose to the wei on an exactly-sized crossing buy. Known gap |

**Fuzz testing.**
Alchemy names Foundry fuzzing explicitly.
`contracts/test/Invariants.t.sol` adds 9 properties at 256 runs each (~2,300 randomised executions per run of the suite), covering curve value conservation, solvency, supply tracking, the calibration solve, and the vesting schedule across arbitrary claim splits.
Note the sampling: the dev-allocation property draws from the 501 legal values of `devBps` but only samples ~256 of them per run, so it is a random walk over that range rather than exhaustive coverage of it.

**Mutation testing.** Assertions are verified by deliberately breaking the source and confirming the tests go red. Results from #35 and #35a:

| Mutant | Caught by |
| --- | --- |
| Vesting runs from creation, not graduation | 2 tests |
| `claim` pays `msg.sender` instead of the frozen creator | 1 test |
| Vesting ramp doubled | 5 tests |
| Vesting accounting reads `balanceOf` | 2 tests |
| A real `sweepToken` added to the vault | 1 test (bytecode scan) |
| `claimable` forgets prior claims | fuzz, in **2 runs**, with a counterexample |
| Curve overpays the seller | 2 fuzz properties + 1 example test |
| Sell rounding flipped `ceilDiv` → floor | ⚠️ **Not caught, and the reason is recorded**: the buy side's rounding already dominates, so the round trip stays unprofitable. The mutant is not actually a money pump. `testFuzz_ZeroFeeRoundTrip_StillCannotProfit` exists to remove the fee as a confound |

⚠️ **Regression testing before release** (SlowMist) is satisfied by four suites run on every ticket: `forge test`, `frontend npm test`, `subgraph npm test`, and `tsc -b` + `vite build`.

## Gas optimisation (WTF)

Applied, with measurements where they were taken in #35a:

| Technique | Status |
| --- | --- |
| Constant and immutable | ✅ Every fixed value is `constant`; every deploy-time value is `immutable` |
| Storage slot packing | ✅ **Improved in #35a.** `tradeFeeBps` sat alone between two `uint256`s wasting 30 bytes. Moved beside the four other small owner params: all five now share slot 12 (22 of 32 bytes). **Measured: -1,983 gas per `createLaunch`, -16,895 per factory deployment**, at a cost of +29/+46 on `setCurveParams` for the mask-and-shift |
| Custom errors | ✅ |
| Calldata over memory | ✅ `LaunchParams` is a calldata struct |
| Prefix increment | ✅ No `i++` anywhere |
| Local variables over storage | ✅ `createLaunch` reads each storage slot once into one `CurveConfig` |
| Unchecked arithmetic where provably safe | ✅ Two sites, both with written proofs |
| Avoid default initialisation | ✅ |
| Mapping over array | ✅ All lookups are mappings |

⚠️ **Not applied, deliberately**: bitmaps, clone factories, selector ordering, `bytes32` for short strings.
Each trades material readability for gas on paths that are not hot, and `CLAUDE.md`'s governing preference is quality and long-term maintainability over cost.
The optimizer runs at 200.

---

## Deliberate omissions

Recorded so they are decisions rather than gaps.
Each was considered and declined with reasons.

### No emergency pause

SlowMist: *"Reserve the switch for an emergency suspension of the global and core business."*

**Declined 2026-08-04.** Octopus sells the guarantee that nobody, including us, can stop a curve trading or freeze a graduation.
A pause switch is a privileged function on the hottest path in the protocol and would make that guarantee conditional on our restraint.

The accepted cost is real and stated plainly: **a live exploit cannot be contained.**
The only mitigations available are `setCurveParams`, which affects future launches only, and off-chain communication.
We judged a permanent centralization vector worse than an unlikely containment gap, on a protocol whose entire value proposition is that the rules cannot be changed under you.

### No timelock

SlowMist: *"Use governance, timelock contracts, or multi-signature mechanisms."*

**Declined 2026-08-04**, in favour of the multisig option, which the same requirement offers.
A timelock would be a further contract inside the audit scope, and it was already considered and declined once for `setInactivityPeriod` because that setter is monotonic and can only move in a creator's favour.

⚠️ **The residual risk is `setPoolProtocolFee`**, which changes the economics of a pool people are already trading, with no delay and no notice.
It is capped at 25% of swap fees and cannot touch principal.
This is the sharpest privileged power in the protocol and it is not mitigated beyond the multisig.

### Three price sources

SlowMist recommends a minimum of three price sources.
**N/A**: no price feed is consulted for any economic decision.
Curve pricing is a closed-form function of the curve's own immutable reserves.

### Chainlink VRF

**N/A**: no randomness is used anywhere.

---

## Operational security

Out of scope for the contracts, tracked in `CLAUDE.md`'s Stage 4 list.
The open items that SlowMist calls out and we have **not** done:

- 🔴 **The RPC key ships verbatim in the browser bundle.** Domain allowlisting or a proxy is required before any public deploy.
- **No monitoring is wired.** `scripts/indexer-health.mjs` exists; nothing runs it.
- **No frontend hosting, so no HSTS, CSP, SRI or security headers** are configured yet.
  All of SlowMist's frontend-hardening section is unaddressed and will be when hosting is chosen.
- **No incident-response process, no drills, no published contact.**

⚠️ These are genuine gaps, not deferrals-in-name-only.
They are listed here so the audit conversation covers the deployment surface and not only the bytecode.
