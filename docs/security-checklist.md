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

## Actors, roles and privileges

The complete enumeration, written for #41's `arch-actors` attestation.
There are **six actors** and **one role**.
Only the first is a role in the access-control sense; the other five are authorised by **identity** - a stored address, checked with a bare `msg.sender` comparison.

`LaunchpadFactory` is the only contract that holds a role of its own: a single owner, via `Ownable2Step`.
The other three contracts hold none - each derives authority by reading `launchpad.owner()` live, which is why there is no second owner to rotate and no way for the two to drift apart.
**Treasury is a destination, not a caller**: no code path authorises anything on the strength of `msg.sender == treasury`.

| Actor | Who it is | Can call | Explicitly cannot |
| --- | --- | --- | --- |
| **Owner** | `Ownable2Step` on `LaunchpadFactory`. ⚠️ On testnet this is still the deployer EOA - see [the open attestations](#the-40-attestations-41) | `setCreationFee`, `setTreasury`, `setCurveParams`, `setLockParams`, `setMaxDevAllocationBps`, `setVestingDuration`, `setProtocolFee`, `setPoolProtocolFee`; `LPLock.setInactivityPeriod` (monotonic); `transferOwnership` / `renounceOwnership` | Touch locked LP principal, a vesting grant, a curve's reserves, or any user's tokens. Change any term of a launch that already exists, with the two exceptions below |
| **Launch creator** | `creatorOf[token]`, frozen at `createLaunch` | `LPLock.extend` (monotonic, own launch only); `DevVesting.claim` is *for* them but is permissionless, since the destination is stored rather than passed | Shorten a lock. Mint, or reach any token beyond their own vested carve. Exempt themselves from the anti-snipe cap (`test_Cap_CreatorHasNoExemption`) |
| **GraduationManager** | A contract `CREATE`d in the factory's constructor | `LPLock.registerLock`, `LaunchpadFactory.applyProtocolFee` | Anything else. Both callees check `msg.sender` against the factory's own record of it |
| **BondingCurve** | One per launch, `CREATE`d by `createLaunch` | `GraduationManager.graduate` **only**, and only for its own token - `GraduationManager.sol:104` checks `msg.sender == launchpad.curveOf(token)` | Anything else. ⚠️ Listed because this is the single call that moves **100% of a launch's raise**; a curve that could call it for another launch's token would be the whole exploit |
| **LaunchpadFactory** | The factory itself, calling into its own constructor-created contracts | `DevVesting.registerGrant` **only** (`DevVesting.sol:148` checks `msg.sender == launchpad`) | Anything else. It is not privileged on `LPLock`: `registerLock` is GraduationManager's, not the factory's |
| **Anyone** | Unauthenticated | `createLaunch`, `buy`, `sell`, `LPLock.collect`, `LPLock.reclaim`, `LaunchpadFactory.collectProtocolFees`, `DevVesting.claim` | Redirect any of it. Every permissionless function has **fixed destinations**: `collect` pays only treasury and the launch creator, `reclaim` burns and pays only treasury, `claim` pays only the stored creator, `collectProtocolFees` pays only treasury. None takes a recipient parameter |

**No address holds unrelated roles.**
The owner and the treasury are separate configurable addresses and nothing requires them to be the same; `GraduationManager`'s authority is a single call each into two contracts; a creator's authority never extends past their own launch.

⚠️ **The two retroactive exceptions**, repeated here because this table is where someone will look for them: `setPoolProtocolFee` changes a live pool's economics with no delay, and `setInactivityPeriod` is read live at reclaim time rather than frozen per position. Both are in [Deliberate omissions](#deliberate-omissions).

### Reentrancy and CEI: the exact scope

🔴 **`cf-nonreentrant` and `cf-cei` are UNANSWERED, not attested.**
Both were attested during #41 with a scope narrower than the item's wording, and the #41 review removed them.
The gate asks for `nonReentrant` "on **every** external state-mutating entry point" and CEI "in **every function without exception**"; neither is literally true here, and an attestation cannot say so - any non-empty string prints `PASS`.
The scope below is what is actually true, and it is recorded here precisely because the gate has no state that can hold it.

`nonReentrant` (OpenZeppelin v5, `uint256 _status`) is on these 7 entry points:

`BondingCurve.buy`, `BondingCurve.sell`, `GraduationManager.graduate`, `LaunchpadFactory.createLaunch`, `LPLock.collect`, `LPLock.reclaim`, `DevVesting.claim`.

It is **not** on the other 17 external state-mutating entry points, enumerated below by grep over `src/` rather than from memory:

| Contract | Functions | Caller | Outbound call? |
| --- | --- | --- | --- |
| `LaunchpadFactory` | `setCreationFee`, `setTreasury`, `setCurveParams`, `setLockParams`, `setMaxDevAllocationBps`, `setVestingDuration`, `setProtocolFee` | owner | no |
| `LaunchpadFactory` (inherited) | `transferOwnership`, `acceptOwnership`, `renounceOwnership` | owner / pending owner | no |
| `LPLock` | `registerLock` | `GraduationManager` only | no |
| `LPLock` | `extend` | launch creator only | no |
| `LPLock` | `setInactivityPeriod` | owner only | no |
| `DevVesting` | `registerGrant` | factory only | no |
| ⚠️ `LaunchpadFactory` | `setPoolProtocolFee` | owner | **yes** - `setFeeProtocol` on a caller-supplied pool |
| ⚠️ `LaunchpadFactory` | `applyProtocolFee` | `GraduationManager` only | **yes** - `setFeeProtocol` on a caller-supplied pool |
| 🔴 `LaunchpadFactory` | `collectProtocolFees` | **permissionless** | **yes** - `collectProtocol`, which **moves value** |

⚠️ **The last three rows are why `cf-nonreentrant` could not honestly be attested**, and the other 14 functions are why it looked as though it could.
Those 14 are all single-caller access-controlled and write only their own storage with no outbound call of any kind.
The final three each call `IUniswapV3Pool` - a contract this protocol does not author - at an address the caller supplies, and `collectProtocolFees` has no access control at all.
None of the three writes storage of its own, so there is nothing for a re-entrant call to corrupt, and `collectProtocol`'s destination is the stored `treasury` rather than a parameter; the V3 pool is also behind its own `lock` modifier.
That is an argument for why the omission is *safe*, not an argument that the item's claim is *true* - which is exactly the distinction the gate cannot record.

⚠️ **The one CEI exception is `BondingCurve.sell`**, which pulls the seller's tokens with `safeTransferFrom` *before* writing reserves.
It is unavoidable - the amount received is what the effects are computed from - and the callee is `LaunchToken`, a factory-minted OpenZeppelin ERC-20 with no transfer hooks, behind `nonReentrant`.
Every other function writes all state before any outbound transfer, and the ordering is mutation-tested in `SameBlockRaces.t.sol`.

⚠️ Adding `nonReentrant` is **not** a free change: #38 put it on `createLaunch`, which meant inheriting `ReentrancyGuard`, whose `_status` occupies a full slot laid out *before* every variable declared in `LaunchpadFactory`.
The packed owner-param group moved from slot 12 to 13.
Re-read `forge inspect <C> storageLayout` after any edit to an inheritance list.

## Testing and quality assurance

SlowMist requires **>95% unit test coverage, 100% on core code**. Measured with `forge coverage --ir-minimum`, `contracts/src/` only:

| Contract | Lines | Statements | Branches | Functions |
| --- | --- | --- | --- | --- |
| `DevVesting` | 100% | 100% | **100%** | 100% |
| `GraduationManager` | 100% | 100% | **100%** | 100% |
| `LaunchToken` | 100% | 100% | **100%** | 100% |
| `LPLock` | 97.80% | 99.19% | **100%** | 92.31% |
| `LaunchpadFactory` | 98.15% | 98.39% | 95.65% | 100% |
| `BondingCurve` | 98.99% | 96.40% | **56.00%** | 100% |

⚠️ **`BondingCurve`'s branch figure is the one number here that does not meet the bar, and it is reported rather than explained away.**
Every remaining uncovered branch is enumerated below with the reason.
Five are a coverage-tool limitation (three constructor `require`s that a rolled-back `CREATE` leaves no trace of, plus both `if (crossing)` sites, whose two sides are each exercised across the suite).
Two are deliberately unreachable safety nets.
**Exactly one is genuinely uncovered**, `BondingCurve.sol:192`, and it is the only one `v-coverage` is waiting on:

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

## The `evm-security` gate (#40)

The [`evm-security-standards`](../contracts/lib/evm-security-standards/) submodule ships a pre-deployment gate.
It went in at 8 blocking failures, which was the honest starting position: nothing waived, no evidence recorded, no invariant suite.
It now reads **`pass 20, fail 0, waived 0`**.

Run it with `cd contracts && python3 lib/evm-security-standards/gate/check.py --project .` and do not trust this table without doing so.

| Item | Closed by |
| --- | --- |
| `ac-invariants-exist` | `AccessControlProperties` in `test/invariant/OctopusInvariants.t.sol`, 14 privileged calls covering both the "no role at all" and the "wrong role" case |
| `cf-conservation-tested` | `ConservationProperties`, 7 ledgers: ETH backing and unsold allocation per curve, the curve's exact reserve bookkeeping, and the vesting vault per launch token |
| `cf-solvency-tested` | `SolvencyProperties` over the vesting vault |
| `arith-rounding-tested` | `RoundingDirectionProperties`, run against a ZERO-FEE curve because a 1% fee per leg hides a rounding-direction bug entirely |
| `chain-erc8056-simulated` | `test/invariant/Erc8056Exposure.t.sol` - see below |
| `q-no-warnings` | `deny = "warnings"` in `foundry.toml`, plus two justified `forge-lint` suppressions |
| `q-slither-clean` | 14 findings at medium-or-above (3 high, 11 medium) triaged inline at each site; 15 low/informational results remain visible |
| `v-invariants-in-ci` | 6 invariants, recorded in `contracts/.evm-standards.json` |

**No waivers.** `waived 0` is a deliberate property of this position, the same way `fail 8` was of the starting one.

⚠️ **`q-slither-clean` and `v-invariants-in-ci` are the two items the gate does NOT verify itself.**
`check_tool_ran_clean` reads a record from `contracts/.evm-standards.json` and never runs the tool, deliberately, so the gate stays fast enough to run locally.
That means a green gate on those two is only ever as honest as the last person to write the record.
#40 briefly recorded `"clean": true` for Slither while Slither actually exited 255 - see the note on `disable-next-line` below.
Re-run both tools rather than trusting the record.

⚠️ **28 of the 40 attestations were answered in #41; 12 remain open.** See [The 40 attestations](#the-40-attestations-41) below. They are **not blocking yet** - the gate lists them every run. Nothing here should be read as "the checklist is complete".

### ERC-8056: the one item where the template did not fit

Chain 4663's profile calls the ERC-8056 multiplier the highest-risk integration detail on the chain, because at launch every multiplier is exactly `1e18`, so pricing code that double-applies it is indistinguishable from correct code until a corporate action lands - and then a 10:1 split makes every position through that path wrong tenfold, instantly, on a scheduled date.

**Octopus reads no price at all.** No oracle, no feed, no REST consumer, no pricing module in `src/`.
Launch tokens are factory-minted so they are never a wrapper over an equity, and the quote asset is fixed to WETH at construction.

The mixin's `tokenPriceUsd`/`sharePriceUsd` adapters therefore have nothing real to bind to.
Binding them to mocks would assert something about the mocks, so they **revert**, and the property is restated as the one that is actually true and actually falsifiable: a real ERC-8056 token is deployed, its multiplier is moved through a scheduled 10:1 split, a 2-for-1, a reverse split, a dividend drift and a fuzzed range, and every figure Octopus reports is asserted unchanged.
That is backed structurally by a runtime-bytecode scan proving no contract carries the selector of `uiMultiplier()`, `newUIMultiplier()`, `effectiveAt()` or `latestRoundData()` - with a companion test proving the scanner can find a selector that IS present.

### Recorded suppressions

Every **code-level** suppression is inline at the site with its reason, never in a triage database.
A suppression a reviewer cannot see next to the code is one nobody re-examines.

⚠️ Three Solhint rules are turned off in `contracts/.solhint.json` instead, and that is a genuine
exception to the rule above rather than an application of it.
Each is systemic rather than site-specific - a chain fact, a pinned compiler, or a style choice made
across every constructor - so 15 identical inline comments would say less than one config line and a
row in this table. They are listed below so the exception is visible where the principle is stated.

⚠️ **`slither-disable-next-line` means the LITERAL next line.** `BondingCurve.buy` carries two
suppressions from two different tools, and #40 shipped both as `-next-line` for several hours: the
Solhint comment block landed between Slither's directive and the function, Slither's suppression
applied to a comment, the High-impact `reentrancy-eth` finding came back, and the evidence recorded in
`.evm-standards.json` said `clean` about a run that exits 255.
The Slither one is now a `disable-start`/`disable-end` block. Two suppressions on one declaration need
a block, not a race for the adjacent line.

| Tool | Rule | Sites | Reason |
| --- | --- | --- | --- |
| forge lint | `block-timestamp` | `LPLock.reclaimBlocker` | On an Orbit chain `block.number` is an L1 estimate and explicitly not a clock, so the lint's implied alternative does not exist. The guard is a 1-year lock plus 180 days of inactivity; a few seconds of sequencer skew reaches neither |
| forge lint | `divide-before-multiply` | `QuoterV2.t.sol` `FullMathLite` | The standard full-precision decomposition. Multiplying first overflows 256 bits for the inputs the caller passes |
| Slither | `arbitrary-send-eth` | `BondingCurve._graduate`, `LaunchpadFactory.createLaunch` | Destinations are an immutable, the owner-set treasury, and `msg.sender`'s own refund. None is an argument |
| Slither | `reentrancy-eth` | `BondingCurve.buy` | `nonReentrant`, and `_graduate` sets `graduated` before its external call. Kept visible because the ordering it points at is exactly what must not be rearranged |
| Slither | `incorrect-equality` | `DevVesting.claim` | `amount == 0` is "nothing has accrued", not a timestamp comparison |
| Slither | `uninitialized-local` | `BondingCurve.buy` `refund` | ⚠️ Suppressed rather than fixed **because the fix moves deployed bytecode** - see below. The same explicit-zero change in `LPLock.collect` was byte-identical and WAS applied |
| Slither | `unused-return` | 6 sites | Destructures of multi-value V3 getters. The `decreaseLiquidity` one is deliberate: what is swept is whatever `collect` returns next, which includes the fee half |
| Solhint | `compiler-version` | config | The shared baseline requires `^0.8.30`; this repo pins `0.8.24` on purpose (`evm_version = paris`, PUSH0-free for Orbit) |
| Solhint | `not-rely-on-time` | config, off | 8 sites, and unsatisfiable on this chain for the same reason as the forge-lint rule above |
| Solhint | `gas-custom-errors` | config, off | 6 constructor-time `require`s. Converting them is a bytecode change and out of a tooling ticket's scope |
| Solhint | `no-inline-assembly`, `const-name-snakecase`, `code-complexity`, `function-max-lines` | 3 sites | Raw `CREATE` over Uniswap's audited artifacts (ADR-0001), forge-std's own `vm` spelling, and `BondingCurve.buy`, which cannot be split without risking the stack overflow that `_emitLaunchCreated` already exists to avoid |

### ⚠️ A comment in `BondingCurve.sol` moves `LaunchpadFactory`'s deployed bytecode

Measured in #40, not assumed.
`LaunchpadFactory` embeds `BondingCurve`'s **creation code**, which carries `BondingCurve`'s own metadata hash, and Solidity hashes the source into that.
So a comment-only edit to `BondingCurve.sol` changes the factory's runtime bytecode while leaving the curve's unchanged.

Verified by byte-diffing the factory's runtime before and after #40: **7 differing regions, all inside the trailing 96 bytes of a 19,423-byte runtime**, i.e. the two embedded metadata hashes. Every executable byte is identical.

Consequences, both real:

- Re-verifying the **currently deployed** testnet contracts on Blockscout needs the source as of `0bfa951`, not this tree. The deployment itself is unaffected; addresses and receipts are in [`deployments-testnet.md`](deployments-testnet.md).
- An explicit-zero initialisation is **not** reliably bytecode-neutral. It was in `LPLock.collect` and was not in `BondingCurve.buy`. Measure per site rather than assuming a rule about the optimizer.

## The 40 attestations (#41)

The gate's other 40 items are **attestations**: claims made in the project's name that the tool records but never verifies.
#41 answered 25 of them and deliberately left 15 open.
The gate now reads **`pass 45, fail 0, unanswered 15, waived 0`**.

⚠️ **Read this before adding one.** `check.py:547` gives each item exactly three states, and **any non-empty string under `attestations` prints `PASS`** - the text is never inspected, only truncated to 100 characters for display.
There is no "no, and here is why" state.
So writing the honest negative answer for an item we do not satisfy turns it **green forever**, which is strictly worse than leaving it unanswered: the gate stops listing it and nobody looks again.
The only honest non-green record is a `waiver`, and `waived 0` is a deliberate property of this position.

The rule #41 adopted, and the one to keep: **attest only when the item's literal claim is true of this codebase, or when the item is vacuous** - and say which, in the attestation text itself.
Nine of the 25 are vacuous (no oracle, no signature scheme, no proxy, no loops, no multicall) and each says so and cites how the absence was *proven* rather than assumed.

⚠️ **#41 broke its own rule three times, and its code review caught it.**
`cf-nonreentrant`, `cf-cei` and `ops-postdeploy` were each answered with a string that *opens by conceding the item is not met* - "⚠️ SCOPED, not universal", "Yes, with ONE stated exception", "⚠️ A RUNBOOK, NOT A SCRIPT".
Each of those printed `PASS`.
They are the same class as `arch-circuit-breaker`, which #41 had already left unanswered for exactly this reason, and they are now unanswered too.
The lesson is that the rule is hardest to follow on the items you are *closest* to satisfying: a 95%-true claim feels attestable in a way a 0%-true claim never does, and the gate renders both identically.

### The 15 still open, and what each is waiting on

| Item | Why it is open | What would close it |
| --- | --- | --- |
| `arch-multisig` | Testnet owner is the deployer EOA | A real Safe. **Mainnet item** (settled decision 12) - a lead-time item on the user's clock |
| `arch-value-cap` | No cap has been decided, and mainnet has never been deployed | A decision on the initial-period cap, before the first mainnet deploy |
| `arch-circuit-breaker` | ❌ **Declined, not missing.** There is no pause and there will not be one - see [Deliberate omissions](#deliberate-omissions) | Nothing. Attesting it would claim a breaker exists. Left unanswered *because* the decision was made, which is the honest encoding of a decline in a schema with no "declined" state |
| `cf-nonreentrant` | ⚠️ **True of 7 entry points, not of "every" one.** Three unguarded functions call `IUniswapV3Pool` at a caller-supplied address and one of them, `collectProtocolFees`, is permissionless and moves value - see [the exact scope](#reentrancy-and-cei-the-exact-scope) | Either a guard on those three, or acceptance that the item's literal claim will never be true here. The safety argument is written out; it is not the same as the claim |
| `cf-cei` | ⚠️ **True of every function except one.** `BondingCurve.sell:277` pulls the seller's tokens before writing reserves, because the amount received is what the effects are computed from | Nothing available. The exception is structural, and the item admits no exceptions. Documented at the site and mutation-tested in `SameBlockRaces.t.sol` |
| `cf-pull-over-push` | ⚠️ **Genuinely not satisfied.** Value is pushed in three of four places: `BondingCurve._sendEth` for the trade fee, the crossing-buy refund and sell proceeds; `LPLock._payOut` and `reclaim` push ERC-20s to treasury and creator. Only `DevVesting.claim` is pull. The sharpest consequence: a treasury that rejects ETH would revert **every buy and sell on every curve** | A decision. Either accept it (the pushed destinations are all protocol-controlled or the caller itself) or add a withdrawal ledger. Not a documentation gap |
| `oracle-slippage` | ⚠️ **Partially, and the gap is deadlines.** `buy(minTokensOut)` and `sell(_, minEthOut)` both have real user-supplied bounds, pinned by `SlippageBuy`/`SlippageSell`. But **no function anywhere takes a deadline** - `GraduationManager.sol:149` and `LPLock.sol:379` both pass `deadline: block.timestamp`, which is the canonical no-op, and both pass `amount0Min: 0, amount1Min: 0` | A decision on deadlines for `buy`/`sell`. The two zero-slippage mints are separately justified at their sites (graduation is calibrated; reclaim burns rather than sells) but the deadlines are not |
| `q-dead-code` | One unused declaration: `Constants.USDG`. **Measured, not assumed**: deleting it changes `GraduationManager`'s deployed bytecode and `LaunchpadFactory`'s with it (`LPLock` and `DevVesting` are untouched - they do not import `Constants`), by the metadata-hash mechanism above | Removing it, in a ticket that is *allowed* to move deployed bytecode. #41 is not one, and neither was #40 |
| `v-coverage` | `BondingCurve` branch coverage is **56%** - reported in full under [Testing and quality assurance](#testing-and-quality-assurance) with every uncovered branch enumerated. Lines are 98-100% everywhere; branches are not | Covering the crossing-buy clamp at `BondingCurve.sol:192`, the one genuinely-uncovered branch. The rest are tool limitations or unreachable safety nets |
| `v-audit` | No external audit yet | The audit. **It comes last**, after the project is complete and self-tested |
| `v-bounty` | No bug bounty | Blocked behind hosting. ⚠️ No longer blocked behind key protection, which closed in the code on 2026-08-10 - see [RPC key protection](#rpc-key-protection) |
| `ops-postdeploy` | ⚠️ **A runbook, not a script.** `docs/deploy.md` steps 4-7 are the post-deployment verification and were executed end to end on 2026-08-06 (#38), with the step-3 calibration values pinned against the contract by `test/Calibration.t.sol`. But the item asks for a *script*, and nothing runs these checks unattended | Automating steps 4-7. Same gap as `ops-monitoring`, and blocked behind nothing but the work |
| `ops-runbook` | No incident-response runbook and no drill. `docs/deploy.md` is a *deploy* runbook and `subgraph/README.md` has reorg-deadlock recovery, but neither is incident response for the contracts | Writing one. ⚠️ Constrained by there being no pause: the honest runbook is mostly communication, since a live exploit cannot be contained on-chain |
| `ops-monitoring` | `scripts/indexer-health.mjs` exists and **nothing runs it** | Wiring it to something that alerts. Stage 4 |
| `ops-contact` | No published security contact | A published address, which needs hosting or at least a repository `SECURITY.md` |

Four of these - `cf-pull-over-push`, `oracle-slippage`, `q-dead-code` and `v-coverage` - were **not** on the list of expected gaps when #41 started.
They came out of reading the source against each item rather than against the plan.
`oracle-slippage` in particular sits in the oracle section and would have been swept up with "we read no price oracle"; it is not about oracles.

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

- ⚠️ **RPC key protection: closed in the code, still open at the host.** See [RPC key protection](#rpc-key-protection) below for what now holds and what does not.
- **No monitoring is wired.** `scripts/indexer-health.mjs` exists; nothing runs it.
- **No frontend hosting, so no HSTS, CSP, SRI or security headers** are configured yet.
  All of SlowMist's frontend-hardening section is unaddressed and will be when hosting is chosen.
- **No incident-response process, no drills, no published contact.**

⚠️ These are genuine gaps, not deferrals-in-name-only.
They are listed here so the audit conversation covers the deployment surface and not only the bytecode.

### RPC key protection

Two separate leaks came from one cause, and both were measured on this repo's own build rather than reasoned about.

**The cause.** Vite inlines every `VITE_*` value into the emitted JavaScript.
`VITE_RPC_URL` therefore is not configuration, it is publication.
A production build made on 2026-08-10 contained the Alchemy URL and its 32-character key as a plaintext literal in `dist/assets/index-*.js`.

**Leak 1, the bundle.** Anyone opening the site could read the key and spend it anywhere.

**Leak 2, the wallet, which is worse and was not the one being tracked.**
wagmi's injected connector builds its `wallet_addEthereumChain` request as `rpcUrls = [chain.rpcUrls.default.http[0]]`, and that first entry was `VITE_RPC_URL`.
So MetaMask did not merely *display* the key, which is what build #38 observed.
It **stored** it as that visitor's endpoint for the network, after which the visitor's own wallet traffic ran through our key for as long as the network entry survived.
That is a per-visitor recurring cost, invisible from our side, and it survives rotating the bundle.

**What now holds, in code:**

| Mechanism | Where | What it guarantees |
| --- | --- | --- |
| The credential lives in `RPC_UPSTREAM_URL`, with no `VITE_` prefix | `frontend/vite.config.ts` | Vite cannot inline it. The prefix is the whole boundary, so removing it is the fix. |
| The app calls a same-origin path, `VITE_RPC_PROXY_PATH` | `frontend/src/config/chain.ts` | The browser learns an origin it was already talking to, and nothing else. An absolute URL is also accepted, for a proxy on a separate origin; that case is not same-origin and needs CORS headers on the proxy. |
| The chain object offers the wallet the **public** endpoint only | `frontend/src/config/chain.ts`, `walletRpcUrlsFor` | Closes leak 2 outright, independent of hosting. Four tests in `chain.test.ts` fail if the two lists are ever unified again. |
| The build **fails** on a credential-shaped URL in the output | `frontend/build/bundleCredentialGuard.ts` | The protection cannot be silently undone by a `.env.local` copied from another machine. It runs in `generateBundle`, so a leaking build writes no `dist` at all. |

**What does not hold, and is honest to state:**

- A proxy is **not** a boundary against use, only against theft.
  It is open to anyone who can reach the site, so the exposure moves from "the key can be spent anywhere" to "our origin can be used as an RPC".
  Only the second is fixable after the fact, which is why it is the better position, not a solved problem.
- **Production still has no `/rpc`.** Vite serves that path in `dev` and in `preview`; a deployed static host does not.
  Until hosting is chosen and the path is served, a production build must either run on the public endpoint or accept a bundled, domain-allowlisted key via `ALLOW_BUNDLED_RPC_CREDENTIAL=1`.
  That flag downgrades the build failure to a warning and never silences it, because a provider-side allowlist is something this build cannot verify.
- **A domain allowlist is Referer-based** and a non-browser client can set any Referer it likes.
  It reduces casual abuse. It is not authentication.

**The detection rule** is shape-based rather than a list of providers, because a provider list is out of date the first time somebody tries a provider nobody added to it, and its failure mode is silence.
A URL is credential-shaped when a path segment is at least 20 characters of mixed letters and digits, or a query parameter named like a credential carries a value at least 12 characters of the same shape.
Measured against this project's real production output - a 792 kB emitted bundle plus `index.html`, transformed from 4,788 modules including viem and wagmi: zero false positives.
⚠️ The corpus is what Rollup **emits**, not what it reads, because the guard runs in `generateBundle`.
Anything tree-shaken away was never scanned and says nothing about the rule.
`findCredentials` redacts at the point of detection, so a build error cannot publish the key it caught to a terminal or to CI logs.
