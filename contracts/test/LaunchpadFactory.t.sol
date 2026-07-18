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

    event LaunchCreated(address indexed token, address indexed creator, string name, string symbol);

    function setUp() public {
        factory = new LaunchpadFactory(owner, treasury, FEE);
        vm.deal(creator, 100 ether);
    }

    function _create(uint256 value) internal returns (address token) {
        vm.prank(creator);
        token = factory.createLaunch{value: value}("Doge Killer", "DOGEK");
    }

    function test_CreateLaunch_MintsFixedSupplyToFactory() public {
        address token = _create(FEE);
        assertEq(LaunchToken(token).TOTAL_SUPPLY(), SUPPLY);
        assertEq(IERC20(token).totalSupply(), SUPPLY, "fixed 1B supply");
        assertEq(IERC20(token).balanceOf(address(factory)), SUPPLY, "supply held by factory (custodian)");
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
            abi.encodeWithSelector(LaunchpadFactory.IncorrectCreationFee.selector, FEE - 1, FEE)
        );
        factory.createLaunch{value: FEE - 1}("X", "X");
    }

    function test_EmitsLaunchCreated() public {
        vm.prank(creator);
        vm.expectEmit(false, true, false, true);
        emit LaunchCreated(address(0), creator, "Doge Killer", "DOGEK");
        factory.createLaunch{value: FEE}("Doge Killer", "DOGEK");
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
        LaunchpadFactory freeFactory = new LaunchpadFactory(owner, treasury, 0);
        vm.prank(creator);
        address token = freeFactory.createLaunch{value: 0}("Free", "FREE");
        assertEq(IERC20(token).totalSupply(), SUPPLY);
    }
}
