// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CurveDriver} from "./CurveDriver.sol";
import {V3Deployer} from "../src/periphery/V3Deployer.sol";
import {LaunchpadFactory, LaunchParams} from "../src/LaunchpadFactory.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {GraduationManager} from "../src/periphery/GraduationManager.sol";
import {LPLock, LockOrigin, LockRecord} from "../src/periphery/LPLock.sol";
import {ForkConfig} from "./ForkConfig.sol";
import {IUniswapV3Factory, IUniswapV3Pool, INonfungiblePositionManager, IWETH9} from
    "../src/interfaces/IUniswapV3Minimal.sol";
import {Constants} from "../src/Constants.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

interface ISwapRouter2 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @notice Build #33: per-position lock records, the 70/30 creator fee split, monotonic `extend`, and
///         the liveness-gated `reclaim`. Runs against a real Robinhood Chain fork with our own V3
///         deploy, so the liveness signal is read from a genuine pool oracle rather than a mock.
contract LockReclaimTest is Test, V3Deployer, CurveDriver {
    uint24 internal constant FEE_TIER = 10000;
    uint64 internal constant ONE_YEAR = 365 days;
    uint32 internal constant INACTIVITY = 180 days;

    LaunchpadFactory internal factory;
    GraduationManager internal gm;
    LPLock internal lock;
    IUniswapV3Factory internal v3Factory;
    address internal positionManager;
    address internal router;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");
    address internal stranger = makeAddr("stranger");
    address internal whale = makeAddr("whale");
    address internal trader = makeAddr("trader");

    function setUp() public {
        vm.createSelectFork(ForkConfig.MAINNET, ForkConfig.MAINNET_BLOCK);
        v3Factory = IUniswapV3Factory(deployV3Factory());
        router = deploySwapRouter(address(v3Factory), Constants.WETH9);
        positionManager = deployPositionManager(address(v3Factory), Constants.WETH9, address(0xDEAD));
        factory = new LaunchpadFactory(owner, treasury, 0, positionManager, address(v3Factory), Constants.WETH9);
        gm = factory.graduationManager();
        lock = factory.lpLock();
        v3Factory.setOwner(address(factory));
    }

    function _graduate(bool permanent) internal returns (address token, address pool, uint256 tokenId) {
        vm.prank(creator);
        token = factory.createLaunch(LaunchParams("Locked", "LOCK", "ipfs://QmTest", permanent, 0));
        BondingCurve curve = BondingCurve(factory.curveOf(token));
        _liftAntiSnipe(curve, "lr");
        vm.deal(whale, 500 ether);
        vm.prank(whale);
        curve.buy{value: 300 ether}(0);
        pool = gm.poolOf(token);
        tokenId = gm.tokenIdOf(token);
    }

    function _swapBothWays(address token) internal {
        vm.deal(trader, 50 ether);
        vm.startPrank(trader);
        IWETH9(Constants.WETH9).deposit{value: 20 ether}();
        IERC20(Constants.WETH9).approve(router, type(uint256).max);
        uint256 out = ISwapRouter2(router).exactInputSingle(
            ISwapRouter2.ExactInputSingleParams(
                Constants.WETH9, token, FEE_TIER, trader, block.timestamp, 15 ether, 0, 0
            )
        );
        IERC20(token).approve(router, type(uint256).max);
        ISwapRouter2(router).exactInputSingle(
            ISwapRouter2.ExactInputSingleParams(token, Constants.WETH9, FEE_TIER, trader, block.timestamp, out, 0, 0)
        );
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------------------------------
    // Lock registration
    // ---------------------------------------------------------------------------------------------

    function test_Graduation_RegistersLockWithFrozenTerms() public {
        (address token, address pool, uint256 tokenId) = _graduate(false);
        LockRecord memory r = lock.lockOf(tokenId);

        assertEq(uint8(r.origin), uint8(LockOrigin.Launch), "origin is Launch");
        assertEq(r.launchToken, token, "launch token recorded");
        assertEq(r.pool, pool, "pool recorded");
        assertEq(r.lockUntil, uint64(block.timestamp) + ONE_YEAR, "1 year from graduation");
        assertEq(r.creatorFeeBps, 7000, "70% creator fee frozen in");
        assertFalse(r.reclaimed, "not reclaimed");
    }

    function test_PermanentLock_SelectedAtCreation() public {
        (,, uint256 tokenId) = _graduate(true);
        assertEq(lock.lockOf(tokenId).lockUntil, lock.PERMANENT(), "permanent sentinel");
    }

    /// @dev The terms are frozen at CREATION, not read at graduation. An owner retune between the two
    ///      must not change a launch that is already live on the curve.
    function test_LockTerms_FrozenAtCreation_NotAtGraduation() public {
        vm.prank(creator);
        address token = factory.createLaunch(LaunchParams("Frozen", "FRZ", "", false, 0));

        // Owner retunes AFTER creation but BEFORE graduation.
        vm.prank(owner);
        factory.setLockParams(90 days, 1000);

        BondingCurve curve = BondingCurve(factory.curveOf(token));
        _liftAntiSnipe(curve, "f2");
        vm.deal(whale, 500 ether);
        vm.prank(whale);
        curve.buy{value: 300 ether}(0);

        LockRecord memory r = lock.lockOf(gm.tokenIdOf(token));
        assertEq(r.lockUntil, uint64(block.timestamp) + ONE_YEAR, "kept the 1 year it was created under");
        assertEq(r.creatorFeeBps, 7000, "kept the 70% it was created under");
    }

    // ---------------------------------------------------------------------------------------------
    // Creator fee split
    // ---------------------------------------------------------------------------------------------

    /// @dev The split is asserted to the wei on BOTH sides. An `assertGt(x, 0)` cannot see a 70%
    ///      diversion, because the 30% remainder still satisfies it.
    function test_Collect_Splits70_30_Exactly() public {
        (address token, address pool, uint256 tokenId) = _graduate(false);
        _swapBothWays(token);

        (address t0, address t1) = (IUniswapV3Pool(pool).token0(), IUniswapV3Pool(pool).token1());
        uint256 tre0 = IERC20(t0).balanceOf(treasury);
        uint256 tre1 = IERC20(t1).balanceOf(treasury);
        uint256 cre0 = IERC20(t0).balanceOf(creator);
        uint256 cre1 = IERC20(t1).balanceOf(creator);

        (uint256 a0, uint256 a1) = lock.collect(tokenId);
        assertGt(a0, 0, "fees accrued in token0");
        assertGt(a1, 0, "fees accrued in token1");

        uint256 expectedCreator0 = (a0 * 7000) / 10000;
        uint256 expectedCreator1 = (a1 * 7000) / 10000;
        assertEq(IERC20(t0).balanceOf(creator) - cre0, expectedCreator0, "creator gets exactly 70% of token0");
        assertEq(IERC20(t1).balanceOf(creator) - cre1, expectedCreator1, "creator gets exactly 70% of token1");
        assertEq(IERC20(t0).balanceOf(treasury) - tre0, a0 - expectedCreator0, "treasury gets the rest of token0");
        assertEq(IERC20(t1).balanceOf(treasury) - tre1, a1 - expectedCreator1, "treasury gets the rest of token1");

        // Nothing is stranded in the lock: every wei collected reached one of the two destinations.
        assertEq(IERC20(t0).balanceOf(address(lock)), 0, "no token0 dust retained");
        assertEq(IERC20(t1).balanceOf(address(lock)), 0, "no token1 dust retained");
    }

    function test_Collect_StaysPermissionless_AndPrincipalUntouched() public {
        (address token,, uint256 tokenId) = _graduate(false);
        _swapBothWays(token);
        vm.prank(stranger); // anyone may trigger it; funds still cannot reach the caller
        lock.collect(tokenId);
        assertEq(IERC721(positionManager).ownerOf(tokenId), address(lock), "still locked after collection");
    }

    // ---------------------------------------------------------------------------------------------
    // Extend
    // ---------------------------------------------------------------------------------------------

    function test_Extend_IsMonotonic_AndCreatorOnly() public {
        (,, uint256 tokenId) = _graduate(false);
        uint64 current = lock.lockOf(tokenId).lockUntil;

        vm.prank(stranger);
        vm.expectRevert(LPLock.NotLaunchCreator.selector);
        lock.extend(tokenId, current + 1 days);

        vm.prank(creator);
        vm.expectRevert(LPLock.CannotShortenLock.selector);
        lock.extend(tokenId, current - 1);

        vm.prank(creator);
        vm.expectRevert(LPLock.CannotShortenLock.selector);
        lock.extend(tokenId, current); // equal is not an extension either

        vm.prank(creator);
        lock.extend(tokenId, current + 365 days);
        assertEq(lock.lockOf(tokenId).lockUntil, current + 365 days, "extended");
    }

    function test_Extend_ToPermanent_IsTerminal() public {
        (,, uint256 tokenId) = _graduate(false);
        // Hoisted deliberately: `vm.prank` applies to the NEXT call only, so reading `lock.PERMANENT()`
        // inline would consume the prank and send `extend` from the test contract.
        uint64 permanent = lock.PERMANENT();
        vm.prank(creator);
        lock.extend(tokenId, permanent);
        vm.warp(block.timestamp + 3650 days);
        assertFalse(lock.isReclaimable(tokenId), "permanent is never reclaimable");
        vm.expectRevert(LPLock.NotReclaimable.selector);
        lock.reclaim(tokenId);
    }

    // ---------------------------------------------------------------------------------------------
    // Reclaim
    // ---------------------------------------------------------------------------------------------

    function test_Reclaim_HappyPath_BurnsTokens_AndSendsWethToTreasury() public {
        (address token, address pool, uint256 tokenId) = _graduate(false);
        (,,,,,,, uint128 liquidity,,,,) = INonfungiblePositionManager(positionManager).positions(tokenId);
        assertGt(liquidity, 0, "position has principal before reclaim");

        vm.warp(block.timestamp + ONE_YEAR + INACTIVITY + 1);
        assertTrue(lock.isReclaimable(tokenId), "expired and quiet");

        uint256 deadBefore = IERC20(token).balanceOf(lock.DEAD());
        uint256 treasuryWethBefore = IERC20(Constants.WETH9).balanceOf(treasury);

        vm.prank(stranger); // permissionless
        (uint256 ethAmount, uint256 tokensBurned) = lock.reclaim(tokenId);

        assertGt(ethAmount, 0, "WETH recovered");
        assertGt(tokensBurned, 0, "tokens recovered");
        assertEq(IERC20(token).balanceOf(lock.DEAD()) - deadBefore, tokensBurned, "launch tokens burned to DEAD");
        assertEq(
            IERC20(Constants.WETH9).balanceOf(treasury) - treasuryWethBefore, ethAmount, "WETH routed to treasury"
        );
        assertEq(IERC20(token).balanceOf(stranger), 0, "caller receives nothing");
        assertEq(IERC20(Constants.WETH9).balanceOf(stranger), 0, "caller receives nothing");
        assertTrue(lock.lockOf(tokenId).reclaimed, "marked reclaimed");

        // Position NFT is burned, so there is nothing left to reclaim twice.
        vm.expectRevert();
        IERC721(positionManager).ownerOf(tokenId);
        vm.expectRevert(LPLock.AlreadyReclaimed.selector);
        lock.reclaim(tokenId);

        // Pool itself still exists and still holds third-party-reachable state; only OUR position left.
        assertTrue(pool.code.length > 0, "pool still deployed");
    }

    function test_Reclaim_RequiresExpiry() public {
        (,, uint256 tokenId) = _graduate(false);
        vm.warp(block.timestamp + ONE_YEAR - 1); // not yet expired, but long quiet
        assertFalse(lock.isReclaimable(tokenId), "not reclaimable before expiry");
        vm.expectRevert(LPLock.LockNotExpired.selector);
        lock.reclaim(tokenId);
    }

    /// @dev The decisive guard. A pool that is still being traded can never be swept, no matter how
    ///      long ago the lock expired - which is what stops a healthy 10-ETH position being taken
    ///      while a dead 2-ETH one is the only thing reclaim can reach.
    function test_Reclaim_BlockedWhilePoolIsActive() public {
        (address token,, uint256 tokenId) = _graduate(false);
        vm.warp(block.timestamp + ONE_YEAR + INACTIVITY + 1);

        _swapBothWays(token); // one swap re-arms the liveness clock

        assertLt(lock.secondsSincePoolActivity(lock.lockOf(tokenId).pool), INACTIVITY, "clock reset by the swap");
        assertFalse(lock.isReclaimable(tokenId), "an active pool is never reclaimable");
        vm.expectRevert(LPLock.PoolStillActive.selector);
        lock.reclaim(tokenId);

        // ...and it becomes reclaimable again only after another full quiet period.
        vm.warp(block.timestamp + INACTIVITY + 1);
        assertTrue(lock.isReclaimable(tokenId), "reclaimable once quiet again");
    }

    /// @dev The core third-party protection. An unregistered position reads `origin == None`, which is
    ///      the enum's zero slot precisely so that a stray NFT is inert rather than sweepable.
    function test_Reclaim_ImpossibleForUnregisteredPosition() public {
        (,, uint256 tokenId) = _graduate(false);
        uint256 strayId = tokenId + 12345; // never registered
        assertEq(uint8(lock.lockOf(strayId).origin), uint8(LockOrigin.None), "unknown ids read as None");
        assertFalse(lock.isReclaimable(strayId), "never reclaimable");
        vm.warp(block.timestamp + 3650 days);
        vm.expectRevert(LPLock.NotReclaimable.selector);
        lock.reclaim(strayId);
    }

    function test_RegisterLock_OnlyGraduationManager() public {
        (address token, address pool,) = _graduate(false);
        vm.prank(stranger);
        vm.expectRevert(LPLock.NotGraduationManager.selector);
        lock.registerLock(999, token, pool, uint64(block.timestamp + 1), 7000);
    }

    // ---------------------------------------------------------------------------------------------
    // Liveness read
    // ---------------------------------------------------------------------------------------------

    /// @dev `increaseObservationCardinalityNext` is permissionless on ANY V3 pool, so a third party can
    ///      grow the ring buffer at will. Reading a hardcoded `observations(0)` would then latch onto a
    ///      stale timestamp and report an active pool as quiet forever - the exact input `reclaim`
    ///      depends on. The read must follow `slot0().observationIndex`.
    function test_Liveness_FollowsObservationIndex_NotSlotZero() public {
        (address token, address pool, uint256 tokenId) = _graduate(false);

        // Anyone can do this; we are not privileged here.
        vm.prank(stranger);
        (bool ok,) = pool.call(abi.encodeWithSignature("increaseObservationCardinalityNext(uint16)", uint16(4)));
        assertTrue(ok, "cardinality raised by a stranger");

        vm.warp(block.timestamp + ONE_YEAR + INACTIVITY + 1);
        _swapBothWays(token); // writes to an observation slot that is no longer index 0

        (,, uint16 observationIndex,,,,) = IUniswapV3Pool(pool).slot0();
        assertGt(observationIndex, 0, "the live observation has moved off slot 0");

        (uint32 slotZeroTs,,,) = IUniswapV3Pool(pool).observations(0);
        assertLt(lock.secondsSincePoolActivity(pool), INACTIVITY, "reads the CURRENT observation");
        assertGt(uint32(block.timestamp) - slotZeroTs, INACTIVITY, "slot 0 is stale and would have lied");
        assertFalse(lock.isReclaimable(tokenId), "so the active pool is correctly protected");
    }

    // ---------------------------------------------------------------------------------------------
    // Owner params
    // ---------------------------------------------------------------------------------------------

    function test_InactivityPeriod_IsMonotonic_AndOwnerOnly() public {
        assertEq(lock.inactivityPeriod(), INACTIVITY, "default 180 days");

        vm.prank(stranger);
        vm.expectRevert(LPLock.NotOwner.selector);
        lock.setInactivityPeriod(365 days);

        // Shortening would bring forward when EXISTING locks become reclaimable - refused.
        vm.prank(owner);
        vm.expectRevert(LPLock.CannotShortenInactivityPeriod.selector);
        lock.setInactivityPeriod(INACTIVITY - 1);

        vm.prank(owner);
        lock.setInactivityPeriod(365 days);
        assertEq(lock.inactivityPeriod(), 365 days, "lengthened");
    }

    /// @dev The whole point of `MAX_LOCK_DURATION`: at the ceiling, graduation must still WORK. A
    ///      duration the factory accepts but the GraduationManager cannot add to `block.timestamp`
    ///      would brick every launch created under it, which no revert-only test would catch.
    function test_MaxLockDuration_StillGraduates() public {
        // Hoisted: an inline `factory.MAX_LOCK_DURATION()` is an external call that would consume the
        // `vm.prank` before `setLockParams` ever runs. Same trap as `lock.PERMANENT()` below.
        uint64 maxDuration = factory.MAX_LOCK_DURATION();
        vm.prank(owner);
        factory.setLockParams(maxDuration, 7000);

        vm.prank(creator);
        address token = factory.createLaunch(LaunchParams("Long", "LONG", "", false, 0));
        BondingCurve curve = BondingCurve(factory.curveOf(token));
        _liftAntiSnipe(curve, "f3");
        vm.deal(whale, 500 ether);
        vm.prank(whale);
        curve.buy{value: 300 ether}(0); // must not revert

        LockRecord memory r = lock.lockOf(gm.tokenIdOf(token));
        assertEq(r.lockUntil, uint64(block.timestamp) + maxDuration, "expiry computed");
        assertTrue(r.lockUntil < lock.PERMANENT(), "and never collides with the permanent sentinel");
    }

    /// @dev GraduationManager inlines the sentinel rather than paying an external call to read a
    ///      compile-time constant. This is what stops the two drifting apart silently.
    function test_PermanentSentinel_MatchesGraduationManagersInlinedCopy() public {
        (,, uint256 tokenId) = _graduate(true);
        assertEq(lock.PERMANENT(), type(uint64).max, "LPLock's sentinel is uint64 max");
        assertEq(lock.lockOf(tokenId).lockUntil, type(uint64).max, "and GM wrote exactly that");
    }

    function test_SetLockParams_ValidatesAndIsOwnerOnly() public {
        vm.prank(stranger);
        vm.expectRevert();
        factory.setLockParams(ONE_YEAR, 7000);

        vm.prank(owner);
        vm.expectRevert(LaunchpadFactory.InvalidLockParams.selector);
        factory.setLockParams(29 days, 7000); // below the floor

        vm.prank(owner);
        vm.expectRevert(LaunchpadFactory.InvalidLockParams.selector);
        factory.setLockParams(ONE_YEAR, 10_001); // above 100%

        // ⚠️ The ceiling exists because GraduationManager does `uint64(block.timestamp) + lockDuration`
        // in checked arithmetic. Without it, an owner could set a duration that makes every subsequent
        // graduation revert forever - a param that silently bricks the product.
        uint64 aboveCeiling = factory.MAX_LOCK_DURATION() + 1; // hoisted: would consume expectRevert
        vm.prank(owner);
        vm.expectRevert(LaunchpadFactory.InvalidLockParams.selector);
        factory.setLockParams(aboveCeiling, 7000);

        vm.prank(owner);
        vm.expectRevert(LaunchpadFactory.InvalidLockParams.selector);
        factory.setLockParams(type(uint64).max, 7000); // would collide with the PERMANENT sentinel

        vm.prank(owner);
        factory.setLockParams(90 days, 5000);
        assertEq(factory.defaultLockDuration(), 90 days, "duration updated");
        assertEq(factory.creatorFeeBps(), 5000, "creator fee updated");
    }
}
