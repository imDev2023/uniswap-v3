// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CurveDriver} from "./CurveDriver.sol";
import {V3Deployer} from "../src/periphery/V3Deployer.sol";
import {LaunchpadFactory, LaunchParams} from "../src/LaunchpadFactory.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {GraduationManager} from "../src/periphery/GraduationManager.sol";
import {DevVesting, VestingGrant} from "../src/periphery/DevVesting.sol";
import {Constants} from "../src/Constants.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ForkConfig} from "./ForkConfig.sol";

/// @notice Build #35: the dev allocation's vesting vault.
///
/// @dev The property that governs the whole design is that the schedule starts at GRADUATION and
///      never at creation. Most launches never graduate, and a schedule running from creation would
///      let the creator of a dying curve claim tokens and sell them straight back into the curve,
///      taking the ETH other buyers put in. `test_VestingStartsAtGraduation_NotAtCreation` is the
///      test that would fail if that ever regressed, and it is deliberately written so that a
///      from-creation implementation passes every OTHER test in this file.
contract DevVestingTest is Test, V3Deployer, CurveDriver {
    LaunchpadFactory internal factory;
    GraduationManager internal gm;
    DevVesting internal vesting;
    address internal positionManager;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");
    address internal whale = makeAddr("whale");
    address internal stranger = makeAddr("stranger");

    uint16 internal constant MAX_DEV = 500; // 5%, the ceiling
    uint256 internal constant MAX_DEV_TOKENS = 40_000_000e18; // 5% of the 800M curve supply

    function setUp() public {
        vm.createSelectFork(ForkConfig.MAINNET, ForkConfig.MAINNET_BLOCK);
        address v3Factory = deployV3Factory();
        positionManager = deployPositionManager(v3Factory, Constants.WETH9, address(0xDEAD));
        factory = new LaunchpadFactory(owner, treasury, 0, positionManager, v3Factory, Constants.WETH9);
        gm = factory.graduationManager();
        vesting = factory.devVesting();
    }

    function _launch(uint16 devBps) internal returns (address token, BondingCurve curve) {
        return _launchAs(creator, devBps, "VEST");
    }

    function _launchAs(address who, uint16 devBps, string memory symbol)
        internal
        returns (address token, BondingCurve curve)
    {
        vm.prank(who);
        token = factory.createLaunch(LaunchParams("Vest", symbol, "ipfs://QmVest", false, devBps));
        curve = BondingCurve(factory.curveOf(token));
    }

    // Graduation is driven by `CurveDriver._crossToGraduation`, which derives the crossing buy from
    // the curve's own reserves rather than repeating a calibration-coupled literal.

    // ---------------------------------------------------------------------------------------------
    // Where the tokens are, and where they are not
    // ---------------------------------------------------------------------------------------------

    /// @notice The three transfers in `createLaunch` move the entire supply out of the factory. The
    ///         carve lands in the vault, and the 200M pool reserve is untouched by it.
    function test_CreateLaunch_SendsTheCarveToTheVault_AndConservesTheSupply() public {
        (address token, BondingCurve curve) = _launch(MAX_DEV);

        assertEq(IERC20(token).balanceOf(address(vesting)), MAX_DEV_TOKENS, "vault holds the 5% carve");
        assertEq(IERC20(token).balanceOf(address(factory)), 0, "factory holds NO launch tokens");
        assertEq(IERC20(token).balanceOf(address(curve)), 760_000_000e18, "curve holds C = 760M");
        assertEq(
            IERC20(token).balanceOf(address(gm)),
            factory.GRADUATION_RESERVE(),
            "the 200M pool reserve is untouched by the carve"
        );
        assertEq(
            IERC20(token).balanceOf(address(vesting)) + IERC20(token).balanceOf(address(curve))
                + IERC20(token).balanceOf(address(gm)),
            IERC20(token).totalSupply(),
            "the whole 1B is accounted for"
        );
    }

    /// @notice The factory-side record and the vault's grant are the same number.
    /// @dev They are written from one expression in one transaction, so this is a drift check on a
    ///      duplicated fact rather than a test of arithmetic. #36 emits `devAllocationOf`, so a
    ///      divergence would publish a number no claim could ever match.
    function test_FactoryRecordAndVaultGrantAgree() public {
        for (uint16 bps = 100; bps <= MAX_DEV; bps += 100) {
            (address token,) = _launchAs(creator, bps, "AGREE");
            VestingGrant memory g = vesting.grantOf(token);
            assertEq(g.total, factory.devAllocationOf(token), "factory record == vault grant");
            assertEq(g.total, IERC20(token).balanceOf(address(vesting)), "and == the tokens actually held");
        }
    }

    /// @notice A 0% launch registers no grant at all, rather than an empty one.
    function test_ZeroDevAllocation_RegistersNoGrant() public {
        (address token,) = _launch(0);

        assertEq(factory.devAllocationOf(token), 0, "no allocation recorded");
        assertEq(IERC20(token).balanceOf(address(vesting)), 0, "vault holds nothing");
        VestingGrant memory g = vesting.grantOf(token);
        assertEq(g.creator, address(0), "no creator recorded");
        assertEq(g.duration, 0, "no duration recorded");

        vm.expectRevert(DevVesting.UnknownGrant.selector);
        vesting.claim(token);
    }

    /// @notice ⚠️ The vault's headline property: no function anywhere in it sends a launch token to
    ///         an address the caller picks. `claim` is its only transfer and pays a frozen creator.
    ///
    /// @dev ⚠️ **This deliberately does NOT work by calling guessed function names.** An earlier
    ///      version probed `sweep`/`withdraw`/`rescue` and asserted the calls failed, which proves
    ///      almost nothing twice over: a missing function reverts identically to a function that
    ///      exists and rejects the caller (the repo's own "wrong-selector call reverts exactly like
    ///      an authorization failure" trap), and any name not on the guess list sails through. A
    ///      later `sweepToken(address,address)` would have kept that version green while breaking the
    ///      exact property ADR-0007 calls "verifiable by finding the capability absent".
    ///
    ///      So it reads the deployed runtime bytecode and asserts the 4-byte selector is not present
    ///      in it at all. Solidity emits every external function's selector as a literal in the
    ///      dispatch table, so absence from the runtime code is absence from the ABI. That is a
    ///      statement about the contract rather than about one call.
    function test_NoTokenMovingFunctionExistsOnEitherContract() public {
        (address token,) = _launch(MAX_DEV);
        uint256 held = IERC20(token).balanceOf(address(vesting));

        string[8] memory sweeps = [
            "sweep(address,address)",
            "sweepToken(address,address)",
            "withdraw(address,address)",
            "withdrawToken(address,address)",
            "rescue(address,address)",
            "rescueTokens(address,address)",
            "emergencyWithdraw(address,address)",
            "transferToken(address,address,uint256)"
        ];
        for (uint256 i = 0; i < sweeps.length; ++i) {
            _assertSelectorAbsent(address(vesting), sweeps[i], "vault");
            _assertSelectorAbsent(address(factory), sweeps[i], "factory");
        }

        // The generic backstop, which no naming guess can evade: the vault exposes exactly one
        // function that moves tokens at all, and it takes no recipient.
        assertEq(IERC20(token).balanceOf(address(vesting)), held, "allocation untouched");
        assertEq(IERC20(token).balanceOf(owner), 0, "owner received nothing");
    }

    /// @dev Asserts `sig`'s selector appears nowhere in `target`'s deployed runtime code, so the
    ///      function does not exist rather than merely having refused this caller.
    function _assertSelectorAbsent(address target, string memory sig, string memory whose) internal view {
        bytes4 selector = bytes4(keccak256(bytes(sig)));
        bytes memory code = target.code;
        for (uint256 i = 0; i + 4 <= code.length; ++i) {
            bool matchesHere = code[i] == selector[0] && code[i + 1] == selector[1]
                && code[i + 2] == selector[2] && code[i + 3] == selector[3];
            assertFalse(matchesHere, string.concat(whose, " must not implement ", sig));
        }
    }

    // ---------------------------------------------------------------------------------------------
    // The schedule starts at graduation
    // ---------------------------------------------------------------------------------------------

    /// @notice ⚠️ The decisive property. A launch created long ago and graduated today vests from
    ///         TODAY, so the time it spent on the curve buys the creator nothing.
    /// @dev Written so a from-creation implementation would FAIL here while still passing every other
    ///      test in this file: the launch sits on the curve for a year, which is 12x the vesting
    ///      window, so a from-creation schedule would already be fully vested at graduation.
    function test_VestingStartsAtGraduation_NotAtCreation() public {
        (address token, BondingCurve curve) = _launch(MAX_DEV);
        uint64 createdAt = uint64(block.timestamp);

        // A year on the curve: 12x the 30-day window. Under a from-creation schedule the grant would
        // be 100% vested by now.
        vm.warp(createdAt + 365 days);
        assertEq(vesting.vestingStart(token), 0, "schedule has not started: not graduated");
        assertEq(vesting.vestedAmount(token), 0, "nothing vests before graduation, however long it takes");

        _crossToGraduation(curve, "startsatgrad");
        uint64 gradAt = uint64(block.timestamp);
        assertEq(gm.graduatedAt(token), gradAt, "graduation is dated");
        assertEq(vesting.vestingStart(token), gradAt, "the schedule starts at graduation");

        // Still zero at the instant of graduation, a year after creation.
        assertEq(vesting.vestedAmount(token), 0, "zero vested AT graduation");

        // Half the window after GRADUATION is half vested, not fully vested.
        vm.warp(gradAt + 15 days);
        assertApproxEqAbs(vesting.vestedAmount(token), MAX_DEV_TOKENS / 2, 1e18, "half the window, half vested");

        // And the full window after CREATION (long past) is not what completes it.
        vm.warp(gradAt + 30 days);
        assertEq(vesting.vestedAmount(token), MAX_DEV_TOKENS, "fully vested a window after GRADUATION");
    }

    /// @notice A launch that never graduates never vests anything, ever. The tokens stay in the vault.
    function test_UngraduatedLaunch_NeverVests() public {
        (address token,) = _launch(MAX_DEV);

        vm.warp(block.timestamp + 3650 days); // ten years
        assertEq(vesting.vestingStart(token), 0, "never started");
        assertEq(vesting.vestedAmount(token), 0, "nothing vested after a decade");
        assertEq(vesting.claimable(token), 0, "nothing claimable");

        vm.prank(creator);
        vm.expectRevert(DevVesting.NothingToClaim.selector);
        vesting.claim(token);

        assertEq(IERC20(token).balanceOf(address(vesting)), MAX_DEV_TOKENS, "tokens stay in the vault");
        assertEq(IERC20(token).balanceOf(creator), 0, "creator got nothing");
    }

    // ---------------------------------------------------------------------------------------------
    // The shape of the release
    // ---------------------------------------------------------------------------------------------

    /// @notice Linear, with no cliff: the release is proportional to elapsed time throughout.
    /// @dev Checks the quarter points rather than only the ends, because a cliff and a step function
    ///      both reproduce "0 at the start, `total` at the end". The interior is the whole claim.
    function test_ReleaseIsLinear_WithNoCliff() public {
        (address token, BondingCurve curve) = _launch(MAX_DEV);
        _crossToGraduation(curve, "linear");
        uint64 start = gm.graduatedAt(token);
        uint64 window = 30 days;

        assertEq(vesting.vestedAmount(token), 0, "nothing at t=0");
        for (uint256 pct = 1; pct < 100; ++pct) {
            vm.warp(start + (uint256(window) * pct) / 100);
            assertApproxEqAbs(
                vesting.vestedAmount(token),
                (MAX_DEV_TOKENS * pct) / 100,
                1e18,
                "vested tracks elapsed time linearly"
            );
        }
    }

    /// @notice The boundary: fully vested at exactly `start + duration`, not a second later.
    /// @dev And one second BEFORE the boundary it must be short, or the schedule is really a cliff at
    ///      the end. Testing only the >= side would let an off-by-a-window implementation pass.
    function test_FullyVestedAtExactlyTheDuration() public {
        (address token, BondingCurve curve) = _launch(MAX_DEV);
        _crossToGraduation(curve, "boundary");
        uint64 start = gm.graduatedAt(token);

        vm.warp(start + 30 days - 1);
        assertLt(vesting.vestedAmount(token), MAX_DEV_TOKENS, "one second short is not fully vested");

        vm.warp(start + 30 days);
        assertEq(vesting.vestedAmount(token), MAX_DEV_TOKENS, "fully vested AT the boundary");

        vm.warp(start + 3650 days);
        assertEq(vesting.vestedAmount(token), MAX_DEV_TOKENS, "and never more than the grant");
    }

    // ---------------------------------------------------------------------------------------------
    // Claiming
    // ---------------------------------------------------------------------------------------------

    /// @notice `claim` is permissionless but its destination is fixed: a stranger's call pays the
    ///         creator, never the caller.
    function test_ClaimIsPermissionless_ButOnlyEverPaysTheCreator() public {
        (address token, BondingCurve curve) = _launch(MAX_DEV);
        _crossToGraduation(curve, "perm");
        vm.warp(gm.graduatedAt(token) + 30 days);

        vm.prank(stranger);
        uint256 amount = vesting.claim(token);

        assertEq(amount, MAX_DEV_TOKENS, "the whole grant released");
        assertEq(IERC20(token).balanceOf(creator), MAX_DEV_TOKENS, "creator was paid");
        assertEq(IERC20(token).balanceOf(stranger), 0, "the caller received nothing");
        assertEq(IERC20(token).balanceOf(address(vesting)), 0, "vault is empty");
    }

    /// @notice Claiming repeatedly through the window pays each slice exactly once and totals the
    ///         grant, never more.
    function test_IncrementalClaims_TotalTheGrantExactly() public {
        (address token, BondingCurve curve) = _launch(MAX_DEV);
        _crossToGraduation(curve, "incr");
        uint64 start = gm.graduatedAt(token);

        uint256 claimed;
        for (uint256 day = 1; day <= 30; ++day) {
            vm.warp(start + day * 1 days);
            vm.prank(creator);
            claimed += vesting.claim(token);
            assertEq(IERC20(token).balanceOf(creator), claimed, "creator holds exactly what was claimed");
        }

        assertEq(claimed, MAX_DEV_TOKENS, "30 daily claims total the grant to the wei");
        assertEq(vesting.grantOf(token).claimed, MAX_DEV_TOKENS, "accounting agrees");
        assertEq(IERC20(token).balanceOf(address(vesting)), 0, "no dust stranded in the vault");

        // And a 31st claim has nothing left to give.
        vm.warp(start + 31 days);
        vm.prank(creator);
        vm.expectRevert(DevVesting.NothingToClaim.selector);
        vesting.claim(token);
    }

    /// @notice Two claims in the same block cannot pay the same slice twice.
    function test_DoubleClaimInOneBlock_ReleasesNothingExtra() public {
        (address token, BondingCurve curve) = _launch(MAX_DEV);
        _crossToGraduation(curve, "double");
        vm.warp(gm.graduatedAt(token) + 15 days);

        vm.prank(creator);
        uint256 first = vesting.claim(token);
        assertGt(first, 0, "first claim paid");

        vm.prank(creator);
        vm.expectRevert(DevVesting.NothingToClaim.selector);
        vesting.claim(token);

        assertEq(IERC20(token).balanceOf(creator), first, "balance unchanged by the second attempt");
    }

    /// @notice ⚠️ The vault holds every creator's allocation across every launch. One launch's claim
    ///         must never reach another's tokens - including a fully-drained grant next to a
    ///         still-vesting one.
    function test_OneLaunchCannotReachAnothersTokens() public {
        address creatorB = makeAddr("creatorB");
        (address tokenA, BondingCurve curveA) = _launchAs(creator, MAX_DEV, "AAA");
        (address tokenB, BondingCurve curveB) = _launchAs(creatorB, MAX_DEV, "BBB");

        _crossToGraduation(curveA, "isoA");
        _crossToGraduation(curveB, "isoB");

        // A drains completely.
        vm.warp(gm.graduatedAt(tokenA) + 30 days);
        vm.prank(creator);
        vesting.claim(tokenA);
        assertEq(IERC20(tokenA).balanceOf(creator), MAX_DEV_TOKENS, "A paid in full");
        assertEq(IERC20(tokenB).balanceOf(creator), 0, "A's creator holds none of B");

        // B is untouched and still claims its own full grant.
        assertEq(IERC20(tokenB).balanceOf(address(vesting)), MAX_DEV_TOKENS, "B's tokens are all still there");
        vm.prank(creatorB);
        assertEq(vesting.claim(tokenB), MAX_DEV_TOKENS, "B claims its whole grant");
        assertEq(IERC20(tokenB).balanceOf(creatorB), MAX_DEV_TOKENS, "B's creator paid in full");
    }

    /// @notice Tokens donated to the vault inflate no schedule and are claimable by nobody.
    /// @dev Accounting is per grant and never reads `balanceOf`, which is what makes this true. The
    ///      same shape as `GraduationManager` seeding the reserve constant rather than its balance.
    function test_DonatedTokensAreInert() public {
        (address token, BondingCurve curve) = _launch(MAX_DEV);

        // The whale buys on the curve BEFORE it closes, so it holds real tokens to donate. The
        // crossing buy is made by CurveDriver's own closer wallet, not by this one.
        vm.deal(whale, 1 ether);
        vm.prank(whale);
        curve.buy{value: 0.01 ether}(0);

        _crossToGraduation(curve, "donate");

        uint256 gift = IERC20(token).balanceOf(whale) / 2;
        assertGt(gift, 0, "whale has tokens to donate");
        vm.prank(whale);
        assertTrue(IERC20(token).transfer(address(vesting), gift), "donation transfer succeeded");

        vm.warp(gm.graduatedAt(token) + 30 days);
        assertEq(vesting.vestedAmount(token), MAX_DEV_TOKENS, "the donation vests to nobody");

        vm.prank(creator);
        assertEq(vesting.claim(token), MAX_DEV_TOKENS, "creator gets the grant, not the donation");
        assertEq(IERC20(token).balanceOf(address(vesting)), gift, "the donation is stranded, untouched");
    }

    // ---------------------------------------------------------------------------------------------
    // Registration is factory-only
    // ---------------------------------------------------------------------------------------------

    /// @notice Nobody but the factory can mint a grant against the vault's balances.
    function test_RegisterGrant_IsLaunchpadOnly() public {
        (address token,) = _launch(MAX_DEV);

        vm.prank(stranger);
        vm.expectRevert(DevVesting.NotLaunchpad.selector);
        vesting.registerGrant(token, stranger, 1e18, 30 days);

        // Not even the factory's owner, who is the most privileged address in the protocol.
        vm.prank(owner);
        vm.expectRevert(DevVesting.NotLaunchpad.selector);
        vesting.registerGrant(token, owner, 1e18, 30 days);
    }

    /// @notice A launch's grant is single-shot; a second registration cannot overwrite the creator or
    ///         top up the total.
    function test_RegisterGrant_IsSingleShotPerToken() public {
        (address token,) = _launch(MAX_DEV);

        vm.prank(address(factory));
        vm.expectRevert(DevVesting.AlreadyGranted.selector);
        vesting.registerGrant(token, stranger, 1e18, 30 days);

        assertEq(vesting.grantOf(token).creator, creator, "creator unchanged");
        assertEq(vesting.grantOf(token).total, MAX_DEV_TOKENS, "total unchanged");
    }

    /// @notice The bounds that make `vestedAmount` safe are enforced where the grant is created.
    function test_RegisterGrant_RejectsDegenerateGrants() public {
        address fresh = makeAddr("freshToken");

        vm.prank(address(factory));
        vm.expectRevert(DevVesting.InvalidGrant.selector);
        vesting.registerGrant(fresh, creator, 0, 30 days); // zero amount

        vm.prank(address(factory));
        vm.expectRevert(DevVesting.InvalidGrant.selector);
        vesting.registerGrant(fresh, creator, 1e18, 0); // zero duration would divide by zero

        vm.prank(address(factory));
        vm.expectRevert(DevVesting.InvalidGrant.selector);
        vesting.registerGrant(fresh, creator, uint256(type(uint128).max) + 1, 30 days); // would truncate

        vm.prank(address(factory));
        vm.expectRevert(DevVesting.ZeroAddress.selector);
        vesting.registerGrant(fresh, address(0), 1e18, 30 days);

        // The value AT the uint128 ceiling is accepted: the bound rejects overflow, not the edge.
        vm.prank(address(factory));
        vesting.registerGrant(fresh, creator, type(uint128).max, 30 days);
        assertEq(vesting.grantOf(fresh).total, type(uint128).max, "the ceiling itself is a valid grant");
    }

    // ---------------------------------------------------------------------------------------------
    // The owner parameter: tunable, bounded, and future-only
    // ---------------------------------------------------------------------------------------------

    function test_DefaultVestingDuration_IsThirtyDays_AndSitsOnTheFloor() public view {
        assertEq(factory.vestingDuration(), 30 days, "default is 30 days");
        assertEq(factory.DEFAULT_VESTING_DURATION(), factory.MIN_VESTING_DURATION(), "default sits ON the floor");
        assertEq(factory.MAX_VESTING_DURATION(), 1460 days, "ceiling is 4 years");
    }

    function test_SetVestingDuration_IsBounded_AndOwnerOnly() public {
        uint64 min = factory.MIN_VESTING_DURATION();
        uint64 max = factory.MAX_VESTING_DURATION();

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        factory.setVestingDuration(90 days);

        vm.prank(owner);
        vm.expectRevert(LaunchpadFactory.InvalidVestingDuration.selector);
        factory.setVestingDuration(min - 1);

        vm.prank(owner);
        vm.expectRevert(LaunchpadFactory.InvalidVestingDuration.selector);
        factory.setVestingDuration(max + 1);

        vm.prank(owner);
        vm.expectEmit(true, true, true, true, address(factory));
        emit LaunchpadFactory.VestingDurationUpdated(30 days, 90 days);
        factory.setVestingDuration(90 days);
        assertEq(factory.vestingDuration(), 90 days, "duration updated");
    }

    /// @notice ⚠️ A value AT each bound must still produce a working launch, not merely be accepted.
    ///         A bound that is reachable but bricks the product is the failure a revert-only test
    ///         cannot see.
    function test_BothBounds_StillProduceAWorkingSchedule() public {
        uint64[2] memory bounds = [factory.MIN_VESTING_DURATION(), factory.MAX_VESTING_DURATION()];
        string[2] memory tags = ["atmin", "atmax"];

        for (uint256 i = 0; i < bounds.length; ++i) {
            vm.prank(owner);
            factory.setVestingDuration(bounds[i]);

            (address token, BondingCurve curve) = _launchAs(creator, MAX_DEV, "BOUND");
            assertEq(vesting.grantOf(token).duration, bounds[i], "grant froze the bound");

            _crossToGraduation(curve, tags[i]);
            uint64 start = gm.graduatedAt(token);

            // Half way through the window is half vested, at either bound.
            vm.warp(start + bounds[i] / 2);
            assertApproxEqAbs(vesting.vestedAmount(token), MAX_DEV_TOKENS / 2, 1e18, "half vested mid-window");

            vm.warp(start + bounds[i]);
            uint256 before = IERC20(token).balanceOf(creator);
            vm.prank(creator);
            assertEq(vesting.claim(token), MAX_DEV_TOKENS, "the full grant claims at the bound");
            assertEq(IERC20(token).balanceOf(creator) - before, MAX_DEV_TOKENS, "and actually arrives");
        }
    }

    /// @notice Retuning the duration is future-only: an existing grant keeps the window it froze,
    ///         whether the owner lengthens or shortens.
    function test_RetuningTheDuration_DoesNotTouchExistingGrants() public {
        (address tokenA, BondingCurve curveA) = _launchAs(creator, MAX_DEV, "OLD");
        assertEq(vesting.grantOf(tokenA).duration, 30 days, "A froze 30 days");

        vm.prank(owner);
        factory.setVestingDuration(1460 days);

        (address tokenB, BondingCurve curveB) = _launchAs(creator, MAX_DEV, "NEW");
        assertEq(vesting.grantOf(tokenB).duration, 1460 days, "B froze 4 years");
        assertEq(vesting.grantOf(tokenA).duration, 30 days, "A is untouched by the retune");

        _crossToGraduation(curveA, "retuneA");
        _crossToGraduation(curveB, "retuneB");

        // 30 days after graduation A is complete and B has barely begun.
        vm.warp(gm.graduatedAt(tokenA) + 30 days);
        assertEq(vesting.vestedAmount(tokenA), MAX_DEV_TOKENS, "A fully vested on its own 30-day window");
        assertLt(vesting.vestedAmount(tokenB), MAX_DEV_TOKENS / 10, "B is still early in its 4-year window");
    }

    // ---------------------------------------------------------------------------------------------
    // Graduation is dated, and dating it cannot break graduation
    // ---------------------------------------------------------------------------------------------

    /// @notice `graduatedAt` replaced a bool, so it must still work as the already-graduated guard.
    function test_GraduatedAt_DatesGraduation_AndStillGuardsIt() public {
        (address token, BondingCurve curve) = _launch(MAX_DEV);
        assertEq(gm.graduatedAt(token), 0, "zero before graduation, exactly as the bool read false");

        _crossToGraduation(curve, "dated");
        assertEq(gm.graduatedAt(token), uint64(block.timestamp), "dated at the graduating block");

        // The curve is closed, so a second graduation cannot be driven through it. The guard is
        // reached directly instead, from the only caller that could ever pass the `NotCurve` check.
        vm.deal(address(curve), 1 ether);
        vm.prank(address(curve));
        vm.expectRevert(GraduationManager.AlreadyGraduated.selector);
        gm.graduate{value: 1 ether}(token);
    }

    /// @notice A launch with no dev allocation still graduates normally: the vault is simply not
    ///         involved, and nothing on the graduation path consults it.
    function test_ZeroDevLaunch_GraduatesUntouchedByTheVault() public {
        (address token, BondingCurve curve) = _launch(0);
        _crossToGraduation(curve, "zerodev");

        assertGt(gm.graduatedAt(token), 0, "graduated");
        assertEq(IERC20(token).balanceOf(address(vesting)), 0, "vault never held anything");
        assertEq(vesting.vestedAmount(token), 0, "and vests nothing");
    }
}
