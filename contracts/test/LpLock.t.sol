// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CurveDriver} from "./CurveDriver.sol";
import {V3Deployer} from "../src/periphery/V3Deployer.sol";
import {LaunchpadFactory, LaunchParams} from "../src/LaunchpadFactory.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {GraduationManager} from "../src/periphery/GraduationManager.sol";
import {LPLock} from "../src/periphery/LPLock.sol";
import {ForkConfig} from "./ForkConfig.sol";
import {
    IUniswapV3Factory,
    IUniswapV3Pool,
    INonfungiblePositionManager,
    IWETH9
} from "../src/interfaces/IUniswapV3Minimal.sol";
import {Constants} from "../src/Constants.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @dev Minimal SwapRouter surface used to generate real swap volume (and thus fees) on the pool.
interface ISwapRouter {
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

/// @notice Build 06 (#17): permanent LP lock + fee routing + protocol fee switch. On a real Robinhood
///         Chain (4663) fork with our own V3 deploy, graduate a token, then prove: the position NFT is
///         locked in `LPLock` forever (principal unwithdrawable and NFT unmovable by anyone), the pool's
///         protocol fee switch is on, and BOTH the locked position's trading fees and the pool's
///         protocol fees are collectable — always to the treasury.
contract LpLockTest is Test, V3Deployer, CurveDriver {
    uint24 internal constant FEE_TIER = 10000;

    LaunchpadFactory internal factory;
    GraduationManager internal gm;
    LPLock internal lock;
    IUniswapV3Factory internal v3Factory;
    address internal positionManager;
    address internal router;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal whale = makeAddr("whale");
    address internal trader = makeAddr("trader");
    address internal attacker = makeAddr("attacker");

    function setUp() public {
        vm.createSelectFork(ForkConfig.MAINNET, ForkConfig.MAINNET_BLOCK);
        v3Factory = IUniswapV3Factory(deployV3Factory());
        router = deploySwapRouter(address(v3Factory), Constants.WETH9);
        positionManager = deployPositionManager(address(v3Factory), Constants.WETH9, address(0xDEAD));
        factory = new LaunchpadFactory(owner, treasury, 0, positionManager, address(v3Factory), Constants.WETH9);
        gm = factory.graduationManager();
        lock = factory.lpLock();
        // Hand the V3 factory to the launchpad so it can drive the protocol fee switch (decision #9).
        v3Factory.setOwner(address(factory));
    }

    /// @dev Create a launch and graduate it (fill through the anti-snipe window, then cross).
    function _graduate() internal returns (address token, address pool, uint256 tokenId) {
        token = factory.createLaunch(LaunchParams("Locked", "LOCK", "ipfs://QmTestMetadata", false, 0));
        BondingCurve curve = BondingCurve(factory.curveOf(token));
        _liftAntiSnipe(curve, "lp");
        vm.deal(whale, 500 ether);
        vm.prank(whale);
        curve.buy{value: 300 ether}(0); // crossing buy graduates atomically
        pool = gm.poolOf(token);
        tokenId = gm.tokenIdOf(token);
    }

    function _swap(address tokenIn, address tokenOut, uint256 amountIn) internal returns (uint256 out) {
        IERC20(tokenIn).approve(router, amountIn);
        out = ISwapRouter(router).exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: FEE_TIER,
                recipient: trader,
                deadline: block.timestamp,
                amountIn: amountIn,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
    }

    function test_PositionLockedForever_AndFeesRouteToTreasury() public {
        (address token, address pool, uint256 tokenId) = _graduate();

        // --- Position NFT minted into the lock; it is the owner ---
        assertEq(IERC721(positionManager).ownerOf(tokenId), address(lock), "position owned by the lock");

        // --- Principal is unwithdrawable and the NFT is unmovable, by ANYONE, forever ---
        // ⚠️ This must revert because the attacker is NOT AUTHORIZED, not because the call is
        // malformed. Until #33 this interface declared `decreaseLiquidity` with flat arguments rather
        // than the NPM's struct, so the selector did not exist and a bare `vm.expectRevert()` passed
        // for a reason that had nothing to do with the lock. The assertion is now pinned to the NPM's
        // actual authorization message, which a selector miss cannot produce.
        vm.prank(attacker);
        vm.expectRevert(bytes("Not approved"));
        INonfungiblePositionManager(positionManager).decreaseLiquidity(
            INonfungiblePositionManager.DecreaseLiquidityParams({
                tokenId: tokenId,
                liquidity: 1,
                amount0Min: 0,
                amount1Min: 0,
                deadline: block.timestamp
            })
        );

        vm.prank(attacker);
        vm.expectRevert();
        IERC721(positionManager).transferFrom(address(lock), attacker, tokenId);

        assertEq(IERC721(positionManager).ownerOf(tokenId), address(lock), "still locked after attack attempts");

        // --- Protocol fee switch was enabled at graduation ---
        (,,,,, uint8 feeProtocol,) = IUniswapV3Pool(pool).slot0();
        assertTrue(feeProtocol != 0, "protocol fee switched on at graduation");

        // --- Generate real swap volume both ways so fees accrue in both tokens ---
        vm.deal(trader, 50 ether);
        vm.startPrank(trader);
        IWETH9(Constants.WETH9).deposit{value: 20 ether}();
        uint256 tokenOut = _swap(Constants.WETH9, token, 15 ether);
        _swap(token, Constants.WETH9, tokenOut);
        vm.stopPrank();

        // --- Locked position's trading fees collect to the treasury (principal untouched) ---
        uint256 tTokBefore = IERC20(token).balanceOf(treasury);
        uint256 tWethBefore = IERC20(Constants.WETH9).balanceOf(treasury);
        lock.collect(tokenId);
        assertGt(IERC20(Constants.WETH9).balanceOf(treasury) - tWethBefore, 0, "WETH LP fees routed to treasury");
        assertGt(IERC20(token).balanceOf(treasury) - tTokBefore, 0, "token LP fees routed to treasury");

        // --- Pool's protocol fees collect to the treasury ---
        uint256 pTokBefore = IERC20(token).balanceOf(treasury);
        uint256 pWethBefore = IERC20(Constants.WETH9).balanceOf(treasury);
        factory.collectProtocolFees(pool);
        uint256 protoTotal = (IERC20(Constants.WETH9).balanceOf(treasury) - pWethBefore)
            + (IERC20(token).balanceOf(treasury) - pTokBefore);
        assertGt(protoTotal, 0, "protocol swap fees routed to treasury");

        // --- Everything above happened without ever unlocking the position ---
        assertEq(IERC721(positionManager).ownerOf(tokenId), address(lock), "still locked after fee collection");
    }
}
