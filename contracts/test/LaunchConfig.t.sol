// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {V3Deployer} from "../src/periphery/V3Deployer.sol";
import {LaunchpadFactory, LaunchParams} from "../src/LaunchpadFactory.sol";
import {GraduationManager} from "../src/periphery/GraduationManager.sol";
import {DevVesting} from "../src/periphery/DevVesting.sol";
import {Constants} from "../src/Constants.sol";
import {ForkConfig} from "./ForkConfig.sol";

/// @notice `LaunchConfig` (#36): the second creation event, carrying the per-launch terms that
///         `LaunchCreated` has no stack room for.
/// @dev The ordering tests here are the point of the file. Everything else about this event is a
///      value check that a mapping would also catch; the ORDER is the part that is free to get
///      right at the emit site and expensive to discover once the subgraph is written against it.
contract LaunchConfigTest is Test, V3Deployer {
    LaunchpadFactory internal factory;
    DevVesting internal vesting;
    address internal positionManager;
    address internal v3Factory;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");

    uint256 internal constant CREATION_FEE = 0.01 ether;

    // keccak256 of each signature, which is what `Vm.Log.topics[0]` carries.
    bytes32 internal constant LAUNCH_CREATED_SIG =
        keccak256("LaunchCreated(address,address,address,string,string,string,uint256,uint256,uint256,uint16,uint256,uint256)");
    bytes32 internal constant LAUNCH_CONFIG_SIG = keccak256("LaunchConfig(address,uint256,uint64,uint64,uint16,bool)");
    bytes32 internal constant GRANT_REGISTERED_SIG = keccak256("GrantRegistered(address,address,uint256,uint64)");

    function setUp() public {
        vm.createSelectFork(ForkConfig.MAINNET, ForkConfig.MAINNET_BLOCK);
        v3Factory = deployV3Factory();
        positionManager = deployPositionManager(v3Factory, Constants.WETH9, address(0xDEAD));
        factory = new LaunchpadFactory(owner, treasury, CREATION_FEE, positionManager, v3Factory, Constants.WETH9);
        vesting = factory.devVesting();
        vm.deal(creator, 100 ether);
    }

    function _params(string memory symbol, uint16 devBps, bool permanent)
        internal
        pure
        returns (LaunchParams memory)
    {
        return LaunchParams("Config", symbol, "ipfs://QmConfig", permanent, devBps);
    }

    /// @dev Index of the first log with this signature, or `type(uint256).max` if absent. Returning
    ///      a sentinel rather than reverting lets a caller assert ABSENCE, which the zero-carve test
    ///      needs and which a reverting finder could not express.
    function _indexOf(Vm.Log[] memory logs, bytes32 sig) internal pure returns (uint256) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == sig) return i;
        }
        return type(uint256).max;
    }

    /// @dev The same lookup for callers that REQUIRE the log. Indexing with `_indexOf`'s sentinel
    ///      would panic with an array out-of-bounds, which says nothing about what actually went
    ///      wrong; this fails with the name of the missing event instead.
    function _requireLog(Vm.Log[] memory logs, bytes32 sig, string memory what)
        internal
        pure
        returns (Vm.Log memory)
    {
        uint256 i = _indexOf(logs, sig);
        require(i != type(uint256).max, string.concat("expected a ", what, " log, found none"));
        return logs[i];
    }

    // =============================================================================================
    // Log order - the constraint the subgraph's handlers depend on
    // =============================================================================================

    /// @notice ⚠️ `LaunchCreated` must precede `LaunchConfig`, which must precede `GrantRegistered`.
    ///         All three land in the ONE creation transaction and an indexer processes logs in
    ///         order: `handleLaunchCreated` is what creates the entity the other two `load()`.
    ///         Reordering the emit sites breaks the subgraph with no contract test failing, unless
    ///         this one exists.
    function test_LogOrder_CreatedThenConfigThenGrant() public {
        vm.recordLogs();
        vm.prank(creator);
        factory.createLaunch{value: CREATION_FEE}(_params("ORDER", 500, false));
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 created = _indexOf(logs, LAUNCH_CREATED_SIG);
        uint256 config = _indexOf(logs, LAUNCH_CONFIG_SIG);
        uint256 grant = _indexOf(logs, GRANT_REGISTERED_SIG);

        assertTrue(created != type(uint256).max, "LaunchCreated was emitted");
        assertTrue(config != type(uint256).max, "LaunchConfig was emitted");
        assertTrue(grant != type(uint256).max, "GrantRegistered was emitted");

        assertLt(created, config, "LaunchCreated must precede LaunchConfig");
        assertLt(config, grant, "LaunchConfig must precede GrantRegistered");
    }

    /// @notice A zero carve registers no grant at all, so the ordering constraint degenerates to two
    ///         events rather than three - and `LaunchConfig` must still be emitted, carrying zero.
    /// @dev The honest distinction `_grantDevCarve` draws: no creator allocation, rather than one
    ///      worth nothing. An indexer must be able to tell those apart, so absence of
    ///      `GrantRegistered` is asserted rather than assumed.
    function test_LogOrder_ZeroCarveEmitsConfigButNoGrant() public {
        vm.recordLogs();
        vm.prank(creator);
        factory.createLaunch{value: CREATION_FEE}(_params("NOCARVE", 0, false));
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 created = _indexOf(logs, LAUNCH_CREATED_SIG);
        uint256 config = _indexOf(logs, LAUNCH_CONFIG_SIG);

        assertTrue(config != type(uint256).max, "LaunchConfig is emitted even with no carve");
        assertLt(created, config, "LaunchCreated must still precede LaunchConfig");
        assertEq(_indexOf(logs, GRANT_REGISTERED_SIG), type(uint256).max, "no grant is registered for a zero carve");
    }

    // =============================================================================================
    // Payload
    // =============================================================================================

    /// @notice The emitted carve equals what `DevVesting` actually holds, and what the factory
    ///         recorded. Three sources that must agree, checked against each other rather than
    ///         against a hardcoded expectation, which would only restate the arithmetic.
    function test_Payload_CarveMatchesTheVaultAndTheRecord() public {
        vm.recordLogs();
        vm.prank(creator);
        address token = factory.createLaunch{value: CREATION_FEE}(_params("CARVE", 500, false));
        Vm.Log[] memory logs = vm.getRecordedLogs();

        (uint256 devAllocation, uint64 vestingDuration, uint64 lockDuration, uint16 creatorFeeBps, bool permanent) =
            abi.decode(_requireLog(logs, LAUNCH_CONFIG_SIG, "LaunchConfig").data, (uint256, uint64, uint64, uint16, bool));

        assertEq(devAllocation, factory.devAllocationOf(token), "event agrees with the factory's record");
        assertEq(devAllocation, vesting.grantOf(token).total, "event agrees with the registered grant");
        assertEq(devAllocation, factory.CURVE_SUPPLY() * 500 / 10_000, "and with 5% of the curve supply, read from the contract not a copy");

        assertEq(vestingDuration, factory.vestingDuration(), "vesting duration is this launch's frozen value");
        assertEq(lockDuration, factory.defaultLockDuration(), "lock duration is this launch's frozen value");
        assertEq(creatorFeeBps, factory.creatorFeeBps(), "creator fee is this launch's frozen value");
        assertFalse(permanent, "this launch did not choose a permanent lock");
    }

    /// @notice The token address arrives as an indexed topic, not in the data. A subgraph keys the
    ///         entity off it, so a change from indexed to non-indexed would silently break lookups.
    function test_Payload_TokenIsIndexed() public {
        vm.recordLogs();
        vm.prank(creator);
        address token = factory.createLaunch{value: CREATION_FEE}(_params("TOPIC", 100, false));
        Vm.Log[] memory logs = vm.getRecordedLogs();

        Vm.Log memory cfg = _requireLog(logs, LAUNCH_CONFIG_SIG, "LaunchConfig");
        assertEq(cfg.topics.length, 2, "signature plus exactly one indexed field");
        assertEq(address(uint160(uint256(cfg.topics[1]))), token, "topic 1 is the token");
    }

    /// @notice A permanent lock is carried as the flag, and `lockDuration` is emitted alongside it
    ///         rather than zeroed.
    /// @dev Pins the documented contract that consumers branch on `permanentLock` FIRST. If the
    ///      duration were zeroed here, a consumer that read it without checking the flag would
    ///      render "unlocks immediately" for the most locked position the protocol can produce.
    function test_Payload_PermanentLockKeepsItsDuration() public {
        vm.recordLogs();
        vm.prank(creator);
        factory.createLaunch{value: CREATION_FEE}(_params("PERMA", 0, true));
        Vm.Log[] memory logs = vm.getRecordedLogs();

        (, , uint64 lockDuration, , bool permanent) =
            abi.decode(_requireLog(logs, LAUNCH_CONFIG_SIG, "LaunchConfig").data, (uint256, uint64, uint64, uint16, bool));

        assertTrue(permanent, "the permanent flag is carried");
        assertEq(lockDuration, factory.defaultLockDuration(), "and the duration is emitted, not zeroed");
    }

    /// @notice The event reports the values in force AT CREATION, so a launch created before a
    ///         retune keeps its own terms.
    /// @dev The whole governing principle is that every new number is owner-tunable and FUTURE-only.
    ///      An event that re-read current storage would report the new terms for an old launch and
    ///      make the subgraph assert something false about a launch already in flight.
    function test_Payload_IsFrozenPerLaunchAcrossARetune() public {
        vm.recordLogs();
        vm.prank(creator);
        factory.createLaunch{value: CREATION_FEE}(_params("BEFORE", 0, false));
        // ⚠️ `getRecordedLogs` CONSUMES the buffer: a second call returns an empty array, so it has
        // to be captured into a local exactly once per recording.
        Vm.Log[] memory before_ = vm.getRecordedLogs();
        (, uint64 vestingBefore, uint64 lockBefore, uint16 feeBefore,) =
            abi.decode(_requireLog(before_, LAUNCH_CONFIG_SIG, "LaunchConfig").data, (uint256, uint64, uint64, uint16, bool));

        vm.startPrank(owner);
        factory.setLockParams(lockBefore + 90 days, feeBefore == 7000 ? 6000 : 7000);
        factory.setVestingDuration(vestingBefore + 30 days);
        vm.stopPrank();

        vm.recordLogs();
        vm.prank(creator);
        factory.createLaunch{value: CREATION_FEE}(_params("AFTER", 0, false));
        Vm.Log[] memory after_ = vm.getRecordedLogs();
        (, uint64 vestingAfter, uint64 lockAfter, uint16 feeAfter,) =
            abi.decode(_requireLog(after_, LAUNCH_CONFIG_SIG, "LaunchConfig").data, (uint256, uint64, uint64, uint16, bool));

        assertEq(lockAfter, lockBefore + 90 days, "the new launch carries the retuned lock duration");
        assertEq(vestingAfter, vestingBefore + 30 days, "and the retuned vesting duration");
        assertEq(feeAfter, feeBefore == 7000 ? 6000 : 7000, "and the retuned creator fee");
    }
}
