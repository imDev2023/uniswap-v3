// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {INonfungiblePositionManager, IWETH9} from "../interfaces/IUniswapV3Minimal.sol";
import {Constants} from "../Constants.sol";

interface ILaunchpad {
    function curveOf(address token) external view returns (address);
    function GRADUATION_RESERVE() external view returns (uint256);
    function applyProtocolFee(address pool) external;
    /// @dev Lock terms frozen into this launch at `createLaunch`. Read at graduation, but chosen (and
    ///      immutable) from creation, so a trader buying the curve can read the exact terms the LP will
    ///      graduate under, and a later owner retune cannot change them under an in-flight launch.
    function lockConfigOf(address token) external view returns (uint64 lockDuration, uint16 creatorFeeBps, bool permanent);
}

interface ILPLock {
    function registerLock(uint256 tokenId, address launchToken, address pool, uint64 lockUntil, uint16 creatorFeeBps)
        external;
}

/// @notice Executes the atomic migration from bonding curve to a seeded, full-range V3 pool
///         (decision #6). Called in-line by a token's `BondingCurve` on the threshold-crossing
///         buy: it wraps the raised ETH, creates + initializes the `TOKEN/WETH` 1% pool at the
///         curve's final price, and mints a **full-range** position with the 200M reserved tokens
///         + 100% of the raised ETH. Price continuity is structural: the pool is initialized at the
///         exact ratio of the two seeded amounts, which the curve's calibration makes equal to its
///         final marginal price (see `LaunchpadFactory.DEFAULT_VIRTUAL_TOKEN_RESERVE`).
/// @dev The 200M reserve is escrowed here (transferred by the factory at launch creation); the seed
///      amount is the factory's fixed GRADUATION_RESERVE constant, not this contract's live balance,
///      so donated tokens can't skew the seed price. The position NFT is minted straight into the
///      permanent LPLock, and the pool's protocol fee is switched on at graduation (#17).
contract GraduationManager is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Graduated pools use the 1.00% fee tier (decision #6).
    uint24 public constant POOL_FEE = Constants.POOL_FEE_TIER;

    /// @dev Full-range ticks for the 1% tier's 200 tick-spacing: the min/max usable ticks
    ///      (±887272) snapped inward to a multiple of 200.
    int24 internal constant MIN_TICK = -887200;
    int24 internal constant MAX_TICK = 887200;

    /// @notice The launchpad factory; the only source of authorized curves.
    address public immutable launchpad;
    INonfungiblePositionManager public immutable positionManager;
    address public immutable weth9;
    /// @notice The lock that receives every graduated position NFT (#17).
    address public immutable lpLock;

    /// @dev Mirror of `LPLock.PERMANENT`, inlined rather than fetched so registering a lock does not
    ///      pay an external call to read a compile-time constant. `LockReclaim.t.sol` pins the two
    ///      together so they cannot drift apart silently.
    uint64 internal constant PERMANENT_SENTINEL = type(uint64).max;

    /// @notice token => whether it has already graduated.
    mapping(address => bool) public graduated;
    /// @notice token => the V3 pool it graduated into.
    mapping(address => address) public poolOf;
    /// @notice token => the locked position NFT id it graduated into.
    mapping(address => uint256) public tokenIdOf;

    event Graduated(
        address indexed token,
        address indexed pool,
        uint256 tokenId,
        uint256 tokensSeeded,
        uint256 wethSeeded,
        uint160 sqrtPriceX96
    );

    error NotCurve();
    error AlreadyGraduated();
    error NothingToSeed();

    constructor(address launchpad_, address positionManager_, address weth9_, address lpLock_) {
        require(
            launchpad_ != address(0) && positionManager_ != address(0) && weth9_ != address(0)
                && lpLock_ != address(0),
            "GraduationManager: zero addr"
        );
        launchpad = launchpad_;
        positionManager = INonfungiblePositionManager(positionManager_);
        weth9 = weth9_;
        lpLock = lpLock_;
    }

    /// @notice Migrate `token` into a seeded, full-range `TOKEN/WETH` V3 pool. Callable only by the
    ///         token's own bonding curve, which forwards 100% of the raised ETH as `msg.value`.
    /// @return pool The created/initialized V3 pool.
    function graduate(address token) external payable nonReentrant returns (address pool) {
        if (msg.sender != ILaunchpad(launchpad).curveOf(token)) revert NotCurve();
        if (graduated[token]) revert AlreadyGraduated();

        uint256 wethAmount = msg.value;
        // Seed exactly the escrowed reserve (a factory constant), NOT balanceOf: tokens donated to
        // this contract must not inflate the seed and skew the pool's initial price. Any donated
        // surplus stays here as dust.
        uint256 tokenAmount = ILaunchpad(launchpad).GRADUATION_RESERVE();
        if (wethAmount == 0 || tokenAmount == 0) revert NothingToSeed();

        graduated[token] = true;

        // Wrap the raised ETH so the pool is a standard TOKEN/WETH ERC-20 pair.
        IWETH9(weth9).deposit{value: wethAmount}();

        // V3 requires token0 < token1; order the seeded amounts to match.
        (address token0, address token1, uint256 amount0, uint256 amount1) = token < weth9
            ? (token, weth9, tokenAmount, wethAmount)
            : (weth9, token, wethAmount, tokenAmount);

        // Initialize at the exact ratio of the seeded amounts => pool price == curve final price.
        // sqrtPriceX96 = sqrt(amount1/amount0) * 2**96; mulDiv avoids the 2**192 intermediate overflow.
        uint160 sqrtPriceX96 = uint160(Math.sqrt(Math.mulDiv(amount1, 1 << 192, amount0)));

        pool = positionManager.createAndInitializePoolIfNecessary(token0, token1, POOL_FEE, sqrtPriceX96);
        poolOf[token] = pool;

        IERC20(token0).forceApprove(address(positionManager), amount0);
        IERC20(token1).forceApprove(address(positionManager), amount1);

        (uint256 tokenId,,,) = positionManager.mint(
            INonfungiblePositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: POOL_FEE,
                tickLower: MIN_TICK,
                tickUpper: MAX_TICK,
                amount0Desired: amount0,
                amount1Desired: amount1,
                amount0Min: 0,
                amount1Min: 0,
                recipient: lpLock, // minted straight into the permanent lock (#17)
                deadline: block.timestamp
            })
        );
        tokenIdOf[token] = tokenId;

        // Record the lock's terms (#33). The NFT arrives in LPLock via a bare NPM mint, which tells it
        // nothing, so this call is the only way it learns the position exists or what terms bind it.
        // Split out to keep `graduate` inside the EVM's reachable stack.
        _registerLock(token, pool, tokenId);

        // Switch on the pool's protocol fee. Best-effort: the factory only acts if it owns the V3
        // factory, so a fee-switch misconfiguration can never brick a graduation.
        ILaunchpad(launchpad).applyProtocolFee(pool);

        emit Graduated(token, pool, tokenId, tokenAmount, wethAmount, sqrtPriceX96);
    }

    /// @dev Turn this launch's frozen lock config into a concrete expiry and hand it to the lock.
    ///      The duration is measured from GRADUATION, not from creation: a launch that sits on the
    ///      curve for months should still get its full lock once it has a pool to lock.
    function _registerLock(address token, address pool, uint256 tokenId) private {
        (uint64 lockDuration, uint16 creatorFeeBps, bool permanent) = ILaunchpad(launchpad).lockConfigOf(token);
        // The factory clamps `lockDuration` to [MIN_LOCK_DURATION, MAX_LOCK_DURATION] (100 years), so
        // this checked addition cannot overflow and cannot land on the PERMANENT sentinel. That clamp
        // is what makes this line safe; it is not a free-standing assumption.
        uint64 lockUntil = permanent ? PERMANENT_SENTINEL : uint64(block.timestamp) + lockDuration;
        ILPLock(lpLock).registerLock(tokenId, token, pool, lockUntil, creatorFeeBps);
    }
}
