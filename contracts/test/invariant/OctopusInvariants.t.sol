// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ConservationProperties} from "../../lib/evm-security-standards/templates/properties/Conservation.sol";
import {SolvencyProperties} from "../../lib/evm-security-standards/templates/properties/Solvency.sol";
import {AccessControlProperties} from "../../lib/evm-security-standards/templates/properties/AccessControl.sol";
import {RoundingDirectionProperties} from "../../lib/evm-security-standards/templates/properties/RoundingDirection.sol";

import {V3Deployer} from "../../src/periphery/V3Deployer.sol";
import {LaunchpadFactory, LaunchParams} from "../../src/LaunchpadFactory.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {GraduationManager} from "../../src/periphery/GraduationManager.sol";
import {DevVesting, VestingGrant} from "../../src/periphery/DevVesting.sol";
import {LPLock, LockOrigin} from "../../src/periphery/LPLock.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CurveDriver} from "../CurveDriver.sol";
import {MockWETH9} from "../mocks/MockWETH9.sol";
import {OctopusHandler} from "./OctopusHandler.sol";

/// @notice Octopus's stateful invariant campaign (#40, gate items `ac-invariants-exist`,
///         `cf-conservation-tested`, `cf-solvency-tested`, `arith-rounding-tested` and
///         `v-invariants-in-ci`).
///
/// @dev ⚠️ **This is not a second copy of `Invariants.t.sol`, and the difference is the whole point.**
///      That file holds nine `testFuzz_` properties, each of which builds its own world, makes a
///      handful of calls in an order the test author chose, and asserts once at the end. This one
///      hands the fuzzer a handler, lets it choose the order, and re-checks every property after
///      every single call. The two find different bugs: the first finds bad arithmetic at an awkward
///      input, the second finds state that drifts after a sequence nobody thought to write down.
///
///      **The world the campaign runs in.** Three launches, because one cannot carry the properties
///      that matter:
///
///      - `GRAD` graduates during `setUp`, so its vesting schedule is RUNNING. Without it every
///        `claimable` is zero for the whole campaign and the solvency property is green and empty.
///      - `FEE` stays on the curve at the default 1% trade fee, and carries the trading, the
///        donations and the ETH-backing ledgers.
///      - `FREE` sits on a curve created after `setCurveParams(..., 0, ...)`, so its trade fee is
///        ZERO. The rounding property runs there and nowhere else - see `OctopusHandler`.
///
///      **What this campaign does NOT cover**, stated so a green run is not read as more than it is:
///      the V3 pool itself, `LPLock.collect` and `LPLock.reclaim`, and the anti-snipe cap, which
///      `setUp` lifts on purpose. Graduation as a transition belongs to `Graduation.t.sol`, the cap to
///      `AntiSnipe.t.sol`, the lock to `LpLock.t.sol` and `LockReclaim.t.sol`.
///
///      ⚠️ Every property here has been SEEN RED against a deliberately broken state - the
///      `test_*Fires*` block at the bottom. A property suite that has never failed is not evidence of
///      anything, and #39 shipped three tests that passed for the wrong reason in a single ticket.
contract OctopusInvariantsTest is
    CurveDriver,
    V3Deployer,
    ConservationProperties,
    SolvencyProperties,
    AccessControlProperties,
    RoundingDirectionProperties
{
    LaunchpadFactory internal factory;
    GraduationManager internal gm;
    DevVesting internal vesting;
    LPLock internal lock;
    OctopusHandler internal handler;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal gradCreator = makeAddr("gradCreator");
    address internal feeCreator = makeAddr("feeCreator");
    address internal freeCreator = makeAddr("freeCreator");
    /// @dev Holds no role of any kind: the "no role at all" half of the access-control list.
    address internal stranger = makeAddr("stranger");

    address internal gradToken;
    address internal feeToken;
    address internal freeToken;
    BondingCurve internal feeCurve;
    BondingCurve internal freeCurve;
    address internal weth9;

    /// @dev ⚠️ **The only suite here that does NOT fork, and the reason is measured.** The first
    ///      version forked mainnet like every other suite. It never completed a run: Foundry gives
    ///      each `invariant_` function its own campaign, each campaign re-runs `setUp` against the
    ///      fork, and every address the fuzzer touches outside the local cache is an RPC call. The
    ///      archive endpoint returned HTTP 429 and all five campaigns died in setup with `runs: 0`.
    ///      `ForkConfig`'s rule still stands for every example-based suite; see `MockWETH9` for why
    ///      this shape is the exception. The V3 stack is still the real audited bytecode either way.
    function setUp() public {
        weth9 = address(new MockWETH9());
        address v3Factory = deployV3Factory();
        address pm = deployPositionManager(v3Factory, weth9, address(0xDEAD));
        factory = new LaunchpadFactory(owner, treasury, 0, pm, v3Factory, weth9);
        gm = factory.graduationManager();
        vesting = factory.devVesting();
        lock = factory.lpLock();

        BondingCurve gradCurve;
        (gradToken, gradCurve) = _launch(gradCreator, "GRAD", 500);
        _crossToGraduation(gradCurve, "grad");

        (feeToken, feeCurve) = _launch(feeCreator, "FEE", 250);
        _liftAntiSnipe(feeCurve, "fee");

        // ⚠️ The other three parameters are READ FIRST and passed back unchanged. `setCurveParams`
        // takes all four, so writing literals here would silently retune the whole calibration while
        // pretending to change only the fee. The reads are also hoisted above `vm.prank` on purpose:
        // the prank applies to the NEXT call, and a getter in the argument list IS that next call.
        // Both traps are written down in CLAUDE.md and both have been walked into anyway.
        uint256 vEth = factory.virtualEthReserve();
        uint256 maxBuy = factory.maxBuyPerWallet();
        uint256 threshold = factory.antiSnipeThreshold();
        vm.prank(owner);
        factory.setCurveParams(vEth, 0, maxBuy, threshold);

        (freeToken, freeCurve) = _launch(freeCreator, "FREE", 100);
        assertEq(freeCurve.tradeFeeBps(), 0, "the rounding curve really does charge no fee");
        _liftAntiSnipe(freeCurve, "free");

        handler = new OctopusHandler(feeCurve, freeCurve, vesting, gradToken);
        targetContract(address(handler));
    }

    function _launch(address creator, string memory sym, uint16 devBps)
        internal
        returns (address token, BondingCurve curve)
    {
        vm.prank(creator);
        token = factory.createLaunch(LaunchParams(sym, sym, "ipfs://QmInv", false, devBps));
        curve = BondingCurve(factory.curveOf(token));
    }

    // =============================================================================================
    // Actors
    // =============================================================================================

    /// @notice The handler's actors, plus the graduated launch's creator.
    /// @dev ⚠️ `gradCreator` is appended for the solvency sweep and is deliberately NOT one of the
    ///      handler's actors. The handler claims vesting as somebody who can never be the payee, so a
    ///      `claim` mutated to pay `msg.sender` shows up as tokens leaving the vault for an address
    ///      nothing is owed to. Put the creator in the handler's set and that mutation would move
    ///      tokens to an address the sweep already accounts for, and every property would stay green.
    ///
    ///      Five in total, and that is a budget rather than a preference: this set is swept after
    ///      EVERY call in the campaign, and the rounding property probes every actor at every amount,
    ///      so its size multiplies straight into runtime.
    function actors() public view override returns (address[] memory who) {
        address[] memory base = handler.actors();
        who = new address[](base.length + 1);
        for (uint256 i; i < base.length; ++i) {
            who[i] = base[i];
        }
        who[base.length] = gradCreator;
    }

    // =============================================================================================
    // Conservation
    // =============================================================================================

    /// @notice What each contract holds against what it has promised.
    /// @dev ⚠️ The `exact` flag is load-bearing and both directions are mistakes. An exact check on a
    ///      balance anyone can donate into is a false alarm waiting for its first donor; an inexact
    ///      check on internal bookkeeping silently permits drift. `OctopusHandler` donates both assets
    ///      for real, so the choice is tested rather than reasoned about.
    function conservationLedgers() public view override returns (Ledger[] memory ledgers) {
        ledgers = new Ledger[](7);

        ledgers[0] = Ledger({
            name: "FEE curve: real ETH owed to sellers",
            accounted: _curveEthLiability(feeCurve),
            held: address(feeCurve).balance,
            exact: false
        });
        ledgers[1] = Ledger({
            name: "FREE curve: real ETH owed to sellers",
            accounted: _curveEthLiability(freeCurve),
            held: address(freeCurve).balance,
            exact: false
        });

        ledgers[2] = Ledger({
            name: "FEE curve: unsold allocation",
            accounted: feeCurve.curveTokenAllocation() - feeCurve.tokensSold(),
            held: IERC20(feeToken).balanceOf(address(feeCurve)),
            exact: false
        });
        ledgers[3] = Ledger({
            name: "FREE curve: unsold allocation",
            accounted: freeCurve.curveTokenAllocation() - freeCurve.tokensSold(),
            held: IERC20(freeToken).balanceOf(address(freeCurve)),
            exact: false
        });

        // ⚠️ The only EXACT ledger, because both sides are the curve's own state and nothing outside
        // can move either. `tokenReserve + tokensSold == virtualTokenReserve` is the identity every
        // buy and every sell preserves by construction: a buy moves exactly `tokensOut` from one to
        // the other and a sell moves it back. It is what `tokensSold` drift breaks first, and unlike
        // the balance ledgers above no donation can mask it.
        ledgers[4] = Ledger({
            name: "FEE curve: reserve bookkeeping",
            accounted: feeCurve.virtualTokenReserve(),
            held: feeCurve.tokenReserve() + feeCurve.tokensSold(),
            exact: true
        });

        // ⚠️ One ledger PER LAUNCH TOKEN, never one for the vault. `DevVesting` custodies every
        // creator's allocation across every launch in a single contract, so an aggregate ledger would
        // let one launch's surplus mask another's shortfall - which is precisely the cross-launch
        // drainage the contract claims is unrepresentable rather than merely guarded. Per token, a
        // claim on GRAD paid out of FEE's balance fires here.
        ledgers[5] = Ledger({
            name: "vesting vault: GRAD tokens still owed",
            accounted: _grantOutstanding(gradToken),
            held: IERC20(gradToken).balanceOf(address(vesting)),
            exact: false
        });
        ledgers[6] = Ledger({
            name: "vesting vault: FEE tokens still owed",
            accounted: _grantOutstanding(feeToken),
            held: IERC20(feeToken).balanceOf(address(vesting)),
            exact: false
        });
    }

    /// @dev ⚠️ A GRADUATED curve owes nothing. It handed 100% of the calibrated raise to the
    ///      GraduationManager and every entry point reverts afterwards, so `ethReserve` becomes a
    ///      frozen historical record rather than a liability. Reading it as one would fire on every
    ///      graduated curve forever - a false alarm about the single most important transition here.
    function _curveEthLiability(BondingCurve curve) internal view returns (uint256) {
        if (curve.graduated()) return 0;
        return curve.ethReserve() - curve.virtualEthReserve();
    }

    function _grantOutstanding(address token) internal view returns (uint256) {
        VestingGrant memory g = vesting.grantOf(token);
        return g.total - g.claimed;
    }

    // =============================================================================================
    // Solvency
    // =============================================================================================

    /// @notice What the vesting vault could actually pay out on the graduated launch right now.
    ///
    /// @dev ⚠️ **This reads `balanceOf`, which is the opposite of what the mixin's documentation
    ///      advises, and the deviation is deliberate.** That advice exists because a donated balance
    ///      can make an insolvent protocol look solvent, so capacity should come from internal
    ///      accounting. `DevVesting` has no internal accounting of what it HOLDS - only of what it has
    ///      promised, `total - claimed`. Using that as capacity makes the property a tautology:
    ///      `claimable` is `vested - claimed`, `vested` is clamped to `total`, so
    ///      `claimable <= total - claimed` holds by construction and the check can never fail. Proved
    ///      by trying it: `test_solvencyFiresWhenTheScheduleOutrunsThePot` could not be made to fire
    ///      against that adapter at all, which is how a vacuous property announces itself.
    ///
    ///      The donation risk the advice guards against is also inverted here. A donation of the
    ///      launch token into this vault genuinely does increase what it can pay, because every payout
    ///      is a plain `safeTransfer` of that token - so counting it is honest rather than flattering.
    ///
    ///      ⚠️ **Honest about its strength:** this is a WEAKER statement than the vault's conservation
    ///      ledger, which requires holdings to cover the whole outstanding grant rather than just the
    ///      vested part, and therefore fires earlier. It is here because it is the user-visible
    ///      question - would the claim a creator can make today actually go through - and because it
    ///      is what the actor sweep is shaped around. The two are kept because they fail at different
    ///      moments, not because either implies the other is redundant.
    ///
    ///      ⚠️ Scoped to ONE launch token rather than summed over all three. Solvency sums
    ///      `claimableBy` across the actor set, and adding three different launch tokens into one
    ///      figure would let one launch's surplus cover another's shortfall - exactly the cross-launch
    ///      masking the per-asset conservation ledgers exist to make impossible.
    function solvencyCapacity() public view override returns (uint256) {
        return IERC20(gradToken).balanceOf(address(vesting));
    }

    /// @notice What this actor could claim from the vault right now.
    /// @dev Only GRAD's creator can ever be owed anything: `claim` pays `grant.creator`, frozen at
    ///      creation, and the handler's actors are not it. That asymmetry is the test.
    function claimableBy(address actor) public view override returns (uint256) {
        if (actor != gradCreator) return 0;
        return vesting.claimable(gradToken);
    }

    // =============================================================================================
    // Rounding direction
    // =============================================================================================

    /// @dev Set by `test_roundingFiresWhenATripReturnsMoreThanItCost` only, to prove the assertion
    ///      itself works. False for the campaign and for every other test.
    bool internal _forceProfitableRoundTrip;

    /// @notice Buy with `amount` wei and immediately sell the whole position back.
    /// @dev ⚠️ Runs against the ZERO-FEE curve, and that is the difference between a real test and a
    ///      decorative one. On the fee-charging curve a 1% fee per leg dwarfs any rounding error and
    ///      the trip is unprofitable whichever way the maths rounds, so the property would pass
    ///      against a curve that IS a money pump. #35a verified exactly that: mutating
    ///      `_previewSell`'s `Math.ceilDiv` to a floor survived the fee-charging round trip and died
    ///      only at a zero fee.
    function roundTrip(address actor, uint256 amount) public override returns (uint256 returned) {
        if (_forceProfitableRoundTrip) return amount + 1;

        uint256 startingBalance = actor.balance;
        vm.deal(actor, startingBalance + amount);

        vm.startPrank(actor);
        uint256 tokensOut = freeCurve.buy{value: amount}(0);
        IERC20(freeToken).approve(address(freeCurve), tokensOut);
        freeCurve.sell(tokensOut, 0);
        vm.stopPrank();

        return actor.balance - startingBalance;
    }

    /// @notice Fewer probes than the mixin's default, chosen for this curve's units.
    /// @dev The sweep is actors x amounts and it runs after EVERY call in the campaign, so each extra
    ///      amount multiplies total runtime. These five keep the awkward small values, where
    ///      truncation leaves a non-zero remainder and a rounding DIRECTION error can express itself,
    ///      and drop the round ones that say nothing the others do not. Below the curve's dust level
    ///      `buy` returns zero tokens and reverts; the mixin skips a reverting probe rather than
    ///      counting it, which is correct - "this trade is not currently possible" is not a violation.
    function roundTripProbeAmounts() public pure override returns (uint256[] memory amounts) {
        amounts = new uint256[](5);
        amounts[0] = 1;
        amounts[1] = 3;
        amounts[2] = 1e14 + 1;
        amounts[3] = 1e15 - 1;
        amounts[4] = uint256(3e15) / 7; // a deliberately non-terminating ratio
    }

    // =============================================================================================
    // Access control
    // =============================================================================================

    /// @notice Every privileged call, paired with a caller that must be rejected.
    ///
    /// @dev ⚠️ **`abi.encodeCall` throughout, never `abi.encodeWithSignature`, and that is a
    ///      correctness requirement rather than a style preference.** This property asserts a raw
    ///      `.call` FAILS. A call to a function that does not exist also fails, so a mistyped
    ///      signature passes vacuously and proves nothing - the same trap that let `LpLock.t.sol`'s
    ///      bare `vm.expectRevert()` "prove" an attacker could not withdraw principal for six builds
    ///      while it was actually catching a selector mismatch. `abi.encodeCall` is type-checked
    ///      against the real function, so a rename or a signature change breaks the build instead of
    ///      quietly hollowing out the test.
    ///
    ///      ⚠️ The second defence is `invariant_privilegedCallsSucceedForTheRightCaller` below. A
    ///      function that reverts for EVERYONE - bricked by a bad guard, or deleted in a merge -
    ///      satisfies this property perfectly. Only the positive control tells the two apart.
    ///
    ///      Both the "no role at all" and the "wrong role" cases are listed, because they are
    ///      different bugs and the second is the one that survives review. `owner` reaching for
    ///      `applyProtocolFee` is not a stranger probing a fence; it is the most privileged address in
    ///      the system calling a function reserved to the GraduationManager.
    function privilegedCalls() public view override returns (PrivilegedCall[] memory calls) {
        calls = new PrivilegedCall[](14);

        // --- the owner surface, probed by an address holding no role at all ---
        calls[0] = PrivilegedCall({
            name: "factory.setCreationFee",
            target: address(factory),
            callData: abi.encodeCall(LaunchpadFactory.setCreationFee, (1 ether)),
            caller: stranger
        });
        calls[1] = PrivilegedCall({
            name: "factory.setTreasury",
            target: address(factory),
            callData: abi.encodeCall(LaunchpadFactory.setTreasury, (stranger)),
            caller: stranger
        });
        calls[2] = PrivilegedCall({
            name: "factory.setCurveParams",
            target: address(factory),
            callData: abi.encodeCall(LaunchpadFactory.setCurveParams, (1 ether, uint16(100), 1e18, 1e18)),
            caller: stranger
        });
        calls[3] = PrivilegedCall({
            name: "factory.setLockParams",
            target: address(factory),
            callData: abi.encodeCall(LaunchpadFactory.setLockParams, (uint64(365 days), uint16(7000))),
            caller: stranger
        });
        calls[4] = PrivilegedCall({
            name: "factory.setMaxDevAllocationBps",
            target: address(factory),
            callData: abi.encodeCall(LaunchpadFactory.setMaxDevAllocationBps, (uint16(0))),
            caller: stranger
        });
        calls[5] = PrivilegedCall({
            name: "factory.setVestingDuration",
            target: address(factory),
            callData: abi.encodeCall(LaunchpadFactory.setVestingDuration, (uint64(60 days))),
            caller: stranger
        });
        calls[6] = PrivilegedCall({
            name: "factory.setProtocolFee",
            target: address(factory),
            callData: abi.encodeCall(LaunchpadFactory.setProtocolFee, (uint8(4))),
            caller: stranger
        });
        // ⚠️ The one unmitigated privileged power in the protocol: retroactive on a live pool, no
        // delay and no notice (docs/security-checklist.md#deliberate-omissions). If any guard here
        // deserves re-checking after every call in a campaign, it is this one.
        calls[7] = PrivilegedCall({
            name: "factory.setPoolProtocolFee",
            target: address(factory),
            callData: abi.encodeCall(LaunchpadFactory.setPoolProtocolFee, (address(0xBEEF), uint8(4))),
            caller: stranger
        });

        // --- role-gated rather than owner-gated: the WRONG-ROLE cases ---
        calls[8] = PrivilegedCall({
            name: "factory.applyProtocolFee (as owner, not the GraduationManager)",
            target: address(factory),
            callData: abi.encodeCall(LaunchpadFactory.applyProtocolFee, (address(0xBEEF))),
            caller: owner
        });
        calls[9] = PrivilegedCall({
            name: "lpLock.registerLock (as owner, not the GraduationManager)",
            target: address(lock),
            callData: abi.encodeCall(
                LPLock.registerLock, (uint256(1), feeToken, address(0xBEEF), uint64(block.timestamp + 1), uint16(7000))
            ),
            caller: owner
        });
        // The owner has no power whatsoever over a creator's lock, which is what makes the one-year
        // claim mean anything to a trader. Probed AS the owner for exactly that reason.
        //
        // ⚠️ The tokenId is READ from the graduated launch, never the literal `1`. `extend` checks
        // `origin == None -> UnknownLock` BEFORE it checks the caller, so an unregistered id reverts
        // for the wrong reason and the probe passes having proved nothing - the repo's "a revert never
        // tells you WHY" trap, in the one entry here where the ordering allows it. `registerLock`,
        // `registerGrant` and `graduate` all check the caller first, so their ids can be arbitrary.
        // `invariant_extendProbeTargetsARealLock` below asserts this id is genuinely registered.
        calls[10] = PrivilegedCall({
            name: "lpLock.extend (as owner, not the launch creator)",
            target: address(lock),
            callData: abi.encodeCall(LPLock.extend, (gm.tokenIdOf(gradToken), type(uint64).max - 1)),
            caller: owner
        });
        calls[11] = PrivilegedCall({
            name: "lpLock.setInactivityPeriod (as treasury, which holds no role)",
            target: address(lock),
            callData: abi.encodeCall(LPLock.setInactivityPeriod, (uint32(365 days))),
            caller: treasury
        });
        calls[12] = PrivilegedCall({
            name: "devVesting.registerGrant (as owner, not the launchpad)",
            target: address(vesting),
            callData: abi.encodeCall(DevVesting.registerGrant, (feeToken, stranger, 1e18, uint64(30 days))),
            caller: owner
        });
        // Graduation is callable only by the launch's OWN curve. `feeCurve` is a real curve in this
        // system, so this is the sharpest wrong-role case available: a legitimate participant calling
        // a legitimate function about somebody else's launch.
        calls[13] = PrivilegedCall({
            name: "graduationManager.graduate (as another launch's curve)",
            target: address(gm),
            callData: abi.encodeCall(GraduationManager.graduate, (freeToken)),
            caller: address(feeCurve)
        });
    }

    /// @notice The `extend` probe points at a lock that really exists and really has a creator.
    /// @dev ⚠️ Without this the probe is vacuous in a way no failure would reveal: `extend` rejects an
    ///      unregistered tokenId before it ever looks at the caller, so `invariant_accessControl`
    ///      would stay green while proving nothing about who may extend a lock.
    function invariant_extendProbeTargetsARealLock() public view {
        uint256 tokenId = gm.tokenIdOf(gradToken);
        assertGt(tokenId, 0, "the graduated launch has a position");
        assertTrue(lock.lockOf(tokenId).origin == LockOrigin.Launch, "and it is a REGISTERED launch lock");
        assertEq(factory.creatorOf(gradToken), gradCreator, "whose creator is somebody other than the owner");
    }

    /// @notice The positive control: every guarded call still WORKS for the caller that owns it.
    /// @dev ⚠️ Without this, `invariant_accessControl` is satisfied by a function that reverts for
    ///      everybody. A clamp that bricks the product, a guard reading the wrong address, a function
    ///      dropped in a merge - each makes the negative property greener rather than redder. This
    ///      repo already carries the scar as a rule: a revert-only test does not prove a bound is safe.
    ///
    ///      Only the owner surface is asserted positively. The role-gated calls above would need a
    ///      GraduationManager mid-graduation or a real locked position to succeed, and standing one up
    ///      would mean asserting something about the stand-in.
    function invariant_privilegedCallsSucceedForTheRightCaller() public {
        uint256 snapshot = vm.snapshotState();

        uint256 vEth = factory.DEFAULT_VIRTUAL_ETH_RESERVE();
        uint256 maxBuy = factory.DEFAULT_MAX_BUY_PER_WALLET();
        uint256 threshold = factory.DEFAULT_ANTI_SNIPE_THRESHOLD();

        vm.startPrank(owner);
        factory.setCreationFee(0.01 ether);
        factory.setTreasury(treasury);
        factory.setCurveParams(vEth, 100, maxBuy, threshold);
        factory.setLockParams(365 days, 7000);
        factory.setMaxDevAllocationBps(500);
        factory.setVestingDuration(30 days);
        factory.setProtocolFee(4);
        vm.stopPrank();

        assertEq(factory.creationFee(), 0.01 ether, "the owner surface is guarded, not bricked");

        vm.revertToState(snapshot);
    }

    // =============================================================================================
    // Campaign coverage
    // =============================================================================================

    /// @notice Prove the campaign did something before believing it was green.
    /// @dev ⚠️ The templates put this first for a reason, and it is not hypothetical here: `buy`
    ///      returns early on a graduated curve, `sell` and `donateTokens` return early for an actor
    ///      holding nothing, and a campaign that never managed a single buy would satisfy all four
    ///      property mixins perfectly.
    ///
    ///      `afterInvariant` runs once at the end of each run, which is where a call-count assertion
    ///      belongs. Asserting it as an invariant would fail on the first call of every campaign.
    function afterInvariant() public view {
        // ⚠️ Skip judgement on a shrunk replay. See `OctopusHandler.totalCalls` - after any failure
        // here Foundry re-evaluates these assertions against a minimal sequence, where all of them
        // are false, and reports only the first. Without this guard every failure in this function
        // reads as "the fuzzer never reached some handler function", whatever actually went wrong.
        if (handler.totalCalls() < 32) return;

        assertGe(handler.distinctCallsMade(), 5, "the fuzzer never reached some handler function");
        assertGt(handler.callCount("advanceTime"), 0, "the clock never moved, so no schedule was tested");

        // ⚠️ Call counts alone prove nothing, because every handler function swallows its own revert
        // and returns quietly. A run where all 64 calls landed on a rejected buy would still report
        // six healthy-looking selectors. This ghost is what says money actually moved.
        assertGt(handler.ghostEthIn(), 0, "no ETH ever entered a curve, so the run was empty");

        // ⚠️ **Everything asserted here has to hold on EVERY RUN, not across the campaign**, and that
        // is a much narrower licence than it looks. `afterInvariant` fires once per run, and Foundry
        // resets state between runs, so a per-run assertion about a path the fuzzer only reaches
        // sometimes is a flaky test rather than a strict one. `ghostEthOut > 0` was here and had to
        // come out: a single run is roughly ten sell calls, a sell needs the chosen actor to already
        // hold the chosen curve's token, and a run where none of the ten line up is ordinary rather
        // than broken. `test_handlerExercisesEveryPath` covers that deterministically instead.
        //
        // ⚠️ Diagnosing a failure here is also harder than it looks, and worth knowing before trying.
        // When `afterInvariant` fails, Foundry replays a shrunk sequence and reports THOSE counters,
        // so a genuine "the sell path never ran" failure surfaces as "the fuzzer never reached some
        // handler function: 1 < 5" - a different assertion, about a one-call sequence that was never
        // the problem. Read a failure here as "some coverage assertion failed", then reproduce with a
        // fixed sequence rather than trusting the numbers in the report.
    }

    // =============================================================================================
    // Proof that each property actually fires
    // =============================================================================================
    //
    // ⚠️ These live in the same contract as the campaign on purpose. Foundry re-runs `setUp` for each
    // `test_`, so they get a fresh world and cannot contaminate the campaign; splitting them into a
    // derived contract would make Foundry run the whole campaign a second time there. They use the
    // SAME adapters the campaign uses, so an adapter mistake that makes a property vacuous - a ledger
    // reading the same value on both sides, an empty actor set, a mistyped privileged call - shows up
    // here as a test that fails to fail.

    /// @notice Conservation catches a vault that no longer holds what it owes.
    function test_conservationFiresWhenTheVaultIsShort() public {
        VestingGrant memory g = vesting.grantOf(gradToken);
        assertGt(g.total, 0, "GRAD really does carry a grant to be short of");

        // One wei out of the vault, with the grant untouched: the books now promise a wei more than
        // the vault holds. The smallest possible violation, which is the one a loose check misses.
        vm.prank(address(vesting));
        assertTrue(IERC20(gradToken).transfer(stranger, 1), "the wei actually left the vault");

        _expectPropertyFailure(
            abi.encodeCall(this.invariant_conservation, ()), "holdings do not cover claims for 'vesting vault: GRAD"
        );
    }

    /// @notice Conservation TOLERATES a donation, which is the other half of getting `exact` right.
    /// @dev Without this, `exact: false` everywhere would read as caution rather than a decision. A
    ///      ledger wrongly marked exact fails this test, which is what makes the flag load-bearing.
    function test_conservationToleratesDonationsIntoACurve() public {
        deal(feeToken, stranger, 1_000e18, true);
        vm.prank(stranger);
        assertTrue(IERC20(feeToken).transfer(address(feeCurve), 1_000e18), "the donation actually landed");
        vm.deal(address(feeCurve), address(feeCurve).balance + 5 ether);

        this.invariant_conservation();
    }

    /// @notice The one EXACT ledger catches bookkeeping drift that no donation can mask.
    /// @dev `tokenReserve + tokensSold == virtualTokenReserve` cannot be broken through any public
    ///      function, which is exactly why an inexact ledger would never notice if it started to
    ///      drift. Broken here by writing the raw slot.
    function test_exactLedgerFiresWhenReserveBookkeepingDrifts() public {
        uint256 before = feeCurve.tokensSold();
        assertGt(before, 0, "the curve has actually sold something");

        uint256 slot = _findSlotHolding(address(feeCurve), before);
        vm.store(address(feeCurve), bytes32(slot), bytes32(before + 1));
        assertEq(feeCurve.tokensSold(), before + 1, "the write landed on tokensSold, not a lookalike slot");

        _expectPropertyFailure(
            abi.encodeCall(this.invariant_conservation, ()),
            "internal bookkeeping drifted for 'FEE curve: reserve bookkeeping'"
        );
    }

    /// @notice Solvency catches a vault that cannot honour the claim a creator could make today.
    /// @dev Warped past the end of the window first, so the whole grant is claimable and capacity and
    ///      claims are exactly equal. One wei out of the vault then tips it - the smallest possible
    ///      violation, which is the one a loose check misses.
    ///
    ///      ⚠️ This test is why `solvencyCapacity` reads `balanceOf`. Against the obvious adapter,
    ///      `total - claimed`, it could not be made to fire at all: `claimable` is `vested - claimed`
    ///      and `vested` is clamped to `total`, so the property held by construction whatever was done
    ///      to the state. A property that cannot fail is not a property, and the only thing that
    ///      revealed it was insisting on seeing this test red.
    function test_solvencyFiresWhenTheVaultCannotHonourAClaim() public {
        vm.warp(block.timestamp + 400 days);
        uint256 claimable = vesting.claimable(gradToken);
        assertGt(claimable, 0, "GRAD really does have something claimable");
        assertEq(claimable, solvencyCapacity(), "fully vested and nothing claimed: capacity == claims");

        vm.prank(address(vesting));
        assertTrue(IERC20(gradToken).transfer(stranger, 1), "the wei actually left the vault");

        _expectPropertyFailure(
            abi.encodeCall(this.invariant_solvency, ()), "total claimable exceeds what the protocol can pay"
        );
    }

    /// @notice Access control catches a guard that has stopped guarding.
    /// @dev ⚠️ **`LaunchpadFactory` is `Ownable2Step`, not `Ownable`**, and this test found that out
    ///      by failing. The first version called `transferOwnership` alone and the property stayed
    ///      green - correctly, because a pending owner holds no power at all until they accept, so
    ///      nothing had actually stopped guarding. A fire test that cannot make the property fire is
    ///      indistinguishable from a property that does not work, which is the entire reason these
    ///      tests exist. The handshake is completed here.
    function test_accessControlFiresWhenAGuardStopsGuarding() public {
        vm.prank(owner);
        factory.transferOwnership(stranger);
        assertEq(factory.owner(), owner, "Ownable2Step: transfer alone changes nothing");

        vm.prank(stranger);
        factory.acceptOwnership();
        assertEq(factory.owner(), stranger, "the stranger now really does hold the owner role");

        _expectPropertyFailure(
            abi.encodeCall(this.invariant_accessControl, ()), "unauthorised caller reached 'factory.setCreationFee'"
        );
    }

    /// @notice The positive control catches the opposite failure: a surface nobody can use.
    /// @dev Renouncing ownership leaves every `onlyOwner` function callable by nobody.
    ///      `invariant_accessControl` is greener than ever, and the product is dead.
    function test_positiveControlFiresWhenTheOwnerSurfaceIsBricked() public {
        vm.prank(owner);
        factory.renounceOwnership();

        this.invariant_accessControl(); // still green, which is the whole point

        // Pinned to the exact error, never a bare `vm.expectRevert()`. The positive control makes
        // seven owner-only calls and a bare expectation would be satisfied by any of them failing for
        // any reason - a renamed getter, a bad snapshot, an unrelated assertion. After
        // `renounceOwnership` the owner is the zero address, so the FIRST call reverts with
        // `OwnableUnauthorizedAccount(owner)`, and that is what must be seen.
        // ⚠️ Matched on the ENCODED custom error, not on its name. A custom error's returndata is a
        // 4-byte selector plus ABI-encoded arguments - the string "OwnableUnauthorizedAccount" appears
        // nowhere in it, so a substring search for the name finds nothing and the test fails claiming
        // the property fired for the wrong reason. Caught by running it.
        _expectPropertyFailureWith(
            abi.encodeCall(this.invariant_privilegedCallsSucceedForTheRightCaller, ()),
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner)
        );
    }

    /// @notice Every handler path does real work, driven through a FIXED sequence.
    ///
    /// @dev ⚠️ This is the campaign's coverage check, and it lives here rather than in
    ///      `afterInvariant` because coverage is a property of the campaign and `afterInvariant` can
    ///      only speak for one run. It replays 96 calls spread evenly across the six handler
    ///      functions and then asserts that each one moved something: ETH in, ETH back out, tokens
    ///      donated, wei force-fed.
    ///
    ///      ⚠️ The seeds are derived INDEPENDENTLY per parameter, and the first version of this got
    ///      that wrong in a way worth recording. Deriving `which`, the actor and the amount from one
    ///      value made `which = s % 6` and `actor = s % 4` share a parity, so buys could only ever use
    ///      the even actors and sells only the odd ones. Every sell then found an empty wallet and the
    ///      harness reported a defect the handler did not have. A test harness is code, and a
    ///      correlation between two of its "random" choices is a bug in the test, not a finding.
    function test_handlerExercisesEveryPath() public {
        for (uint256 i; i < 96; ++i) {
            uint256 which = uint256(keccak256(abi.encode(i, "which"))) % 6;
            uint256 a = uint256(keccak256(abi.encode(i, "actor")));
            uint256 c = uint256(keccak256(abi.encode(i, "curve")));
            uint256 v = uint256(keccak256(abi.encode(i, "value")));

            if (which == 0) handler.buy(a, c, v);
            else if (which == 1) handler.sell(a, c, v);
            else if (which == 2) handler.donateTokens(a, c, v);
            else if (which == 3) handler.forceEth(c, v);
            else if (which == 4) handler.advanceTime(v);
            else handler.claimVesting(a);
        }

        assertEq(handler.distinctCallsMade(), 6, "a handler function never ran at all");
        assertGt(handler.ghostEthIn(), 0, "the buy path never moved any ETH in");
        assertGt(handler.ghostSellProceeds(), 0, "the sell path never moved any ETH back out");
        assertGt(handler.ghostTokensDonated(), 0, "nothing was ever donated, so `exact: false` went untested");
        assertGt(handler.ghostEthForced(), 0, "no ETH was ever force-fed past a curve's accounting");

        // Every property still holds at the end of a sequence chosen by nobody in particular.
        this.invariant_conservation();
        this.invariant_solvency();
        this.invariant_accessControl();
    }

    /// @notice The rounding probes actually TRADE, rather than all bouncing off the dust floor.
    /// @dev ⚠️ The sharpest way for this property to be green and empty. `invariant_roundingDirection`
    ///      skips any probe that reverts - correctly, since "this trade is not currently possible" is
    ///      not a violation - so a probe list entirely below the curve's dust floor would pass 4,096
    ///      times having executed no trades at all. The campaign cannot report this itself: every
    ///      probe runs inside a snapshot that is rolled back, so a counter written during one does not
    ///      survive. Asserted here instead, directly against the same amounts the campaign uses.
    function test_roundingProbesActuallyExecuteTrades() public {
        uint256[] memory amounts = roundTripProbeAmounts();
        address actor = actors()[0];

        uint256 traded;
        for (uint256 i; i < amounts.length; ++i) {
            uint256 snapshot = vm.snapshotState();
            try this.roundTripExternal(actor, amounts[i]) returns (uint256 returned) {
                if (returned > 0) ++traded;
                assertLe(returned, amounts[i], "a probe that DID trade must still not profit");
            } catch {}
            vm.revertToState(snapshot);
        }

        assertGt(traded, 0, "every rounding probe was skipped: the property proved nothing");
    }

    /// @notice Rounding catches a round trip that returns more than it cost.
    /// @dev The curve cannot be turned into a money pump from outside, so the profit is injected into
    ///      `roundTrip` itself. That checks the property's assertion rather than the curve, which is
    ///      the honest limit of a state-based fire test and the reason `Invariants.t.sol` keeps the
    ///      real `ceilDiv`-to-floor mutation test alongside this file.
    function test_roundingFiresWhenATripReturnsMoreThanItCost() public {
        _forceProfitableRoundTrip = true;

        _expectPropertyFailure(
            abi.encodeCall(this.invariant_roundingDirection, ()),
            "a deposit-withdraw round trip returned more than it cost"
        );
    }

    // --- helpers -------------------------------------------------------------------------------

    /// @notice Assert a property call reverts AND that it reverted for the stated reason.
    /// @dev ⚠️ A bare `vm.expectRevert()` is banned in this repo, and a property test is where the ban
    ///      pays off: every one of these properties can revert for a reason that has nothing to do
    ///      with the defect being injected - an arithmetic underflow in an adapter, a missing grant, a
    ///      view reverting on a graduated curve. Matching on the message is what makes the test about
    ///      the property rather than about "something went wrong". Substring rather than exact bytes,
    ///      because forge-std wraps assertion messages differently across versions and pinning the
    ///      wrapper would make this fail on an upgrade that changed nothing.
    function _expectPropertyFailure(bytes memory call, string memory needle) internal {
        (bool ok, bytes memory reason) = address(this).call(call);
        assertFalse(ok, "the property did not fire at all");
        assertTrue(_contains(reason, bytes(needle)), string.concat("the property fired, but not for: ", needle));
    }

    /// @notice The same, pinned to raw revert BYTES rather than to a message.
    /// @dev For a custom error, whose returndata contains no human-readable text at all.
    function _expectPropertyFailureWith(bytes memory call, bytes memory expected) internal {
        (bool ok, bytes memory reason) = address(this).call(call);
        assertFalse(ok, "the property did not fire at all");
        assertTrue(_contains(reason, expected), "the property fired, but not with the expected error");
    }

    function _contains(bytes memory haystack, bytes memory needle) private pure returns (bool) {
        if (needle.length == 0 || haystack.length < needle.length) return false;
        for (uint256 i; i <= haystack.length - needle.length; ++i) {
            bool hit = true;
            for (uint256 j; j < needle.length; ++j) {
                if (haystack[i + j] != needle[j]) {
                    hit = false;
                    break;
                }
            }
            if (hit) return true;
        }
        return false;
    }

    /// @dev Find the storage slot currently holding `value`, searching the low slots. Written this way
    ///      rather than with a hardcoded index because #38's whole lesson was that a storage index
    ///      moves for reasons that do not look like storage changes - adding a modifier moved the
    ///      factory's packed owner-param group from slot 12 to 13. The caller asserts the write landed
    ///      where it meant to, which is what catches a lookalike slot holding the same number.
    function _findSlotHolding(address target, uint256 value) private view returns (uint256) {
        for (uint256 i; i < 32; ++i) {
            if (uint256(vm.load(target, bytes32(i))) == value) return i;
        }
        revert("no low slot holds that value");
    }
}
