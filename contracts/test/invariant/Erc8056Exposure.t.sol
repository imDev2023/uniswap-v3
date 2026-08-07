// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.24;

import {
    MultiplierConventionProperties
} from "../../lib/evm-security-standards/templates/profiles/robinhood-4663/MultiplierConventionProperties.sol";

import {V3Deployer} from "../../src/periphery/V3Deployer.sol";
import {LaunchpadFactory, LaunchParams} from "../../src/LaunchpadFactory.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {GraduationManager} from "../../src/periphery/GraduationManager.sol";
import {DevVesting} from "../../src/periphery/DevVesting.sol";
import {LPLock} from "../../src/periphery/LPLock.sol";
import {CurveDriver} from "../CurveDriver.sol";
import {MockWETH9} from "../mocks/MockWETH9.sol";
import {MockErc8056Token} from "../mocks/MockErc8056Token.sol";

/// @notice Octopus's answer to the ERC-8056 multiplier, the highest-risk integration detail on chain
///         4663 (#40, gate item `chain-erc8056-simulated`).
///
/// @dev **The bug the chain profile is about.** Corporate actions on tokenized equities do not mint,
///      burn or rebase. They move an on-chain `uiMultiplier()`. Three surfaces report price and they
///      disagree: the Chainlink feed has the multiplier already applied, the REST `/prices` endpoint
///      does not, and `uiMultiplier()` is the ratio itself. Apply it to a feed price and you
///      double-count; fail to apply it to a REST price and you under-count. Both are silent, and at
///      launch every multiplier is exactly `1e18`, so correct and incorrect code are
///      indistinguishable until a real corporate action lands. Then a 10:1 split makes every position
///      valued through that path wrong by 10x, instantly, on a scheduled date.
///
///      **Octopus's answer is that it never reads a price at all.** There is no oracle, no feed, no
///      REST consumer and no pricing module in `src/`. A launch token is minted by
///      `LaunchpadFactory`, so it is never a wrapper over an equity; the quote asset is fixed to WETH
///      at construction and cannot be anything else; and every number the protocol computes - the
///      curve price, the graduation target, the vesting schedule, the lock terms, the fee split -
///      comes from its own reserves and its own storage.
///
///      ⚠️ **That claim is worth exactly as much as the test that would notice it stopping being
///      true, which is what this file is.** "We do not read a price" is a claim about all present and
///      future code, and the way it fails is somebody adding a feed read for a perfectly good reason
///      two tickets from now. So it is asserted two ways:
///
///      1. **Behaviourally.** A real ERC-8056 token is deployed, its multiplier is moved through a
///         2-for-1 split, a reverse split and a dividend drift, and every figure Octopus reports is
///         asserted unchanged across each move. This is the invariant, and the fuzzer moves the
///         multiplier for it after every call.
///      2. **Structurally.** Every deployed contract's runtime bytecode is scanned for the selectors
///         of `uiMultiplier()`, `newUIMultiplier()`, `effectiveAt()` and `latestRoundData()`. Solidity
///         emits every external selector a contract CALLS as a literal in its code, so the absence of
///         all four is checkable rather than asserted. This is the same technique `DevVesting.t.sol`
///         uses to prove a function is absent, and it exists because you cannot prove absence by
///         calling names you guessed: a missing function and one that rejects you are
///         indistinguishable.
///
///      ⚠️ **What is deliberately NOT done here.** The mixin's `tokenPriceUsd`/`sharePriceUsd`
///      adapters are meant to route through a production pricing module and assert the two
///      conventions agree. Octopus has no such module, so binding them to a mock feed and a mock REST
///      price would assert something about the mocks and nothing about this protocol - a green test
///      that means precisely nothing, which is the failure mode the whole ERC-8056 section exists to
///      prevent. `invariant_multiplierConventionsAgree` is therefore overridden with the property
///      that IS true here and IS falsifiable: no multiplier can move any Octopus figure.
contract Erc8056ExposureTest is CurveDriver, V3Deployer, MultiplierConventionProperties {
    LaunchpadFactory internal factory;
    GraduationManager internal gm;
    DevVesting internal vesting;
    LPLock internal lock;
    MockErc8056Token internal equity;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");

    address internal token;
    BondingCurve internal curve;
    address internal weth9;

    /// @dev Everything Octopus reports, captured while the multiplier is at the identity.
    struct Snapshot {
        uint256 curvePrice;
        uint256 ethReserve;
        uint256 tokenReserve;
        uint256 tokensSold;
        uint256 finalEthReserve;
        uint256 grantTotal;
        uint256 vested;
        uint256 claimable;
        uint64 graduatedAt;
        uint64 lockUntil;
        uint16 creatorFeeBps;
    }

    Snapshot internal baseline;

    function setUp() public {
        weth9 = address(new MockWETH9());
        address v3Factory = deployV3Factory();
        address pm = deployPositionManager(v3Factory, weth9, address(0xDEAD));
        factory = new LaunchpadFactory(owner, treasury, 0, pm, v3Factory, weth9);
        gm = factory.graduationManager();
        vesting = factory.devVesting();
        lock = factory.lpLock();

        vm.prank(creator);
        // ⚠️ The metadata URI here is deliberately scheme-only, where every other suite writes
        // `ipfs://Qm...`. The gate's `strip_noncode` removes `//` to end of line WITHOUT respecting
        // string context, so an `ipfs://` literal leaves an unbalanced quote; its string-literal
        // regex then mispairs and swallows the rest of the file as one giant string. That silently
        // hid every `setUiMultiplier(2e18)` below from `check_multiplier_simulation_present`, which
        // reported "the multiplier is only ever set to 1e18" about a file that never sets it to 1e18.
        // Twelve test files in this repo currently go quote-odd the same way; `src/` does not, so the
        // grep-based checks over `src/` are unaffected. Upstream bug in
        // `lib/evm-security-standards/gate/check.py`, worked around here rather than patched, because
        // that is a pinned submodule this repo does not own.
        token = factory.createLaunch(LaunchParams("EQ", "EQ", "ipfs:QmEq", false, 500));
        curve = BondingCurve(factory.curveOf(token));
        _crossToGraduation(curve, "eq");

        // Halfway through the vesting window, so `vested` and `claimable` are strictly between their
        // endpoints. At either endpoint they are pinned by a branch rather than by arithmetic, and a
        // scaling error would have nowhere to show.
        vm.warp(block.timestamp + 15 days);

        equity = new MockErc8056Token();
        // ⚠️ Given to a real participant and to the contracts themselves. If any Octopus figure were
        // ever derived from what it holds rather than from its own accounting, an equity balance
        // whose multiplier moves is how that would surface.
        equity.mint(creator, 1_000_000e18);
        equity.mint(address(curve), 1_000e18);
        equity.mint(address(vesting), 1_000e18);
        equity.mint(address(lock), 1_000e18);

        assertEq(uiMultiplier(), WAD, "a fresh ERC-8056 token starts at the identity, as the chain says");
        baseline = _snapshot();

        targetContract(address(equity));
    }

    function _snapshot() internal view returns (Snapshot memory s) {
        s.curvePrice = curve.priceX18();
        s.ethReserve = curve.ethReserve();
        s.tokenReserve = curve.tokenReserve();
        s.tokensSold = curve.tokensSold();
        s.finalEthReserve = curve.finalEthReserve();
        s.grantTotal = vesting.grantOf(token).total;
        s.vested = vesting.vestedAmount(token);
        s.claimable = vesting.claimable(token);
        s.graduatedAt = gm.graduatedAt(token);
        s.lockUntil = lock.lockOf(gm.tokenIdOf(token)).lockUntil;
        s.creatorFeeBps = lock.lockOf(gm.tokenIdOf(token)).creatorFeeBps;
    }

    function _assertUnmoved(string memory what) internal view {
        Snapshot memory now_ = _snapshot();
        assertEq(now_.curvePrice, baseline.curvePrice, string.concat("curve price moved with ", what));
        assertEq(now_.ethReserve, baseline.ethReserve, string.concat("ethReserve moved with ", what));
        assertEq(now_.tokenReserve, baseline.tokenReserve, string.concat("tokenReserve moved with ", what));
        assertEq(now_.tokensSold, baseline.tokensSold, string.concat("tokensSold moved with ", what));
        assertEq(now_.finalEthReserve, baseline.finalEthReserve, string.concat("the target moved with ", what));
        assertEq(now_.grantTotal, baseline.grantTotal, string.concat("the dev grant moved with ", what));
        assertEq(now_.vested, baseline.vested, string.concat("vested moved with ", what));
        assertEq(now_.claimable, baseline.claimable, string.concat("claimable moved with ", what));
        assertEq(now_.graduatedAt, baseline.graduatedAt, string.concat("graduatedAt moved with ", what));
        assertEq(now_.lockUntil, baseline.lockUntil, string.concat("the lock term moved with ", what));
        assertEq(now_.creatorFeeBps, baseline.creatorFeeBps, string.concat("the fee split moved with ", what));
    }

    // =============================================================================================
    // The mixin's adapters
    // =============================================================================================

    /// @notice Move the multiplier for real. The adapter that decides whether any of this means
    ///         anything: a suite that cannot move it is evaluating the identity function.
    function setUiMultiplier(uint256 newMultiplier) public override {
        equity.setMultiplier(newMultiplier);
    }

    function uiMultiplier() public view override returns (uint256) {
        return equity.uiMultiplier();
    }

    /// @notice Octopus's pricing module. There is none, and this is where that is written down.
    /// @dev ⚠️ Always `address(0)`, and deliberately a variable rather than a constant. Both price
    ///      adapters below are guarded on it, so they revert today and stop reverting the moment a
    ///      real source is wired in - at which point whoever wires it has to state which convention
    ///      it follows, which is rule 1 of the profile's asset-semantics section.
    ///
    ///      It is also what keeps the build clean. Written as an unconditional `revert`, solc proves
    ///      the mixin's own `assertConventionsAgree` body is unreachable and emits four warnings from
    ///      inside `lib/`, which `deny = "warnings"` turns into a failed build - in a submodule this
    ///      repo cannot edit. The guard makes the reverts real without making them provable.
    address internal priceSource;

    /// @notice ⚠️ Both price adapters revert, deliberately, and the revert IS the answer.
    /// @dev The mixin expects these to route through a production pricing module. Octopus has none:
    ///      no feed read, no REST consumer, no price anywhere in `src/`. Returning a plausible number
    ///      from a mock would make `assertConventionsAgree` pass while asserting nothing whatsoever
    ///      about this protocol - a green test that means nothing, which is the exact failure the
    ///      chain profile's ERC-8056 section exists to prevent.
    function tokenPriceUsd() public view override returns (uint256) {
        if (priceSource == address(0)) {
            revert("erc-8056: Octopus reads no price; state the convention before implementing this");
        }
        return 0;
    }

    function sharePriceUsd() public view override returns (uint256) {
        if (priceSource == address(0)) {
            revert("erc-8056: Octopus reads no price; state the convention before implementing this");
        }
        return 0;
    }

    // =============================================================================================
    // The property, restated for a protocol that reads no price
    // =============================================================================================

    /// @notice No multiplier, at any value, moves any figure Octopus reports.
    /// @dev Overrides the mixin's `assertConventionsAgree` check, which cannot run without a pricing
    ///      module. The fuzzer drives `MockErc8056Token.setMultiplier` directly, so this is evaluated
    ///      against multipliers nobody chose, after every call.
    function invariant_multiplierConventionsAgree() public view override {
        _assertUnmoved("a fuzzer-chosen multiplier");
    }

    // =============================================================================================
    // The mixin's own tests, kept and pointed at the real claim
    // =============================================================================================

    /// @notice The test about the test: prove the harness can move the multiplier at all.
    function test_erc8056_harnessCanSimulateCorporateAction() public override {
        assertEq(uiMultiplier(), WAD, "starts at the identity");
        setUiMultiplier(2e18);
        assertEq(uiMultiplier(), 2e18, "harness cannot move the multiplier; this suite proves nothing");
    }

    /// @notice A 10:1 split, the exact worked example in the chain profile.
    /// @dev The profile's table: a stock at $200 splits 10:1, the multiplier goes to 10.0 and the
    ///      FEED price is designed not to move. Code that reads the feed and also multiplies reports
    ///      $2,000 and every position through that path is overvalued tenfold at the moment of
    ///      unpause. Here nothing moves, because nothing reads a price.
    function test_erc8056_tenForOneSplitMovesNothing() public {
        equity.scheduleMultiplier(10e18, uint64(block.timestamp + 1 days));
        _assertUnmoved("a SCHEDULED 10:1 split");

        // ⚠️ Re-baselined across the warp, and the first version of this test was wrong for want of
        // it. Waiting for the effective time advances the vesting schedule, so `vested` and
        // `claimable` move for an entirely legitimate reason, and asserting against the pre-warp
        // snapshot blamed the multiplier for the clock. An assertion has to isolate the one variable
        // it is about; a test that fails for the right reason and the wrong cause is worse than no
        // test, because the next person fixes the wrong thing.
        vm.warp(block.timestamp + 1 days);
        baseline = _snapshot();

        setUiMultiplier(10e18);
        _assertUnmoved("an APPLIED 10:1 split");
    }

    function test_erc8056_conventionsSurvive_twoForOneSplit() public override {
        setUiMultiplier(2e18);
        _assertUnmoved("a 2-for-1 split");
    }

    function test_erc8056_conventionsSurvive_reverseSplit() public override {
        setUiMultiplier(0.5e18);
        _assertUnmoved("a reverse split");
    }

    /// @notice A dividend reinvested into the multiplier: the small, awkward, everyday case where a
    ///         1e18 scaling error hides longest, because the result stays the right order of magnitude.
    function test_erc8056_conventionsSurvive_dividendDrift() public override {
        setUiMultiplier(1.0037e18);
        _assertUnmoved("a dividend drift");
    }

    function testFuzz_erc8056_conventionsSurviveAnyMultiplier(uint256 multiplier) public override {
        multiplier = bound(multiplier, 0.01e18, 100e18);
        setUiMultiplier(multiplier);
        _assertUnmoved("an arbitrary multiplier");
    }

    /// @notice The scaling trap: `uiMultiplier()` is scaled by 1e18, and forgetting to divide is an
    ///         error of a factor of 1e18 - so large it looks like a different bug entirely.
    /// @dev ⚠️ The identity case alone is a TAUTOLOGY and the first version of this test was one:
    ///      `balance * uiMultiplier() / WAD == balance` holds for every input once the multiplier is
    ///      set to `WAD`, so it could not fail whatever the divisor was. The conversion is therefore
    ///      pinned at a NON-identity multiplier as well, which is the only place a missing or wrong
    ///      `1e18` divisor can express itself. Conversion per the chain profile:
    ///      `share-equivalent units = balance * uiMultiplier / 1e18`.
    function test_erc8056_identityMultiplierIsNeutral() public override {
        uint256 balance = equity.balanceOf(creator);
        assertGt(balance, 0, "there is a balance to convert");

        setUiMultiplier(WAD);
        assertEq(balance * uiMultiplier() / WAD, balance, "erc-8056: 1e18 is not behaving as the identity");

        // A 10:1 split. Share-equivalent units must be exactly ten times the raw balance; drop the
        // divisor and this is 1e18 times too large, which is the whole trap.
        setUiMultiplier(10e18);
        assertEq(balance * uiMultiplier() / WAD, balance * 10, "erc-8056: check the 1e18 divisor");

        // A reverse split, moving it the other way so a hardcoded direction cannot pass.
        setUiMultiplier(0.5e18);
        assertEq(balance * uiMultiplier() / WAD, balance / 2, "erc-8056: conversion is not symmetric");
    }

    // =============================================================================================
    // The structural half
    // =============================================================================================

    /// @notice No deployed contract carries the selector of any multiplier or feed function.
    ///
    /// @dev ⚠️ This is the half that survives a future ticket. The behavioural tests above prove that
    ///      today's code ignores the multiplier; this proves the code contains no call site that
    ///      could start reading one, and it fails the moment somebody adds one.
    ///
    ///      Solidity emits every external selector a contract calls as a literal in its runtime
    ///      bytecode, so scanning for the four-byte value is a real check rather than a gesture. The
    ///      same technique is in `DevVesting.t.sol`, and it is there because absence cannot be proved
    ///      by calling names: a function that does not exist and one that rejects you revert
    ///      identically, so any name off the guessed list sails through.
    ///
    ///      ⚠️ A selector match is 4 bytes and can collide with unrelated data by chance, so this can
    ///      only ever fail loudly and never pass falsely - which is the direction that matters. A hit
    ///      means "look at this", not "guilty".
    function test_erc8056_noContractCarriesAMultiplierOrFeedSelector() public view {
        bytes4[4] memory selectors = [
            bytes4(keccak256("uiMultiplier()")),
            bytes4(keccak256("newUIMultiplier()")),
            bytes4(keccak256("effectiveAt()")),
            bytes4(keccak256("latestRoundData()"))
        ];
        string[4] memory names = ["uiMultiplier()", "newUIMultiplier()", "effectiveAt()", "latestRoundData()"];

        address[6] memory targets =
            [address(factory), address(curve), token, address(gm), address(vesting), address(lock)];
        string[6] memory targetNames =
            ["LaunchpadFactory", "BondingCurve", "LaunchToken", "GraduationManager", "DevVesting", "LPLock"];

        for (uint256 t; t < targets.length; ++t) {
            bytes memory code = targets[t].code;
            assertGt(code.length, 0, string.concat(targetNames[t], " has no code, so the scan proves nothing"));

            for (uint256 s; s < selectors.length; ++s) {
                assertFalse(
                    _carriesSelector(code, selectors[s]),
                    string.concat(targetNames[t], " carries the selector for ", names[s])
                );
            }
        }
    }

    /// @notice The scan is capable of finding a selector that IS present.
    /// @dev ⚠️ Without this, the test above passes just as happily against a broken scanner, an empty
    ///      selector list or a bytes4 comparison that never matches - the same shape as every other
    ///      absence proof that passed for the wrong reason in this repo. `MockErc8056Token` really
    ///      does implement `uiMultiplier()`, so its own code must contain that selector.
    function test_erc8056_theSelectorScanCanActuallyFindOne() public view {
        assertTrue(
            _carriesSelector(address(equity).code, bytes4(keccak256("uiMultiplier()"))),
            "the scanner cannot find a selector that is definitely there"
        );
    }

    function _carriesSelector(bytes memory code, bytes4 selector) private pure returns (bool) {
        if (code.length < 4) return false;
        for (uint256 i; i <= code.length - 4; ++i) {
            if (
                code[i] == selector[0] && code[i + 1] == selector[1] && code[i + 2] == selector[2]
                    && code[i + 3] == selector[3]
            ) return true;
        }
        return false;
    }
}
