// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CurveDriver} from "./CurveDriver.sol";
import {V3Deployer} from "../src/periphery/V3Deployer.sol";
import {LaunchpadFactory, LaunchParams} from "../src/LaunchpadFactory.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {GraduationManager} from "../src/periphery/GraduationManager.sol";
import {Constants} from "../src/Constants.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ForkConfig} from "./ForkConfig.sol";

/// @notice Build #34: the dev allocation carved out of the curve supply, and the per-launch curve
///         calibration that has to move with it.
///
/// @dev The property under test is the one `docs/tokenomics.md` calls "the invariant that must never
///      be broken": when the curve sells out, `GRADUATION_RESERVE x gradPrice == the raise`, so the
///      pool opens at exactly the price the curve closed at. It holds for any curve allocation `C`
///      provided BOTH virtual reserves are re-solved for that `C`:
///
///        V_tok = C^2 / (C - G)          price continuity
///        V_eth = target * G / (C - G)   holds the graduation target
///
///      ⚠️ `V_tok` is the one that is easy to miss, because before #34 it was a constant and the
///      ticket scope only called out `V_eth`. `test_PriceContinuity_BreaksIfVirtualTokenIsPinned`
///      exists to make that failure mode explicit and permanent rather than a comment.
contract CalibrationTest is Test, V3Deployer, CurveDriver {
    LaunchpadFactory internal factory;
    GraduationManager internal gm;
    address internal positionManager;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");
    address internal whale = makeAddr("whale");

    uint256 internal constant TARGET = 10 ether;

    function setUp() public {
        vm.createSelectFork(ForkConfig.MAINNET, ForkConfig.MAINNET_BLOCK);
        address v3Factory = deployV3Factory();
        positionManager = deployPositionManager(v3Factory, Constants.WETH9, address(0xDEAD));
        factory = new LaunchpadFactory(owner, treasury, 0, positionManager, v3Factory, Constants.WETH9);
        gm = factory.graduationManager();
    }

    function _launch(uint16 devBps) internal returns (address token, BondingCurve curve) {
        vm.prank(creator);
        token = factory.createLaunch(LaunchParams("Carve", "CARVE", "ipfs://QmCarve", false, devBps));
        curve = BondingCurve(factory.curveOf(token));
    }

    /// @dev The raise a curve is calibrated to deliver, straight off its immutables. This is the
    ///      exact figure `_graduate` hands to the GraduationManager, not an approximation.
    function _calibratedRaise(BondingCurve curve) internal view returns (uint256) {
        return curve.finalEthReserve() - curve.virtualEthReserve();
    }

    // ---------------------------------------------------------------------------------------------
    // Route (A): the constant, and the values it has to keep reproducing
    // ---------------------------------------------------------------------------------------------

    /// @notice ⚠️ Guards the single most dangerous literal in the protocol. `DEFAULT_VIRTUAL_ETH_RESERVE`
    ///         is a run of one repeating digit and cannot be checked by eye - a 25-digit version was
    ///         pasted by accident during the tokenomics discussion, a 10^6 error that would have set
    ///         graduation at 10,000,000 ETH and made every launch permanently ungraduatable.
    ///         So this asserts the ARITHMETIC, never a transcribed literal.
    function test_Route_A_ConstantIsTenEtherOverThree() public view {
        assertEq(factory.DEFAULT_VIRTUAL_ETH_RESERVE(), uint256(10 ether) / 3, "route (A): 10 ether / 3");
        // Sanity on magnitude, which is what a fat-fingered digit run actually breaks.
        assertGt(factory.DEFAULT_VIRTUAL_ETH_RESERVE(), 3.3 ether, "V_eth is ~3.33 ETH");
        assertLt(factory.DEFAULT_VIRTUAL_ETH_RESERVE(), 3.4 ether, "V_eth is ~3.33 ETH");
    }

    /// @notice At a zero dev allocation the per-launch solve must reproduce the two published
    ///         constants bit-for-bit, or #34 silently re-calibrated every existing launch.
    function test_Calibration_ReproducesTheConstantsAtZeroDev() public view {
        (uint256 dev, uint256 C, uint256 vEth, uint256 vTok) = factory.curveCalibrationFor(0);
        assertEq(dev, 0, "no dev allocation");
        assertEq(C, factory.CURVE_SUPPLY(), "full 800M on the curve");
        assertEq(vEth, factory.DEFAULT_VIRTUAL_ETH_RESERVE(), "V_eth == the constant");
        assertEq(vTok, factory.DEFAULT_VIRTUAL_TOKEN_RESERVE(), "V_tok == the constant");
    }

    /// @notice The preview and the launch it previews cannot disagree.
    function test_CurveCalibrationFor_MatchesTheLaunchItPreviews() public {
        for (uint16 bps = 0; bps <= 500; bps += 100) {
            (uint256 dev, uint256 C, uint256 vEth, uint256 vTok) = factory.curveCalibrationFor(bps);
            (address token, BondingCurve curve) = _launch(bps);
            assertEq(curve.curveTokenAllocation(), C, "preview C");
            assertEq(curve.virtualEthReserve(), vEth, "preview V_eth");
            assertEq(curve.virtualTokenReserve(), vTok, "preview V_tok");
            assertEq(factory.devAllocationOf(token), dev, "preview dev allocation");
        }
    }

    /// @notice Pins the exact table published in `docs/tokenomics.md#the-dev-allocation`, so the doc
    ///         and the contract cannot drift apart silently.
    /// @dev ⚠️ Four of the `V_tok` values in that table were wrong when first written, because they
    ///         were reasoned out rather than computed. Literals in a doc have no way to fail; this is
    ///         what makes them fail. Note the 3% `V_eth` ends `...221` - see the truncation note in
    ///         `_curveConfigFor`.
    function test_PublishedCalibrationTable_MatchesTheContract() public view {
        uint16[6] memory bps = [uint16(0), 100, 200, 300, 400, 500];
        uint256[6] memory vEth = [
            uint256(3333333333333333333),
            3378378378378378378,
            3424657534246575342,
            3472222222222222221,
            3521126760563380281,
            3571428571428571428
        ];
        uint256[6] memory vTok = [
            uint256(1066666666666666666666666666),
            1059567567567567567567567567,
            1052493150684931506849315068,
            1045444444444444444444444444,
            1038422535211267605633802816,
            1031428571428571428571428571
        ];
        uint256[6] memory curveAlloc =
            [uint256(800_000_000e18), 792_000_000e18, 784_000_000e18, 776_000_000e18, 768_000_000e18, 760_000_000e18];

        for (uint256 i = 0; i < bps.length; i++) {
            (, uint256 C, uint256 e, uint256 t) = factory.curveCalibrationFor(bps[i]);
            assertEq(C, curveAlloc[i], "published C");
            assertEq(e, vEth[i], "published V_eth");
            assertEq(t, vTok[i], "published V_tok");
        }
    }

    // ---------------------------------------------------------------------------------------------
    // The headline: the target survives every dev allocation
    // ---------------------------------------------------------------------------------------------

    /// @notice Every allocation 0..5% still graduates at 10 ETH, to within a handful of wei.
    /// @dev The tolerance is absolute and tiny on purpose. `V_eth` is stored pre-truncated as
    ///      `10 ether / 3`, so rescaling it can land one wei low, which is ~3 wei on the target - it
    ///      does at 3% and nowhere else in this range. A relative tolerance would hide a real
    ///      mis-calibration; 100 wei out of 10 ETH cannot hide anything but the truncation.
    function test_Target_HoldsAcrossEveryDevAllocation() public {
        for (uint16 bps = 0; bps <= 500; bps += 25) {
            (, BondingCurve curve) = _launch(bps);
            assertApproxEqAbs(_calibratedRaise(curve), TARGET, 100, "10 ETH target holds");
        }
    }

    /// @notice The invariant itself: the 200M reserve valued at the curve's closing price is exactly
    ///         the ETH the curve raised. No price gap at graduation, so no arbitrage gift to the
    ///         first swapper.
    function test_PriceContinuity_HoldsAcrossEveryDevAllocation() public {
        for (uint16 bps = 0; bps <= 500; bps += 25) {
            (, BondingCurve curve) = _launch(bps);
            uint256 raised = _calibratedRaise(curve);
            // G x gradPrice, where gradPrice = finalEthReserve / finalTokenReserve.
            uint256 reserveValue = (factory.GRADUATION_RESERVE() * curve.finalEthReserve()) / curve.finalTokenReserve();
            assertApproxEqAbs(reserveValue, raised, 100, "G x gradPrice == raise");
        }
    }

    /// @notice ⚠️ The failure mode #34's scope missed, pinned so it can never come back. Re-solving
    ///         `V_eth` but leaving `V_tok` at its 800M constant opens the pool ~9% above the curve's
    ///         closing price and misses the target by over a tenth of the raise.
    /// @dev Deliberately reconstructs the WRONG calibration by hand and asserts it is wrong, which is
    ///      the only way to prove the shipped code is not accidentally equivalent to it.
    function test_PriceContinuity_BreaksIfVirtualTokenIsPinned() public view {
        uint256 C = 760_000_000e18; // 5% dev
        uint256 G = factory.GRADUATION_RESERVE();
        uint256 vEth = (factory.DEFAULT_VIRTUAL_ETH_RESERVE() * (factory.CURVE_SUPPLY() - G)) / (C - G);

        // The wrong version: V_tok pinned at the 800M constant.
        uint256 vTokPinned = factory.DEFAULT_VIRTUAL_TOKEN_RESERVE();
        uint256 finalTok = vTokPinned - C;
        uint256 finalEth = _ceilDiv(vEth * vTokPinned, finalTok);
        uint256 raisedWrong = finalEth - vEth;
        uint256 reserveValueWrong = (G * finalEth) / finalTok;

        // Misses the target by well over a tenth of the raise.
        assertLt(raisedWrong, 9 ether, "pinned V_tok undershoots the 10 ETH target badly");
        // And breaks the invariant: the reserve is worth materially less than what was raised, which
        // is the same thing as the pool opening above the curve's closing price.
        assertLt(reserveValueWrong, (raisedWrong * 95) / 100, "pinned V_tok breaks price continuity");

        // The shipped solve, on the same C, does neither.
        (,, uint256 vEthOk, uint256 vTokOk) = factory.curveCalibrationFor(500);
        assertEq(vEthOk, vEth, "V_eth matches the hand solve");
        assertTrue(vTokOk != vTokPinned, "V_tok is NOT the pinned constant");
    }

    /// @dev Mirrors OpenZeppelin `Math.ceilDiv`, which is what `BondingCurve.finalEthReserve` uses.
    ///      Reimplemented rather than imported so this test reconstructs the WRONG calibration from
    ///      primitives, independently of the library the contract under test relies on.
    function _ceilDiv(uint256 a, uint256 b) private pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    // ---------------------------------------------------------------------------------------------
    // Where the tokens actually go
    // ---------------------------------------------------------------------------------------------

    /// @notice The carve comes out of the curve allocation, never out of the 200M pool reserve, and
    ///         the 1B total is conserved.
    function test_DevAllocation_CarvedFromCurve_NotFromTheGraduationReserve() public {
        (address token, BondingCurve curve) = _launch(500);

        uint256 dev = factory.devAllocationOf(token);
        assertEq(dev, (factory.CURVE_SUPPLY() * 500) / 10_000, "5% of the curve supply");
        assertEq(dev, 40_000_000e18, "5% of 800M is 40M");

        assertEq(IERC20(token).balanceOf(address(curve)), 760_000_000e18, "curve holds C = 760M");
        assertEq(
            IERC20(token).balanceOf(address(gm)),
            factory.GRADUATION_RESERVE(),
            "the 200M pool reserve is UNTOUCHED by the carve"
        );
        // #35 moved custody: the carve leaves for the vesting vault in the same transaction, so the
        // factory ends `createLaunch` holding no launch tokens at all.
        assertEq(IERC20(token).balanceOf(address(factory)), 0, "factory custodies nothing");
        assertEq(IERC20(token).balanceOf(address(factory.devVesting())), dev, "the vault custodies the carve");

        assertEq(
            IERC20(token).balanceOf(address(curve)) + IERC20(token).balanceOf(address(gm))
                + IERC20(token).balanceOf(address(factory.devVesting())),
            IERC20(token).totalSupply(),
            "the whole 1B is accounted for"
        );
    }

    /// @notice The factory has no path that moves a launch token, and #35 did not give it one.
    /// @dev In #34 this asserted that the allocation was stranded in the factory. #35 moved custody to
    ///      `DevVesting`, so the property worth pinning here changed shape but not intent: the factory
    ///      must still hold nothing and be able to move nothing. `DevVesting.t.sol` carries the
    ///      corresponding assertion for the vault, which is where the tokens actually live now.
    function test_Factory_HasNoTokenWithdrawalPath() public {
        (address token,) = _launch(500);
        assertEq(IERC20(token).balanceOf(address(factory)), 0, "the factory holds no launch tokens");

        // No owner path out, on the contract that also owns the V3 factory.
        vm.prank(owner);
        (bool ok,) = address(factory).call(abi.encodeWithSignature("sweep(address,address)", token, owner));
        assertFalse(ok, "no sweep function exists");
        assertEq(IERC20(token).balanceOf(owner), 0, "owner received nothing");
    }

    // ---------------------------------------------------------------------------------------------
    // Anti-snipe: scaled onto the launch's own C
    // ---------------------------------------------------------------------------------------------

    /// @notice The documented "1% of the curve" and "15% of the curve" hold at every allocation.
    function test_AntiSnipe_ParamsScaleWithCurveAllocation() public {
        for (uint16 bps = 0; bps <= 500; bps += 100) {
            (, BondingCurve curve) = _launch(bps);
            uint256 C = curve.curveTokenAllocation();
            assertEq(curve.maxBuyPerWallet(), C / 100, "cap is 1% of THIS launch's C");
            assertEq(curve.antiSnipeThreshold(), (C * 15) / 100, "threshold is 15% of THIS launch's C");
        }
    }

    /// @notice ⚠️ The property that actually matters, and the one a clamp to `C` would NOT deliver:
    ///         the cap must lift strictly before sellout. A threshold at or above `C` is unreachable,
    ///         so `tokensSold` never crosses it and the per-wallet cap binds for the curve's whole
    ///         life. `AntiSnipe.t.sol` deploys `threshold == ALLOC` for exactly that reason.
    function test_AntiSnipe_WindowLiftsStrictlyBeforeSellout_AtMaxDev() public {
        (, BondingCurve curve) = _launch(500);
        assertLt(curve.antiSnipeThreshold(), curve.curveTokenAllocation(), "threshold is reachable");
        assertTrue(curve.buyCapActive(), "window starts active");

        _liftAntiSnipe(curve, "as");

        assertFalse(curve.buyCapActive(), "window lifted");
        assertLt(curve.tokensSold(), curve.curveTokenAllocation(), "and it lifted BEFORE sellout");
    }

    /// @notice ⚠️ The extreme case, and the reason `setCurveParams` now rejects a threshold EQUAL to
    ///         `CURVE_SUPPLY` rather than merely above it. Rescaling maps `T == CURVE_SUPPLY` to
    ///         exactly `C`, which is unreachable, so scaling alone would not have closed the hole.
    ///         At the largest threshold the owner can now set, the lift is still reachable at every
    ///         dev allocation.
    function test_AntiSnipe_ThresholdStaysReachable_AtTheOwnersCeiling() public {
        // ⚠️ Hoisted: `vm.prank` applies to the NEXT call, and a getter inline in the arguments IS
        // that call - it consumes the prank and setCurveParams then reverts as unauthorized.
        uint256 vEth = factory.DEFAULT_VIRTUAL_ETH_RESERVE();
        uint256 maxThreshold = factory.CURVE_SUPPLY() - 1;

        vm.prank(owner);
        factory.setCurveParams(vEth, 100, 8_000_000e18, maxThreshold);

        for (uint16 bps = 0; bps <= 500; bps += 100) {
            (, BondingCurve curve) = _launch(bps);
            assertLt(
                curve.antiSnipeThreshold(),
                curve.curveTokenAllocation(),
                "threshold strictly below C, so the cap can always lift"
            );
        }

        // And the value one step further is refused outright.
        uint256 unreachable = factory.CURVE_SUPPLY();
        vm.prank(owner);
        vm.expectRevert(LaunchpadFactory.InvalidCurveParams.selector);
        factory.setCurveParams(vEth, 100, 8_000_000e18, unreachable);
    }

    // ---------------------------------------------------------------------------------------------
    // Bounds. Every one of these tests that the value AT the ceiling still WORKS.
    // ---------------------------------------------------------------------------------------------

    /// @notice A launch at the maximum dev allocation graduates end to end. ⚠️ The point is that the
    ///         bound WORKS at its edge, not merely that going past it reverts - #33's review caught
    ///         an owner param whose ceiling would have permanently bricked graduation.
    function test_MaxDevAllocation_StillGraduatesAtTheTarget() public {
        (address token, BondingCurve curve) = _launch(factory.MAX_DEV_ALLOCATION_BPS());

        _liftAntiSnipe(curve, "maxdev");
        vm.deal(whale, 500 ether);
        vm.prank(whale);
        curve.buy{value: 300 ether}(0);

        assertTrue(curve.graduated(), "graduated at the 5% ceiling");
        address pool = gm.poolOf(token);
        assertTrue(pool != address(0) && pool.code.length > 0, "pool exists");

        uint256 poolWeth = IERC20(Constants.WETH9).balanceOf(pool);
        uint256 poolToken = IERC20(token).balanceOf(pool);
        assertApproxEqRel(poolWeth, TARGET, 1e15, "~10 WETH seeded even at a 5% carve");
        assertApproxEqRel(poolToken, factory.GRADUATION_RESERVE(), 1e15, "~200M tokens seeded");

        // Price continuity end to end, through the real pool rather than the curve's own arithmetic.
        assertApproxEqRel((poolWeth * 1e18) / poolToken, curve.priceX18(), 1e15, "pool opens at the curve's close");
    }

    function test_DevAllocation_AboveTheMax_Reverts() public {
        vm.prank(creator);
        vm.expectRevert(LaunchpadFactory.InvalidDevAllocation.selector);
        factory.createLaunch(LaunchParams("Too Much", "TM", "", false, 501));
    }

    /// @notice ⚠️ The preview must refuse exactly what `createLaunch` refuses. Returning a plausible
    ///         calibration for an allocation nobody can actually get would put a number on the create
    ///         form that no launch can ever match, and the bound is what makes `_solveCalibration`'s
    ///         `unchecked` block provable in the first place.
    function test_CurveCalibrationFor_RefusesWhatCreateLaunchRefuses() public {
        vm.expectRevert(LaunchpadFactory.InvalidDevAllocation.selector);
        factory.curveCalibrationFor(501);

        // A value far past the max, which without the bound would underflow `C - G` rather than
        // merely return something wrong.
        vm.expectRevert(LaunchpadFactory.InvalidDevAllocation.selector);
        factory.curveCalibrationFor(10_000);

        // And it tracks the owner's tunable ceiling, not just the hard constant.
        vm.prank(owner);
        factory.setMaxDevAllocationBps(100);
        vm.expectRevert(LaunchpadFactory.InvalidDevAllocation.selector);
        factory.curveCalibrationFor(101);
        (, uint256 C,,) = factory.curveCalibrationFor(100);
        assertEq(C, 792_000_000e18, "at the lowered ceiling it still previews");
    }

    /// @notice The owner ceiling is bounded by the hard constant, and zero is valid - that is the
    ///         documented way to switch the pre-mine off without a redeploy.
    function test_SetMaxDevAllocation_IsBounded_AndOwnerOnly() public {
        uint16 hardMax = factory.MAX_DEV_ALLOCATION_BPS();

        // ⚠️ Pinned to the exact error, never a bare `vm.expectRevert()`. CLAUDE.md's trap list:
        // a bare expectRevert caught a wrong-selector call for six builds while claiming to prove
        // an authorization failure.
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, creator));
        factory.setMaxDevAllocationBps(100);

        vm.prank(owner);
        vm.expectRevert(LaunchpadFactory.InvalidDevAllocation.selector);
        factory.setMaxDevAllocationBps(hardMax + 1);

        // At the ceiling: allowed, and a launch at it still works.
        vm.prank(owner);
        factory.setMaxDevAllocationBps(hardMax);
        (, BondingCurve atMax) = _launch(hardMax);
        assertEq(atMax.curveTokenAllocation(), 760_000_000e18, "ceiling still launches");

        // At zero: the pre-mine is off, and 0 bps still launches.
        vm.prank(owner);
        factory.setMaxDevAllocationBps(0);
        vm.prank(creator);
        vm.expectRevert(LaunchpadFactory.InvalidDevAllocation.selector);
        factory.createLaunch(LaunchParams("Nope", "NOPE", "", false, 1));

        (address token, BondingCurve zeroDev) = _launch(0);
        assertEq(factory.devAllocationOf(token), 0, "no allocation");
        assertEq(zeroDev.curveTokenAllocation(), factory.CURVE_SUPPLY(), "full curve");
    }

    /// @notice Lowering the ceiling is FUTURE-ONLY: it never claws back an allocation already carved,
    ///         including one on a curve that has not graduated yet.
    function test_LoweringTheMax_DoesNotTouchExistingLaunches() public {
        (address token, BondingCurve curve) = _launch(500);
        uint256 devBefore = factory.devAllocationOf(token);
        uint256 vEthBefore = curve.virtualEthReserve();

        vm.prank(owner);
        factory.setMaxDevAllocationBps(0);

        assertEq(factory.devAllocationOf(token), devBefore, "existing allocation untouched");
        assertEq(curve.virtualEthReserve(), vEthBefore, "existing calibration untouched");
        assertFalse(curve.graduated(), "and it is still mid-curve");
    }

    /// @notice ⚠️ `virtualEthReserve` is multiplied by 600M-with-18-decimals in the per-launch solve
    ///         and again into `k`, both in checked arithmetic. This tests that the value AT
    ///         `MAX_VIRTUAL_ETH_RESERVE` still creates a launch rather than reverting - an unbounded
    ///         setter here would let the owner permanently brick `createLaunch`.
    function test_MaxVirtualEthReserve_StillCreatesLaunches() public {
        uint256 ceilingValue = factory.MAX_VIRTUAL_ETH_RESERVE();

        vm.prank(owner);
        vm.expectRevert(LaunchpadFactory.InvalidCurveParams.selector);
        factory.setCurveParams(ceilingValue + 1, 100, 8_000_000e18, 120_000_000e18);

        vm.prank(owner);
        factory.setCurveParams(ceilingValue, 100, 8_000_000e18, 120_000_000e18);

        // At the ceiling AND at the maximum carve, which is where the intermediates are largest.
        (, BondingCurve curve) = _launch(500);
        assertGt(curve.k(), 0, "k computed without overflow");
        assertGt(_calibratedRaise(curve), 0, "curve is still graduatable");
        assertEq(curve.virtualEthReserve(), (ceilingValue * 600_000_000e18) / 560_000_000e18, "solve applied");
    }

    /// @notice Retuning `virtualEthReserve` moves the target for future launches only, and the
    ///         carve keeps working on top of the new value.
    function test_RetuningVirtualEth_MovesTheTarget_FutureOnly() public {
        (, BondingCurve before) = _launch(0);
        assertApproxEqAbs(_calibratedRaise(before), TARGET, 100, "10 ETH before");

        // 1 ETH testnet calibration.
        vm.prank(owner);
        factory.setCurveParams(uint256(1 ether) / 3, 100, 8_000_000e18, 120_000_000e18);

        (, BondingCurve afterCurve) = _launch(500);
        assertApproxEqAbs(_calibratedRaise(afterCurve), 1 ether, 100, "1 ETH after, even at a 5% carve");
        assertApproxEqAbs(_calibratedRaise(before), TARGET, 100, "the in-flight launch never moved");
    }
}
