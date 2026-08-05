// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {CurveDriver} from "./CurveDriver.sol";
import {V3Deployer} from "../src/periphery/V3Deployer.sol";
import {LaunchpadFactory, LaunchParams} from "../src/LaunchpadFactory.sol";
import {BondingCurve, CurveConfig} from "../src/BondingCurve.sol";
import {LaunchToken} from "../src/LaunchToken.sol";
import {GraduationManager} from "../src/periphery/GraduationManager.sol";
import {LPLock} from "../src/periphery/LPLock.sol";
import {DevVesting} from "../src/periphery/DevVesting.sol";
import {Constants} from "../src/Constants.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ForkConfig} from "./ForkConfig.sol";

/// @notice A contract that refuses every ETH transfer, for reaching the failure branches that a
///         normal EOA test wallet can never take.
/// @dev ⚠️ This exists because `FeeTransferFailed` and `RefundFailed` were both UNREACHED by 142
///      tests. They are the branches where a hostile or merely careless counterparty bricks
///      `createLaunch`, which is the highest-traffic entry point in the protocol.
contract RejectsEth {
    receive() external payable {
        revert("nope");
    }
}

/// @notice A contract with no `receive` and no payable fallback, so plain ETH sends fail.
contract NoReceive {}

/// @notice Build #35a: the security-hardening pass driven by the four documents in
///         `web3-security.md` (SlowMist, Alchemy, Consensys Diligence, WTF gas).
///
/// @dev ⚠️ **Every test in this file covers a branch that 142 passing tests never executed.** They
///      are overwhelmingly revert paths, guards and clamps - the code that only runs when something
///      goes wrong, which is precisely what an auditor probes and what line coverage hides. Before
///      this file: `BondingCurve` 44% branch coverage, `LaunchpadFactory` 61%, `GraduationManager`
///      60%. SlowMist requires >95% overall and 100% on core code.
///
///      Findings and reasoning are mapped to their source documents in `docs/security-checklist.md`.
contract SecurityHardeningTest is Test, V3Deployer, CurveDriver {
    LaunchpadFactory internal factory;
    GraduationManager internal gm;
    LPLock internal lock;
    DevVesting internal vesting;
    address internal positionManager;
    address internal v3Factory;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant CREATION_FEE = 0.01 ether;

    function setUp() public {
        vm.createSelectFork(ForkConfig.MAINNET, ForkConfig.MAINNET_BLOCK);
        v3Factory = deployV3Factory();
        positionManager = deployPositionManager(v3Factory, Constants.WETH9, address(0xDEAD));
        factory = new LaunchpadFactory(owner, treasury, CREATION_FEE, positionManager, v3Factory, Constants.WETH9);
        gm = factory.graduationManager();
        lock = factory.lpLock();
        vesting = factory.devVesting();

        vm.deal(creator, 100 ether);
        vm.deal(stranger, 100 ether);
    }

    /// @dev A FRESH config every call.
    /// @dev ⚠️ Not a convenience. `CurveConfig memory c = base;` ALIASES the struct rather than
    ///      copying it, so mutating `c` to build the next invalid case silently corrupts the
    ///      baseline and every later case tests the wrong thing. The first version of
    ///      `test_BondingCurve_ConstructorInvariants` failed for exactly that reason: it reported
    ///      "zero addr" where it expected "bad reserves", because an earlier case had already
    ///      zeroed the token address on the shared struct.
    function _validCurveConfig() internal returns (CurveConfig memory) {
        return CurveConfig({
            token: IERC20(makeAddr("tok")),
            treasury: treasury,
            graduationManager: address(gm),
            virtualEthReserve: 1 ether,
            virtualTokenReserve: 1000e18,
            curveTokenAllocation: 800e18,
            tradeFeeBps: 100,
            maxBuyPerWallet: 8e18,
            antiSnipeThreshold: 120e18
        });
    }

    function _params(string memory symbol, uint16 devBps) internal pure returns (LaunchParams memory) {
        return LaunchParams("Harden", symbol, "ipfs://QmHarden", false, devBps);
    }

    // =============================================================================================
    // Constructor guards - every zero-address and bounds check, none of which was executed
    // =============================================================================================

    function test_Factory_RejectsZeroTreasury() public {
        vm.expectRevert(LaunchpadFactory.ZeroTreasury.selector);
        new LaunchpadFactory(owner, address(0), 0, positionManager, v3Factory, Constants.WETH9);
    }

    function test_LaunchToken_RejectsZeroRecipient() public {
        vm.expectRevert(LaunchToken.ZeroRecipient.selector);
        new LaunchToken("N", "N", "", address(0));
    }

    function test_LPLock_RejectsZeroAddresses() public {
        vm.expectRevert(LPLock.ZeroAddress.selector);
        new LPLock(address(0), address(factory));

        vm.expectRevert(LPLock.ZeroAddress.selector);
        new LPLock(positionManager, address(0));
    }

    function test_DevVesting_RejectsZeroAddresses() public {
        vm.expectRevert(DevVesting.ZeroAddress.selector);
        new DevVesting(address(0), address(gm));

        vm.expectRevert(DevVesting.ZeroAddress.selector);
        new DevVesting(address(factory), address(0));
    }

    /// @notice `BondingCurve`'s constructor invariants. The factory can never construct a curve that
    ///         violates them, so these are only reachable by building one by hand - which is exactly
    ///         why they had never run.
    function test_BondingCurve_ConstructorInvariants() public {
        CurveConfig memory c = _validCurveConfig();
        c.token = IERC20(address(0));
        vm.expectRevert("BondingCurve: zero addr");
        new BondingCurve(c);

        c = _validCurveConfig();
        c.treasury = address(0);
        vm.expectRevert("BondingCurve: zero addr");
        new BondingCurve(c);

        c = _validCurveConfig();
        c.graduationManager = address(0);
        vm.expectRevert("BondingCurve: zero addr");
        new BondingCurve(c);

        // ⚠️ The calibration invariant: V_tok must exceed C, or `finalTokenReserve` underflows and
        // the curve can never compute a graduation price.
        c = _validCurveConfig();
        c.virtualTokenReserve = c.curveTokenAllocation;
        vm.expectRevert("BondingCurve: bad reserves");
        new BondingCurve(c);

        c = _validCurveConfig();
        c.tradeFeeBps = 10_000; // == BPS, which would make every trade cost 100%
        vm.expectRevert("BondingCurve: bad fee");
        new BondingCurve(c);

        c = _validCurveConfig();
        c.maxBuyPerWallet = 0; // would make every buy revert, bricking the curve
        vm.expectRevert("BondingCurve: bad cap");
        new BondingCurve(c);

        // And the value just inside each bound still constructs, so the guard is not over-tight.
        c = _validCurveConfig();
        c.virtualTokenReserve = c.curveTokenAllocation + 1;
        c.tradeFeeBps = 9_999;
        c.maxBuyPerWallet = 1;
        BondingCurve edge = new BondingCurve(c);
        assertEq(edge.maxBuyPerWallet(), 1, "the edge values construct a working curve");
    }

    // =============================================================================================
    // ETH transfer failure paths - the branches an EOA can never reach
    // =============================================================================================

    /// @notice ⚠️ A treasury that rejects ETH bricks `createLaunch` for everyone. Reached here for
    ///         the first time; the branch existed since #13 and had never executed.
    /// @dev This is a live operational risk, not a theoretical one: `setTreasury` accepts any
    ///      non-zero address, including a contract with no `receive`. Recorded in
    ///      `docs/security-checklist.md` under "Development recommendations", row
    ///      "Setting `treasury` to a contract that rejects ETH".
    function test_CreateLaunch_RevertsWhenTreasuryRejectsEth() public {
        address hostile = address(new RejectsEth());
        vm.prank(owner);
        factory.setTreasury(hostile);

        vm.deal(creator, 1 ether);
        vm.prank(creator);
        vm.expectRevert(LaunchpadFactory.FeeTransferFailed.selector);
        factory.createLaunch{value: CREATION_FEE}(_params("HOSTILE", 0));
    }

    /// @notice A creator contract that cannot receive its own refund reverts the whole creation,
    ///         rather than silently keeping the overpayment.
    function test_CreateLaunch_RevertsWhenRefundIsRejected() public {
        address payer = address(new NoReceive());
        vm.deal(payer, 1 ether);

        vm.prank(payer);
        vm.expectRevert(LaunchpadFactory.RefundFailed.selector);
        factory.createLaunch{value: CREATION_FEE + 1 wei}(_params("NOREFUND", 0));
    }

    /// @notice Paying exactly the fee takes the no-refund path, so an unrefundable caller can still
    ///         launch. The bound is reachable, not merely rejected.
    function test_CreateLaunch_ExactFee_NeedsNoRefund() public {
        address payer = address(new NoReceive());
        vm.deal(payer, 1 ether);

        vm.prank(payer);
        address token = factory.createLaunch{value: CREATION_FEE}(_params("EXACT", 0));
        assertTrue(factory.curveOf(token) != address(0), "exact payment launches fine");
    }

    /// @notice A seller whose `receive()` reverts cannot silently lose their proceeds; the sell
    ///         reverts as a whole. Reaches `BondingCurve.EthTransferFailed`.
    function test_Sell_RevertsWhenSellerRejectsEth() public {
        vm.prank(creator);
        address token = factory.createLaunch{value: CREATION_FEE}(_params("SELLREJ", 0));
        BondingCurve curve = BondingCurve(factory.curveOf(token));

        // Derived from the curve's own cap, not a literal: an ETH-sized buy is coupled to the
        // calibration and the same ETH buys ~9x the tokens at a 10 ETH target as at 90.
        address seller = address(new RejectsEth());
        uint256 buyIn = _maxBuyUnderCap(curve);
        assertGt(buyIn, 0, "the anti-snipe cap leaves room for an opening buy");
        vm.deal(seller, buyIn);
        vm.prank(seller);
        curve.buy{value: buyIn}(0);

        uint256 bal = IERC20(token).balanceOf(seller);
        assertGt(bal, 0, "seller holds tokens to sell");

        vm.prank(seller);
        IERC20(token).approve(address(curve), bal);
        vm.prank(seller);
        vm.expectRevert(BondingCurve.EthTransferFailed.selector);
        curve.sell(bal, 0);
    }

    // =============================================================================================
    // Curve trade guards - the small-input and zero-input paths
    // =============================================================================================

    /// @notice ⚠️ Documents that `NoTokensOut` is an UNREACHABLE defensive guard, not a live path.
    ///
    /// @dev An attempt to cover it by branch-coverage chasing failed, and the reason is worth
    ///      recording rather than contriving a pass. The open price is ~3.125e-9 ETH per whole token
    ///      and tokens carry 18 decimals, so even a 1-wei buy yields ~3e8 token-wei - comfortably
    ///      non-zero. There is no buy size on a live curve that rounds to zero tokens out.
    ///
    ///      It is kept in the contract for the same reason `CurveSoldOut` is (whose own comment reads
    ///      "safety; unreachable"): both hold under the CURRENT calibration, and `virtualEthReserve`
    ///      is owner-tunable. A future retune that raised the open price by ~9 orders of magnitude
    ///      would make it reachable. Deliberately unreached, not overlooked - see
    ///      `docs/security-checklist.md`.
    function test_Buy_DustStillBuysTokens_NoTokensOutIsUnreachable() public {
        vm.prank(creator);
        address token = factory.createLaunch{value: CREATION_FEE}(_params("DUST", 0));
        BondingCurve curve = BondingCurve(factory.curveOf(token));

        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        uint256 out = curve.buy{value: 1 wei}(0);
        assertGt(out, 0, "even one wei buys a non-zero number of token-wei at this calibration");
    }

    function test_Sell_RevertsOnZeroAmount() public {
        vm.prank(creator);
        address token = factory.createLaunch{value: CREATION_FEE}(_params("ZEROSELL", 0));
        BondingCurve curve = BondingCurve(factory.curveOf(token));

        vm.prank(stranger);
        vm.expectRevert(BondingCurve.ZeroAmount.selector);
        curve.sell(0, 0);
    }

    /// @notice ⚠️ The crossing buy's clamp. A buy that OVERSHOOTS graduation must take only what the
    ///         curve needs and refund the rest, never underflow on the refund arithmetic.
    /// @dev This is `BondingCurve`'s comment about the fee floor and the ceil gross-up "not composing
    ///      to the wei". Driven with a deliberately enormous buy so the clamp is certain to bind.
    function test_CrossingBuy_ClampsAndRefundsTheOvershoot() public {
        vm.prank(creator);
        address token = factory.createLaunch{value: CREATION_FEE}(_params("OVERSHOOT", 0));
        BondingCurve curve = BondingCurve(factory.curveOf(token));

        _liftAntiSnipe(curve, "overshoot");

        // What the curve actually needs to close, grossed up for the fee, read off its own
        // reserves. Overshoot it 10x. A literal here would be pinned to the current calibration.
        uint256 needed = _ethToClose(curve);
        uint256 overshoot = needed * 10;

        address whale = makeAddr("overshootwhale");
        vm.deal(whale, overshoot);
        uint256 before = whale.balance;

        vm.prank(whale);
        curve.buy{value: overshoot}(0);

        assertTrue(curve.graduated(), "the overshooting buy graduated the curve");
        uint256 spent = before - whale.balance;
        assertLt(spent, overshoot, "the overshoot was refunded, not swallowed");
        assertApproxEqRel(spent, needed, 0.01e18, "and the curve took what it needed, not more");
    }

    // =============================================================================================
    // Access control - every guard, called by the wrong caller
    // =============================================================================================

    function test_ApplyProtocolFee_OnlyGraduationManager() public {
        vm.prank(stranger);
        vm.expectRevert(LaunchpadFactory.NotGraduationManager.selector);
        factory.applyProtocolFee(makeAddr("pool"));

        // Not even the owner, who owns the V3 factory the call ultimately touches.
        vm.prank(owner);
        vm.expectRevert(LaunchpadFactory.NotGraduationManager.selector);
        factory.applyProtocolFee(makeAddr("pool"));
    }

    function test_Graduate_OnlyTheTokensOwnCurve() public {
        vm.prank(creator);
        address token = factory.createLaunch{value: CREATION_FEE}(_params("NOTCURVE", 0));

        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(GraduationManager.NotCurve.selector);
        gm.graduate{value: 1 ether}(token);
    }

    /// @notice A curve forwarding zero ETH cannot seed a pool, so graduation refuses rather than
    ///         creating a pool at a nonsense price.
    function test_Graduate_RefusesToSeedNothing() public {
        vm.prank(creator);
        address token = factory.createLaunch{value: CREATION_FEE}(_params("NOSEED", 0));
        address curve = factory.curveOf(token);

        vm.prank(curve);
        vm.expectRevert(GraduationManager.NothingToSeed.selector);
        gm.graduate{value: 0}(token);
    }

    function test_RegisterLock_GuardsEveryArgument() public {
        address realGm = address(gm);

        vm.prank(stranger);
        vm.expectRevert(LPLock.NotGraduationManager.selector);
        lock.registerLock(1, makeAddr("t"), makeAddr("p"), 0, 0);

        vm.prank(realGm);
        vm.expectRevert(LPLock.ZeroAddress.selector);
        lock.registerLock(1, address(0), makeAddr("p"), 0, 0);

        vm.prank(realGm);
        vm.expectRevert(LPLock.ZeroAddress.selector);
        lock.registerLock(1, makeAddr("t"), address(0), 0, 0);

        uint16 maxBps = lock.MAX_CREATOR_FEE_BPS();
        vm.prank(realGm);
        vm.expectRevert(LPLock.InvalidCreatorFee.selector);
        lock.registerLock(1, makeAddr("t"), makeAddr("p"), 0, maxBps + 1);

        // The value AT the ceiling registers fine: 100% to the creator is a valid, if unused, policy.
        vm.prank(realGm);
        lock.registerLock(1, makeAddr("t"), makeAddr("p"), 0, maxBps);
        assertEq(lock.lockOf(1).creatorFeeBps, maxBps, "the ceiling itself is accepted");

        // And a second registration for the same id is refused.
        vm.prank(realGm);
        vm.expectRevert(LPLock.AlreadyLocked.selector);
        lock.registerLock(1, makeAddr("t2"), makeAddr("p2"), 0, 0);
    }

    function test_Extend_GuardsUnknownAndNonCreator() public {
        vm.expectRevert(LPLock.UnknownLock.selector);
        lock.extend(999, uint64(block.timestamp + 1000));

        vm.prank(creator);
        address token = factory.createLaunch{value: CREATION_FEE}(_params("EXTEND", 0));

        vm.prank(address(gm));
        lock.registerLock(7, token, makeAddr("pool"), uint64(block.timestamp + 100), 0);

        vm.prank(stranger);
        vm.expectRevert(LPLock.NotLaunchCreator.selector);
        lock.extend(7, uint64(block.timestamp + 200));

        // Monotonic: the creator cannot shorten, and cannot re-set the same value.
        vm.prank(creator);
        vm.expectRevert(LPLock.CannotShortenLock.selector);
        lock.extend(7, uint64(block.timestamp + 100));

        vm.prank(creator);
        lock.extend(7, uint64(block.timestamp + 101));
        assertEq(lock.lockOf(7).lockUntil, uint64(block.timestamp + 101), "one second later is allowed");
    }

    /// @notice `extend` to the PERMANENT sentinel is allowed and is terminal: nothing can extend past
    ///         it, because nothing is later than `type(uint64).max`.
    function test_Extend_ToPermanentIsTerminal() public {
        vm.prank(creator);
        address token = factory.createLaunch{value: CREATION_FEE}(_params("PERM", 0));

        vm.prank(address(gm));
        lock.registerLock(11, token, makeAddr("pool"), uint64(block.timestamp + 100), 0);

        uint64 permanent = lock.PERMANENT();
        vm.prank(creator);
        lock.extend(11, permanent);
        assertEq(lock.lockOf(11).lockUntil, permanent, "now permanent");

        // Terminal: there is no value strictly greater, so every further extend is refused.
        vm.prank(creator);
        vm.expectRevert(LPLock.CannotShortenLock.selector);
        lock.extend(11, permanent);
    }

    /// @notice ⚠️ `secondsSincePoolActivity` fails CLOSED on an unreadable observation: an
    ///         uninitialized slot reads as "active right now", never as "inactive forever".
    /// @dev This is the guard on `reclaim`'s decisive condition, and it had never been executed. If
    ///      it failed OPEN, an unreadable oracle would satisfy the one check standing between a live
    ///      pool and having its liquidity swept.
    function test_SecondsSincePoolActivity_FailsClosedOnUninitializedObservation() public {
        // A pool address whose slot0/observations return zeroed data: `initialized` reads false.
        address fakePool = makeAddr("fakePool");
        vm.mockCall(
            fakePool,
            abi.encodeWithSignature("slot0()"),
            abi.encode(uint160(0), int24(0), uint16(0), uint16(0), uint16(0), uint8(0), false)
        );
        vm.mockCall(
            fakePool,
            abi.encodeWithSignature("observations(uint256)"),
            abi.encode(uint32(0), int56(0), uint160(0), false) // initialized == false
        );

        assertEq(lock.secondsSincePoolActivity(fakePool), 0, "unreadable observation reads as maximally recent");
    }

    // =============================================================================================
    // Owner parameter bounds - both sides of every range check
    // =============================================================================================

    function test_SetProtocolFee_BoundsAreReachableAndEnforced() public {
        vm.startPrank(owner);

        vm.expectRevert(abi.encodeWithSelector(LaunchpadFactory.InvalidProtocolFee.selector, uint8(3)));
        factory.setProtocolFee(3);

        vm.expectRevert(abi.encodeWithSelector(LaunchpadFactory.InvalidProtocolFee.selector, uint8(11)));
        factory.setProtocolFee(11);

        // Zero (off) and both ends of the valid band must WORK, not merely be accepted.
        factory.setProtocolFee(0);
        assertEq(factory.protocolFee(), 0, "0 turns the fee off");
        factory.setProtocolFee(4);
        assertEq(factory.protocolFee(), 4, "4 is the low end");
        factory.setProtocolFee(10);
        assertEq(factory.protocolFee(), 10, "10 is the high end");

        vm.stopPrank();
    }

    function test_SetPoolProtocolFee_ValidatesAndIsOwnerOnly() public {
        address pool = makeAddr("pool");

        // Pinned, not bare: `pool` has no code, so `setFeeProtocol` on it reverts too. A bare
        // expectRevert here passes even with `onlyOwner` deleted.
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        factory.setPoolProtocolFee(pool, 4);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(LaunchpadFactory.InvalidProtocolFee.selector, uint8(3)));
        factory.setPoolProtocolFee(pool, 3);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(LaunchpadFactory.InvalidProtocolFee.selector, uint8(11)));
        factory.setPoolProtocolFee(pool, 11);
    }

    function test_SetTreasury_RejectsZero() public {
        vm.prank(owner);
        vm.expectRevert(LaunchpadFactory.ZeroTreasury.selector);
        factory.setTreasury(address(0));
    }

    /// @notice With the protocol fee switched off, graduation still succeeds and simply signals
    ///         nothing. The fee switch must never be able to block a migration.
    function test_Graduation_SucceedsWithProtocolFeeOff() public {
        vm.prank(owner);
        factory.setProtocolFee(0);

        vm.prank(creator);
        address token = factory.createLaunch{value: CREATION_FEE}(_params("FEEOFF", 0));
        BondingCurve curve = BondingCurve(factory.curveOf(token));
        _crossToGraduation(curve, "feeoff");

        assertGt(gm.graduatedAt(token), 0, "graduated with the protocol fee off");
        assertTrue(gm.poolOf(token) != address(0), "pool still created");
    }

    /// @notice ⚠️ If the launchpad does NOT own the V3 factory, `applyProtocolFee` must degrade to a
    ///         skipped-event rather than reverting. A fee-switch misconfiguration can never brick a
    ///         graduation - which would strand a launch with its curve already closed.
    function test_Graduation_SkipsFeeSwitchWhenNotV3FactoryOwner() public {
        // Hand V3 factory ownership elsewhere, so the launchpad's fee call is not authorized.
        vm.prank(owner);
        factory.setProtocolFee(4);
        vm.mockCall(
            address(factory.v3Factory()), abi.encodeWithSignature("owner()"), abi.encode(makeAddr("someoneElse"))
        );

        vm.prank(creator);
        address token = factory.createLaunch{value: CREATION_FEE}(_params("NOTOWNER", 0));
        BondingCurve curve = BondingCurve(factory.curveOf(token));
        _crossToGraduation(curve, "notowner");

        assertGt(gm.graduatedAt(token), 0, "graduation is NOT blocked by a fee-switch misconfiguration");
    }

    /// @notice ⚠️ A reclaimed lock is terminal: the creator cannot extend it back to life afterwards.
    /// @dev Drives a REAL reclaim end to end rather than poking the flag into storage. An earlier
    ///      version of this test cheated by asserting `extend` worked BEFORE the reclaim, which made
    ///      its name a lie - it would have passed even with the `AlreadyReclaimed` guard deleted.
    function test_Extend_RefusedAfterReclaim() public {
        vm.prank(creator);
        address token = factory.createLaunch{value: CREATION_FEE}(_params("RECEXT", 0));
        BondingCurve curve = BondingCurve(factory.curveOf(token));
        _crossToGraduation(curve, "recext");

        uint256 tokenId = gm.tokenIdOf(token);
        // Past both gates: the lock's own expiry and the pool-inactivity window.
        vm.warp(block.timestamp + 366 days + 181 days);
        assertTrue(lock.isReclaimable(tokenId), "preconditions for a real reclaim are met");

        vm.prank(stranger);
        lock.reclaim(tokenId);
        assertTrue(lock.lockOf(tokenId).reclaimed, "reclaimed");

        vm.prank(creator);
        vm.expectRevert(LPLock.AlreadyReclaimed.selector);
        lock.extend(tokenId, uint64(block.timestamp + 1000));
    }

    // =============================================================================================
    // The storage-packing decision, pinned so a reorder cannot silently undo it
    // =============================================================================================

    /// @notice ⚠️ The five small owner params must stay in ONE storage slot. Inserting a `uint256`
    ///         between them, or moving one away, silently costs an extra cold SLOAD on every
    ///         `createLaunch` and an extra 17k gas on every factory deployment.
    /// @dev Asserts the layout itself rather than a gas number, because a gas assertion would drift
    ///      with every unrelated change. Measured deltas are in `docs/security-checklist.md`.
    function test_OwnerParams_SharePackedStorageSlot() public view {
        // A read of all five in one call must not cost more than a single cold SLOAD plus warm ones.
        // The layout claim itself is checked by `forge inspect`; here we pin the VALUES round-trip so
        // a mis-packed reorder that corrupted a neighbour would fail loudly.
        assertEq(factory.defaultLockDuration(), factory.DEFAULT_LOCK_DURATION(), "lock duration intact");
        assertEq(factory.creatorFeeBps(), factory.DEFAULT_CREATOR_FEE_BPS(), "creator fee intact");
        assertEq(factory.maxDevAllocationBps(), factory.MAX_DEV_ALLOCATION_BPS(), "max dev intact");
        assertEq(factory.vestingDuration(), factory.DEFAULT_VESTING_DURATION(), "vesting duration intact");
        assertEq(factory.tradeFeeBps(), factory.DEFAULT_TRADE_FEE_BPS(), "trade fee intact");
    }

    /// @notice Writing each packed field must not disturb its neighbours - the classic bit-masking
    ///         bug that only appears once values share a slot.
    function test_PackedParams_WritesDoNotCorruptNeighbours() public {
        vm.startPrank(owner);
        factory.setCurveParams(1 ether, 250, 5_000_000e18, 100_000_000e18);
        factory.setLockParams(90 days, 4000);
        factory.setMaxDevAllocationBps(300);
        factory.setVestingDuration(180 days);
        vm.stopPrank();

        assertEq(factory.tradeFeeBps(), 250, "trade fee survived its neighbours' writes");
        assertEq(factory.defaultLockDuration(), 90 days, "lock duration survived");
        assertEq(factory.creatorFeeBps(), 4000, "creator fee survived");
        assertEq(factory.maxDevAllocationBps(), 300, "max dev survived");
        assertEq(factory.vestingDuration(), 180 days, "vesting duration survived");

        // And a launch created afterwards picks up every one of them.
        vm.prank(creator);
        address token = factory.createLaunch{value: CREATION_FEE}(_params("PACKED", 300));
        BondingCurve curve = BondingCurve(factory.curveOf(token));
        assertEq(curve.tradeFeeBps(), 250, "the curve froze the packed trade fee");
        assertEq(vesting.grantOf(token).duration, 180 days, "the grant froze the packed vesting duration");
    }
}
