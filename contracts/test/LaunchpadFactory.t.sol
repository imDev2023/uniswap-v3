// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LaunchpadFactory} from "../src/LaunchpadFactory.sol";
import {LaunchToken} from "../src/LaunchToken.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Build 02 (#13): token creation + creation fee.
contract LaunchpadFactoryTest is Test {
    uint256 internal constant FEE = 0.01 ether;
    uint256 internal constant SUPPLY = 1_000_000_000e18;

    LaunchpadFactory internal factory;
    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");
    // Placeholder V3 addresses; these tests never graduate (that path is Graduation.t.sol).
    address internal positionManager = makeAddr("positionManager");
    address internal v3Factory = makeAddr("v3Factory");
    address internal weth9 = makeAddr("weth9");

    /// @dev Metadata URI used by the shared `_create` helper.
    string internal constant URI = "ipfs://QmTestMetadata";

    event LaunchCreated(
        address indexed token,
        address indexed curve,
        address indexed creator,
        string name,
        string symbol,
        string metadataURI,
        uint256 virtualEthReserve,
        uint256 virtualTokenReserve,
        uint256 curveTokenAllocation,
        uint16 tradeFeeBps,
        uint256 maxBuyPerWallet,
        uint256 antiSnipeThreshold
    );

    function setUp() public {
        factory = new LaunchpadFactory(owner, treasury, FEE, positionManager, v3Factory, weth9);
        vm.deal(creator, 100 ether);
    }

    function _create(uint256 value) internal returns (address token) {
        vm.prank(creator);
        token = factory.createLaunch{value: value}("Doge Killer", "DOGEK", "ipfs://QmTestMetadata");
    }

    function test_CreateLaunch_SplitsSupplyCurveAndReserve() public {
        address token = _create(FEE);
        assertEq(LaunchToken(token).TOTAL_SUPPLY(), SUPPLY);
        assertEq(IERC20(token).totalSupply(), SUPPLY, "fixed 1B supply");

        address curve = factory.curveOf(token);
        assertTrue(curve != address(0), "curve deployed");
        assertEq(IERC20(token).balanceOf(curve), factory.CURVE_SUPPLY(), "800M to curve");
        assertEq(
            IERC20(token).balanceOf(address(factory.graduationManager())),
            factory.GRADUATION_RESERVE(),
            "200M reserve escrowed in the GraduationManager"
        );
        assertEq(IERC20(token).balanceOf(address(factory)), 0, "factory holds no tokens after split");
    }

    function test_CreatorGetsNoPreMine() public {
        address token = _create(FEE);
        assertEq(IERC20(token).balanceOf(creator), 0, "fair launch: creator gets no tokens");
    }

    function test_TokenMetadata() public {
        address token = _create(FEE);
        assertEq(LaunchToken(token).name(), "Doge Killer");
        assertEq(LaunchToken(token).symbol(), "DOGEK");
        assertEq(LaunchToken(token).decimals(), 18);
    }

    function test_TokenIsImmutable_NoMintFunction() public {
        address token = _create(FEE);
        // No mint(address,uint256) exists → the call has no matching selector and reverts.
        (bool ok,) = token.call(abi.encodeWithSignature("mint(address,uint256)", creator, 1e18));
        assertFalse(ok, "LaunchToken must have no mint function");
        // Supply is unchanged and can never grow.
        assertEq(IERC20(token).totalSupply(), SUPPLY);
    }

    function test_CreationFee_ForwardedToTreasury() public {
        uint256 before = treasury.balance;
        _create(FEE);
        assertEq(treasury.balance - before, FEE, "fee forwarded to treasury");
    }

    function test_RefundsExcessOverpayment() public {
        uint256 before = creator.balance;
        _create(FEE + 1 ether);
        // Creator pays only the fee; the extra 1 ether is refunded.
        assertEq(before - creator.balance, FEE, "excess refunded");
        assertEq(treasury.balance, FEE);
    }

    function test_RevertOnUnderpay() public {
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(LaunchpadFactory.InsufficientCreationFee.selector, FEE - 1, FEE)
        );
        factory.createLaunch{value: FEE - 1}("X", "X", "ipfs://QmTestMetadata");
    }

    function test_EmitsLaunchCreated() public {
        // NOTE: the `factory.DEFAULT_*()` reads below are external calls, so `vm.prank` must come
        // after them — a prank applies to the very next call and would otherwise be spent on a getter,
        // leaving `createLaunch` to run as the test contract rather than `creator`.
        vm.expectEmit(false, false, true, true);
        emit LaunchCreated(
            address(0),
            address(0),
            creator,
            "Doge Killer",
            "DOGEK",
            URI,
            factory.DEFAULT_VIRTUAL_ETH_RESERVE(),
            factory.DEFAULT_VIRTUAL_TOKEN_RESERVE(),
            factory.CURVE_SUPPLY(),
            factory.DEFAULT_TRADE_FEE_BPS(),
            factory.DEFAULT_MAX_BUY_PER_WALLET(),
            factory.DEFAULT_ANTI_SNIPE_THRESHOLD()
        );
        vm.prank(creator);
        factory.createLaunch{value: FEE}("Doge Killer", "DOGEK", URI);
    }

    function test_Registry_TracksLaunches() public {
        address t1 = _create(FEE);
        address t2 = _create(FEE);
        assertEq(factory.launchCount(), 2);
        assertEq(factory.launches(0), t1);
        assertEq(factory.launches(1), t2);
        assertEq(factory.creatorOf(t1), creator);
        assertEq(factory.creatorOf(t2), creator);
    }

    function test_SetCreationFee_OnlyOwner() public {
        vm.prank(owner);
        factory.setCreationFee(0.02 ether);
        assertEq(factory.creationFee(), 0.02 ether);

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, creator));
        factory.setCreationFee(0);
    }

    function test_SetTreasury_OnlyOwner() public {
        address newTreasury = makeAddr("newTreasury");
        vm.prank(owner);
        factory.setTreasury(newTreasury);
        assertEq(factory.treasury(), newTreasury);

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, creator));
        factory.setTreasury(creator);
    }

    function test_FreeCreation_WhenFeeZero() public {
        LaunchpadFactory freeFactory = new LaunchpadFactory(owner, treasury, 0, positionManager, v3Factory, weth9);
        vm.prank(creator);
        address token = freeFactory.createLaunch{value: 0}("Free", "FREE", "ipfs://QmTestMetadata");
        assertEq(IERC20(token).totalSupply(), SUPPLY);
    }

    /// @notice AC5: a *fork* test asserting supply, immutability, fee transfer, and event
    ///         — proves a launch behaves against real Robinhood Chain (4663) state.
    function test_CreateLaunch_OnRobinhoodFork() public {
        vm.createSelectFork("robinhood");
        assertEq(block.chainid, 4663);

        LaunchpadFactory forkFactory = new LaunchpadFactory(owner, treasury, FEE, positionManager, v3Factory, weth9);
        address forkCreator = makeAddr("forkCreator");
        vm.deal(forkCreator, 1 ether);
        uint256 treasuryBefore = treasury.balance;

        // As above: the `forkFactory.DEFAULT_*()` reads are external calls, so the prank goes last.
        vm.expectEmit(false, false, true, true, address(forkFactory)); // event
        emit LaunchCreated(
            address(0),
            address(0),
            forkCreator,
            "Fork Coin",
            "FORK",
            URI,
            forkFactory.DEFAULT_VIRTUAL_ETH_RESERVE(),
            forkFactory.DEFAULT_VIRTUAL_TOKEN_RESERVE(),
            forkFactory.CURVE_SUPPLY(),
            forkFactory.DEFAULT_TRADE_FEE_BPS(),
            forkFactory.DEFAULT_MAX_BUY_PER_WALLET(),
            forkFactory.DEFAULT_ANTI_SNIPE_THRESHOLD()
        );
        vm.prank(forkCreator);
        address token = forkFactory.createLaunch{value: FEE}("Fork Coin", "FORK", URI);

        assertEq(IERC20(token).totalSupply(), SUPPLY, "supply"); // supply
        (bool ok,) = token.call(abi.encodeWithSignature("mint(address,uint256)", forkCreator, 1e18));
        assertFalse(ok, "immutability: no mint"); // immutability
        assertEq(treasury.balance - treasuryBefore, FEE, "fee transfer"); // fee transfer
    }
}
