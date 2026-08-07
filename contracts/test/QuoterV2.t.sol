// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {V3Deployer} from "../src/periphery/V3Deployer.sol";
import {IUniswapV3Factory, IUniswapV3Pool, IWETH9} from "../src/interfaces/IUniswapV3Minimal.sol";
import {Constants} from "../src/Constants.sol";
import {ForkConfig} from "./ForkConfig.sol";

interface IQuoterV2 {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external
        returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate);

    function factory() external view returns (address);
    function WETH9() external view returns (address);
}

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

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/// @notice Proves the `QuoterV2` we deploy (`DeployQuoter.s.sol`) returns the amount a swap through
///         our own live `SwapRouter` ACTUALLY produces — the property the swap page (#21) needs in
///         order to replace its `slot0` spot-price estimate with a real quote.
///
/// @dev Forks **testnet 46630** at a pinned block and runs against the genuinely deployed stack from
///      `docs/deployments-testnet.md` — the real V3 factory, the real graduated `GRAD/WETH` pool and
///      the real router — rather than a freshly seeded local pool. That is the point: a spot-price
///      estimate and a quoter agree on a pristine pool and diverge on a real one with fees and
///      price impact, so only a live pool tests the thing that was broken.
contract QuoterV2ForkTest is Test, V3Deployer {
    // Live testnet deployment (docs/deployments-testnet.md).
    address internal constant V3_FACTORY = 0x808088B7949877b0eF9CC514627426505CF069bA;
    address internal constant SWAP_ROUTER = 0x7a9232B5af20635AbC85c5f854648E916B3b8826;
    address internal constant WETH9_TESTNET = 0x7943e237c7F95DA44E0301572D358911207852Fa;
    address internal constant GRAD_TOKEN = 0x1bfb12f7BE47CB8c485A1193551E25D99Dca9375;
    address internal constant GRAD_POOL = 0x4eB4cA4260cBcBF015740Fa0e2259f82A6fd9cF7;

    IQuoterV2 internal quoter;

    /// @dev Pinned, like every other fork test - see `ForkConfig`. This test used to read the head
    ///      at run time and fork 300 blocks back, because the public endpoint prunes state after
    ///      ~5,600 blocks and a pinned constant fell out of that window within the hour. Forking
    ///      from an archive endpoint removes the constraint, and with it a test whose subject
    ///      changed every time it ran: the pool's price, liquidity and fee growth are now fixed
    ///      inputs, so a failure here means our quoter disagreed with our router, which is the only
    ///      thing this test is entitled to claim.
    function setUp() public {
        vm.createSelectFork(ForkConfig.TESTNET, ForkConfig.TESTNET_BLOCK);
        quoter = IQuoterV2(deployQuoterV2(V3_FACTORY, WETH9_TESTNET));
    }

    function test_ForkIsTestnet_AndLiveStackIsPresent() public view {
        assertEq(block.chainid, Constants.CHAIN_ID_TESTNET, "fork should be chain 46630");
        assertGt(V3_FACTORY.code.length, 0, "live V3 factory must have code");
        assertGt(SWAP_ROUTER.code.length, 0, "live SwapRouter must have code");
        assertGt(GRAD_POOL.code.length, 0, "graduated pool must have code");
        // The pool the launchpad actually registered for GRAD/WETH at the 1% tier.
        assertEq(
            IUniswapV3Factory(V3_FACTORY).getPool(GRAD_TOKEN, WETH9_TESTNET, Constants.POOL_FEE_TIER),
            GRAD_POOL,
            "graduated pool should resolve from the live factory"
        );
    }

    function test_QuoterIsBoundToOurStack() public view {
        assertEq(quoter.factory(), V3_FACTORY, "quoter must point at OUR V3 factory");
        assertEq(quoter.WETH9(), WETH9_TESTNET, "quoter must use the per-chain testnet WETH9");
    }

    /// @dev The property the UI depends on: quote == execution, exactly.
    function test_QuoteMatchesActualSwap_EthToToken() public {
        uint256 amountIn = 0.01 ether;

        uint256 quoted = _quote(WETH9_TESTNET, GRAD_TOKEN, amountIn);
        assertGt(quoted, 0, "quote should be non-zero");

        uint256 actual = _swap(WETH9_TESTNET, GRAD_TOKEN, amountIn);
        assertEq(actual, quoted, "QuoterV2 must predict the swap output exactly");
    }

    function test_QuoteMatchesActualSwap_TokenToEth() public {
        uint256 amountIn = 1_000_000e18;

        uint256 quoted = _quote(GRAD_TOKEN, WETH9_TESTNET, amountIn);
        assertGt(quoted, 0, "quote should be non-zero");

        uint256 actual = _swap(GRAD_TOKEN, WETH9_TESTNET, amountIn);
        assertEq(actual, quoted, "QuoterV2 must predict the swap output exactly");
    }

    /// @dev Why the quoter is worth deploying at all: on a real pool the `slot0` spot estimate the
    ///      swap page currently shows is measurably optimistic, because it accounts for neither the
    ///      1% fee nor price impact. This pins that the two genuinely disagree.
    function test_SpotPriceEstimateOverstatesOutput_VersusQuoter() public {
        uint256 amountIn = 0.05 ether;

        uint256 quoted = _quote(WETH9_TESTNET, GRAD_TOKEN, amountIn);

        // The frontend's estimate: amountOut ≈ amountIn * spotPrice, from slot0.
        (uint160 sqrtPriceX96,,,,,,) = IUniswapV3Pool(GRAD_POOL).slot0();
        bool wethIsToken0 = IUniswapV3Pool(GRAD_POOL).token0() == WETH9_TESTNET;
        // price(token1 per token0) = (sqrtP / 2^96)^2, computed in 1e18 fixed point.
        uint256 priceX18 = FullMathLite.mulDiv(uint256(sqrtPriceX96) * uint256(sqrtPriceX96), 1e18, 1 << 192);
        uint256 spotEstimate =
            wethIsToken0 ? (amountIn * priceX18) / 1e18 : (amountIn * 1e18) / (priceX18 == 0 ? 1 : priceX18);

        assertGt(spotEstimate, quoted, "spot estimate should overstate output vs a real quote");
        // Sanity: the same order of magnitude, i.e. we computed the estimate correctly rather than
        // comparing against nonsense. Fee (1%) + impact should be a single-digit-percent gap here.
        assertLt(spotEstimate - quoted, spotEstimate / 5, "gap should be a few percent, not 20%+");
    }

    // --- helpers ---

    function _quote(address tokenIn, address tokenOut, uint256 amountIn) internal returns (uint256 amountOut) {
        (amountOut,,,) = quoter.quoteExactInputSingle(
            IQuoterV2.QuoteExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                amountIn: amountIn,
                fee: Constants.POOL_FEE_TIER,
                sqrtPriceLimitX96: 0
            })
        );
    }

    /// @dev Executes the same swap through the live router and returns what the recipient received.
    function _swap(address tokenIn, address tokenOut, uint256 amountIn) internal returns (uint256 received) {
        address trader = address(this);

        if (tokenIn == WETH9_TESTNET) {
            vm.deal(trader, amountIn);
            IWETH9(WETH9_TESTNET).deposit{value: amountIn}();
        } else {
            // Take the tokens from the pool's own balance holder is not possible; mint via storage.
            deal(tokenIn, trader, amountIn, true);
        }
        IERC20(tokenIn).approve(SWAP_ROUTER, amountIn);

        uint256 before = IERC20(tokenOut).balanceOf(trader);
        ISwapRouter(SWAP_ROUTER)
            .exactInputSingle(
                ISwapRouter.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: Constants.POOL_FEE_TIER,
                recipient: trader,
                deadline: block.timestamp + 300,
                amountIn: amountIn,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
            );
        received = IERC20(tokenOut).balanceOf(trader) - before;
    }
}

/// @dev Minimal 512-bit mulDiv so the spot-price comparison above can't overflow.
library FullMathLite {
    function mulDiv(uint256 a, uint256 b, uint256 denominator) internal pure returns (uint256) {
        unchecked {
            // a is already a product of two uint160s (<= 2^320) in our caller, so do it in two steps
            // against the 2^192 denominator rather than risking a single overflowing multiply.
            //
            // ⚠️ Suppressed because the lint has the shape right and the intent backwards. Dividing
            // first is normally precision loss; here it is the standard full-precision decomposition,
            // and the `(a % denominator) * b / denominator` term is exactly the remainder the first
            // division dropped being added back. Multiplying first is what this cannot do: `a * b`
            // overflows 256 bits for the inputs the caller passes. Nothing is lost beyond the single
            // truncation the final division makes anyway.
            // forge-lint: disable-next-line(divide-before-multiply)
            return (a / denominator) * b + ((a % denominator) * b) / denominator;
        }
    }
}
