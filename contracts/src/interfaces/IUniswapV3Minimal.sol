// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

/// @notice Minimal subset of the Uniswap V3 factory interface used by the launchpad.
/// @dev Declared locally so our 0.8.x code never has to compile v3-core's 0.7.6 source.
interface IUniswapV3Factory {
    function owner() external view returns (address);

    function setOwner(address _owner) external;

    function feeAmountTickSpacing(uint24 fee) external view returns (int24);

    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool);

    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

/// @notice Minimal subset of the Uniswap V3 pool interface used by the launchpad.
interface IUniswapV3Pool {
    function initialize(uint160 sqrtPriceX96) external;

    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );

    function token0() external view returns (address);

    function token1() external view returns (address);

    function fee() external view returns (uint24);

    function setFeeProtocol(uint8 feeProtocol0, uint8 feeProtocol1) external;

    /// @notice The pool's oracle observation ring buffer. `blockTimestamp` is the timestamp of the
    ///         last block in which the observation at `index` was written, which is what the LP lock
    ///         reads as the pool's liveness signal (#33).
    /// @dev Read the slot named by `slot0().observationIndex`, never a hardcoded 0: cardinality is 1
    ///      on every pool we create, but `increaseObservationCardinalityNext` is PERMISSIONLESS on any
    ///      V3 pool, so a third party can grow the ring at any time and make slot 0 stale.
    function observations(uint256 index)
        external
        view
        returns (uint32 blockTimestamp, int56 tickCumulative, uint160 secondsPerLiquidityCumulativeX128, bool initialized);

    /// @notice Withdraws accrued protocol fees to `recipient`. Callable only by the factory owner.
    function collectProtocol(address recipient, uint128 amount0Requested, uint128 amount1Requested)
        external
        returns (uint128 amount0, uint128 amount1);
}

/// @notice Minimal subset of the V3 NonfungiblePositionManager used at graduation.
/// @dev The real (unmodified) periphery NPM is deployed from the official artifacts; this
///      local interface just lets our 0.8.x code call it without compiling 0.7.6 source.
interface INonfungiblePositionManager {
    /// @notice Creates the pool for token0/token1/fee if it doesn't exist, then initializes it
    ///         to `sqrtPriceX96`. `token0 < token1` must hold. Returns the pool address.
    function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96)
        external
        payable
        returns (address pool);

    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    /// @notice Mints a new position NFT. Pulls token0/token1 from msg.sender (approve first).
    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    /// @notice Collects accrued trading fees for a position to `recipient`. Callable by the position
    ///         owner or an approved operator; does NOT touch principal liquidity.
    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1);

    /// @notice Reduces a position's liquidity (principal).
    /// @dev ⚠️ Until #33 the LP lock deliberately never called this, and that ABSENCE was the whole
    ///      security claim: principal could not be withdrawn because no code path existed. `reclaim`
    ///      changes that. The guarantee is now CONDITIONAL - enforced by guards in `LPLock.reclaim`
    ///      rather than by the function being unreachable. See the LPLock docstring.
    ///
    ///      ⚠️ This MUST be declared with a struct parameter, not flat arguments. All five members are
    ///      static types, so both forms encode an identical calldata body and differ only in the 4-byte
    ///      selector - `decreaseLiquidity((uint256,uint128,...))` vs `decreaseLiquidity(uint256,...)`.
    ///      The flat form therefore compiles, encodes plausibly, and reverts on the real NPM for the
    ///      one reason a test can least distinguish: the function does not exist. It was declared flat
    ///      from #17 until #33, during which `LpLock.t.sol` asserted "an attacker cannot withdraw
    ///      principal" with a bare `vm.expectRevert()` that was in fact catching this selector miss.
    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    function decreaseLiquidity(DecreaseLiquidityParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1);

    /// @notice Full position state. The LP lock reads `liquidity` to drain a reclaimed position.
    function positions(uint256 tokenId)
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        );

    /// @notice Burns an emptied position NFT. Requires liquidity == 0 and both tokensOwed == 0,
    ///         which `decreaseLiquidity(all)` followed by `collect(max)` guarantees.
    function burn(uint256 tokenId) external payable;

    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @notice Minimal WETH9 surface: deposit wraps native ETH 1:1 into the ERC-20 WETH balance.
interface IWETH9 {
    function deposit() external payable;
}
