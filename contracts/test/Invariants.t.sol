// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {CurveDriver} from "./CurveDriver.sol";
import {V3Deployer} from "../src/periphery/V3Deployer.sol";
import {LaunchpadFactory, LaunchParams} from "../src/LaunchpadFactory.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {GraduationManager} from "../src/periphery/GraduationManager.sol";
import {DevVesting} from "../src/periphery/DevVesting.sol";
import {Constants} from "../src/Constants.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ForkConfig} from "./ForkConfig.sol";

/// @notice Build #35a: property-based tests over the arithmetic that example-based tests cannot reach.
///
/// @dev Alchemy's best-practices guide names Foundry fuzzing explicitly, and it is the right tool
///      here for one reason: every one of these properties is a statement about ALL inputs, and the
///      142 example-based tests each pin exactly one. A rounding error that only appears at an
///      awkward buy size, or a vesting split that strands a wei, is invisible to a test that always
///      buys 0.01 ether.
///
///      ⚠️ Every property below is written so it would FAIL on a plausible bug, not so it passes.
///      The value-conservation ones in particular are the whole reason the file exists: they are
///      what stands between us and someone extracting more ETH than they put in.
contract InvariantsTest is Test, V3Deployer, CurveDriver {
    LaunchpadFactory internal factory;
    GraduationManager internal gm;
    DevVesting internal vesting;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        vm.createSelectFork(ForkConfig.MAINNET, ForkConfig.MAINNET_BLOCK);
        address v3Factory = deployV3Factory();
        address pm = deployPositionManager(v3Factory, Constants.WETH9, address(0xDEAD));
        factory = new LaunchpadFactory(owner, treasury, 0, pm, v3Factory, Constants.WETH9);
        gm = factory.graduationManager();
        vesting = factory.devVesting();
    }

    function _launch(uint16 devBps) internal returns (address token, BondingCurve curve) {
        vm.prank(creator);
        token = factory.createLaunch(LaunchParams("Inv", "INV", "ipfs://QmInv", false, devBps));
        curve = BondingCurve(factory.curveOf(token));
    }

    // =============================================================================================
    // Curve value conservation
    // =============================================================================================

    /// @notice ⚠️ THE property that matters most: a buy followed immediately by selling everything
    ///         back must NEVER return more ETH than went in. If it can, the curve is a money pump
    ///         and the protocol is drained by a loop.
    /// @dev The round trip must lose exactly the two trade fees and nothing else may go the buyer's
    ///      way. Fuzzed across the whole practical buy range.
    function testFuzz_BuyThenSell_NeverReturnsMoreThanWasPaid(uint96 ethIn) public {
        (address token, BondingCurve curve) = _launch(0);
        // Below the dust floor the curve rounds to zero tokens out and reverts; above the anti-snipe
        // cap a single wallet cannot buy at all. Both are tested elsewhere as explicit reverts.
        ethIn = uint96(bound(ethIn, 0.0001 ether, 0.02 ether));

        address trader = makeAddr("fuzztrader");
        vm.deal(trader, uint256(ethIn) + 1 ether);

        vm.prank(trader);
        uint256 tokensOut = curve.buy{value: ethIn}(0);
        assertGt(tokensOut, 0, "buy produced tokens");

        vm.prank(trader);
        IERC20(token).approve(address(curve), tokensOut);
        vm.prank(trader);
        uint256 ethBack = curve.sell(tokensOut, 0);

        assertLe(ethBack, ethIn, "a round trip can never be profitable");
        // And the loss is bounded by roughly the two 1% fees plus rounding - not an arbitrary haircut.
        assertGe(ethBack, (uint256(ethIn) * 97) / 100, "the round trip loses only the fees");
    }

    /// @notice ⚠️ The SAME round trip at a ZERO trade fee, which is what actually tests the rounding
    ///         DIRECTION rather than the fee.
    /// @dev This test exists because its fee-charging sibling above was proven too weak. Mutating
    ///      `_previewSell`'s `Math.ceilDiv` to a floor - rounding in the seller's favour, the classic
    ///      AMM money-pump bug - did NOT fail that test, because a 1% fee on each leg dwarfs a one-wei
    ///      rounding error and the round trip stays unprofitable anyway. With the fee set to zero,
    ///      rounding is the ONLY thing standing between a trader and free ETH, so the property has
    ///      nothing left to hide behind. Verified: this test does catch that mutant.
    function testFuzz_ZeroFeeRoundTrip_StillCannotProfit(uint96 ethIn) public {
        // ⚠️ Hoisted deliberately: `vm.prank` applies to the NEXT call, and a getter inline in the
        // arguments IS that next call. Inlining this read makes the prank land on the getter and the
        // setter revert with OwnableUnauthorizedAccount. Documented in CLAUDE.md; hit anyway.
        uint256 vEth = factory.DEFAULT_VIRTUAL_ETH_RESERVE();
        vm.prank(owner);
        factory.setCurveParams(vEth, 0, 8_000_000e18, 120_000_000e18);

        (address token, BondingCurve curve) = _launch(0);
        assertEq(curve.tradeFeeBps(), 0, "fee really is zero, so only rounding protects the curve");
        ethIn = uint96(bound(ethIn, 0.0001 ether, 0.02 ether));

        address trader = makeAddr("zerofeetrader");
        vm.deal(trader, uint256(ethIn) + 1 ether);

        vm.prank(trader);
        uint256 tokensOut = curve.buy{value: ethIn}(0);
        vm.prank(trader);
        IERC20(token).approve(address(curve), tokensOut);
        vm.prank(trader);
        uint256 ethBack = curve.sell(tokensOut, 0);

        assertLe(ethBack, ethIn, "even with no fee, rounding must never favour the trader");
    }

    /// @notice The curve's ETH balance always covers what it owes: reserves never claim more ETH
    ///         than the contract actually holds.
    function testFuzz_CurveIsAlwaysSolvent(uint96 ethIn, uint8 buyers) public {
        (, BondingCurve curve) = _launch(0);
        ethIn = uint96(bound(ethIn, 0.0001 ether, 0.01 ether));
        uint256 n = bound(buyers, 1, 8);

        for (uint256 i = 0; i < n; ++i) {
            address b = makeAddr(string(abi.encodePacked("solvent", vm.toString(i))));
            vm.deal(b, uint256(ethIn) + 1 ether);
            vm.prank(b);
            curve.buy{value: ethIn}(0);
        }

        // `ethReserve` counts the virtual reserve too, so what the curve actually owes sellers is the
        // real portion. That must never exceed the balance it holds.
        uint256 realEth = curve.ethReserve() - curve.virtualEthReserve();
        assertLe(realEth, address(curve).balance, "curve holds at least what it owes");
    }

    /// @notice Tokens sold is always exactly the curve's starting balance minus its current one, and
    ///         never exceeds the allocation. A drift here is a supply leak.
    function testFuzz_TokensSoldTracksTheBalance(uint96 ethIn, uint16 devBps) public {
        devBps = uint16(bound(devBps, 0, 500));
        (address token, BondingCurve curve) = _launch(devBps);
        ethIn = uint96(bound(ethIn, 0.0001 ether, 0.01 ether));

        uint256 alloc = curve.curveTokenAllocation();
        address b = makeAddr("tracker");
        vm.deal(b, uint256(ethIn) + 1 ether);
        vm.prank(b);
        curve.buy{value: ethIn}(0);

        assertEq(curve.tokensSold(), alloc - IERC20(token).balanceOf(address(curve)), "tokensSold == tokens that left");
        assertLe(curve.tokensSold(), alloc, "never oversells the allocation");
    }

    // =============================================================================================
    // Calibration
    // =============================================================================================

    /// @notice The graduation target and price continuity hold at EVERY dev allocation, not just the
    ///         six in the published table.
    /// @dev `Calibration.t.sol` pins the table's own rows; this samples the range between them.
    ///      Sampling, not exhaustion: 256 draws from 501 legal values, so a specific unlucky
    ///      `devBps` is not guaranteed to be visited on any given run.
    function testFuzz_CalibrationHoldsAtEveryDevAllocation(uint16 devBps) public {
        devBps = uint16(bound(devBps, 0, 500));
        (, BondingCurve curve) = _launch(devBps);

        uint256 raise = curve.finalEthReserve() - curve.virtualEthReserve();
        assertApproxEqAbs(raise, 10 ether, 100, "10 ETH target holds at every allocation");

        uint256 reserveValue = (factory.GRADUATION_RESERVE() * curve.finalEthReserve()) / curve.finalTokenReserve();
        assertApproxEqAbs(reserveValue, raise, 100, "G x gradPrice == raise at every allocation");
    }

    /// @notice The anti-snipe window must be reachable for every allocation, or the per-wallet cap
    ///         binds for that curve's entire life.
    function testFuzz_AntiSnipeThresholdIsAlwaysReachable(uint16 devBps) public {
        devBps = uint16(bound(devBps, 0, 500));
        (, BondingCurve curve) = _launch(devBps);
        assertLt(curve.antiSnipeThreshold(), curve.curveTokenAllocation(), "threshold is strictly reachable");
        assertGt(curve.maxBuyPerWallet(), 0, "cap is never zero, which would brick every buy");
    }

    // =============================================================================================
    // Vesting
    // =============================================================================================

    /// @notice ⚠️ A creator can never claim more than they were granted, however they split their
    ///         claims in time. This is the property that stops the vault paying out other launches'
    ///         tokens.
    function testFuzz_ClaimsNeverExceedTheGrant(uint16 devBps, uint32 gap, uint8 claims) public {
        devBps = uint16(bound(devBps, 1, 500));
        (address token, BondingCurve curve) = _launch(devBps);
        _crossToGraduation(curve, "fuzzvest");

        uint256 granted = vesting.grantOf(token).total;
        uint256 start = gm.graduatedAt(token);
        uint256 n = bound(claims, 1, 10);
        uint256 step = bound(gap, 1, 20 days);

        uint256 total;
        for (uint256 i = 1; i <= n; ++i) {
            vm.warp(start + i * step);
            if (vesting.claimable(token) == 0) continue;
            // Claimed by somebody who is NOT the beneficiary. `claim` is permissionless and pays
            // `g.creator`, a fixed destination, so a caller who is also the payee cannot see the
            // payout being misrouted to msg.sender.
            vm.prank(stranger);
            total += vesting.claim(token);
        }

        assertLe(total, granted, "claims never exceed the grant");
        assertEq(IERC20(token).balanceOf(creator), total, "creator holds exactly what was claimed");
        assertEq(IERC20(token).balanceOf(stranger), 0, "the caller who is not the beneficiary gets nothing");
        assertEq(vesting.grantOf(token).claimed, total, "accounting matches the payouts");
    }

    /// @notice Vested is monotonic in time: it can never go DOWN as the clock advances.
    function testFuzz_VestedIsMonotonicInTime(uint16 devBps, uint32 t1, uint32 t2) public {
        devBps = uint16(bound(devBps, 1, 500));
        (address token, BondingCurve curve) = _launch(devBps);
        _crossToGraduation(curve, "fuzzmono");

        uint256 start = gm.graduatedAt(token);
        uint256 a = bound(t1, 0, 60 days);
        uint256 b = bound(t2, 0, 60 days);
        if (a > b) (a, b) = (b, a);

        vm.warp(start + a);
        uint256 vestedEarly = vesting.vestedAmount(token);
        vm.warp(start + b);
        uint256 vestedLate = vesting.vestedAmount(token);

        assertGe(vestedLate, vestedEarly, "vested never decreases with time");
        assertLe(vestedLate, vesting.grantOf(token).total, "and never exceeds the grant");
    }

    /// @notice Nothing vests before graduation, at ANY point in time. The decisive property of
    ///         ADR-0007, fuzzed over the whole timeline rather than at one chosen instant.
    function testFuzz_NothingVestsBeforeGraduation(uint16 devBps, uint32 elapsed) public {
        devBps = uint16(bound(devBps, 1, 500));
        (address token,) = _launch(devBps);

        vm.warp(block.timestamp + bound(elapsed, 0, 3650 days));
        assertEq(vesting.vestedAmount(token), 0, "nothing vests before graduation, ever");
        assertEq(vesting.claimable(token), 0, "and nothing is claimable");
    }
}
