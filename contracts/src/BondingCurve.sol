// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice A pump.fun-style bonding curve: constant-product with virtual reserves (decision #5).
/// @dev Price follows `x*y=k` over an effective ETH reserve (virtual + real) and token reserve.
///      Buyers pay ETH; a 1% fee on each buy/sell goes to the treasury. The curve sells up to
///      `curveTokenAllocation` (the 800M allocation); the crossing buy / graduation is wired in
///      Build 05 (#16), so here a buy that would exceed the allocation reverts (`CurveSoldOut`).
///      The curve holds the token allocation to distribute on buys.
contract BondingCurve is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;
    uint16 public constant TRADE_FEE_BPS = 100; // 1%

    IERC20 public immutable token;
    address public immutable treasury;

    uint256 public immutable virtualEthReserve;
    uint256 public immutable virtualTokenReserve;
    uint256 public immutable curveTokenAllocation; // max tokens the curve will ever sell (800M)
    uint256 public immutable k; // invariant: ethReserve * tokenReserve

    // Effective reserves (virtual + real). Start at the virtual values.
    uint256 public ethReserve;
    uint256 public tokenReserve;
    uint256 public tokensSold;

    event Bought(
        address indexed buyer,
        uint256 ethIn,
        uint256 ethToCurve,
        uint256 fee,
        uint256 tokensOut,
        uint256 newPriceX18,
        uint256 ethReserve,
        uint256 tokenReserve,
        uint256 tokensSold
    );
    event Sold(
        address indexed seller,
        uint256 tokensIn,
        uint256 ethOut,
        uint256 fee,
        uint256 newPriceX18,
        uint256 ethReserve,
        uint256 tokenReserve,
        uint256 tokensSold
    );

    error ZeroAmount();
    error CurveSoldOut();
    error SlippageBuy(uint256 tokensOut, uint256 minTokensOut);
    error SlippageSell(uint256 ethOut, uint256 minEthOut);
    error EthTransferFailed();

    constructor(
        IERC20 token_,
        address treasury_,
        uint256 virtualEthReserve_,
        uint256 virtualTokenReserve_,
        uint256 curveTokenAllocation_
    ) {
        require(address(token_) != address(0) && treasury_ != address(0), "BondingCurve: zero addr");
        require(virtualTokenReserve_ > curveTokenAllocation_, "BondingCurve: bad reserves");

        token = token_;
        treasury = treasury_;
        virtualEthReserve = virtualEthReserve_;
        virtualTokenReserve = virtualTokenReserve_;
        curveTokenAllocation = curveTokenAllocation_;
        k = virtualEthReserve_ * virtualTokenReserve_;

        ethReserve = virtualEthReserve_;
        tokenReserve = virtualTokenReserve_;
    }

    /// @notice Current marginal price, ETH per token, scaled by 1e18.
    function priceX18() public view returns (uint256) {
        return (ethReserve * 1e18) / tokenReserve;
    }

    /// @notice Tokens a buyer would receive for `ethIn` (net of fee), at current reserves.
    function quoteBuy(uint256 ethIn) public view returns (uint256 tokensOut, uint256 fee) {
        fee = (ethIn * TRADE_FEE_BPS) / BPS;
        uint256 newEthReserve = ethReserve + (ethIn - fee);
        tokensOut = tokenReserve - (k / newEthReserve);
    }

    /// @notice ETH a seller would receive for `tokenAmount` (net of fee), at current reserves.
    function quoteSell(uint256 tokenAmount) public view returns (uint256 ethOut, uint256 fee) {
        uint256 newTokenReserve = tokenReserve + tokenAmount;
        uint256 grossEthOut = ethReserve - (k / newTokenReserve);
        fee = (grossEthOut * TRADE_FEE_BPS) / BPS;
        ethOut = grossEthOut - fee;
    }

    /// @notice Buy tokens from the curve with ETH. `minTokensOut` bounds slippage.
    function buy(uint256 minTokensOut) external payable nonReentrant returns (uint256 tokensOut) {
        if (msg.value == 0) revert ZeroAmount();

        uint256 fee = (msg.value * TRADE_FEE_BPS) / BPS;
        uint256 ethToCurve = msg.value - fee;
        uint256 newEthReserve = ethReserve + ethToCurve;
        uint256 newTokenReserve = k / newEthReserve;
        tokensOut = tokenReserve - newTokenReserve;

        if (tokensSold + tokensOut > curveTokenAllocation) revert CurveSoldOut();
        if (tokensOut < minTokensOut) revert SlippageBuy(tokensOut, minTokensOut);

        ethReserve = newEthReserve;
        tokenReserve = newTokenReserve;
        tokensSold += tokensOut;

        _sendEth(treasury, fee);
        token.safeTransfer(msg.sender, tokensOut);

        emit Bought(
            msg.sender, msg.value, ethToCurve, fee, tokensOut, priceX18(), ethReserve, tokenReserve, tokensSold
        );
    }

    /// @notice Sell tokens back to the curve for ETH. Caller must approve first. `minEthOut` bounds slippage.
    function sell(uint256 tokenAmount, uint256 minEthOut) external nonReentrant returns (uint256 ethOut) {
        if (tokenAmount == 0) revert ZeroAmount();

        token.safeTransferFrom(msg.sender, address(this), tokenAmount);

        uint256 newTokenReserve = tokenReserve + tokenAmount;
        uint256 newEthReserve = k / newTokenReserve;
        uint256 grossEthOut = ethReserve - newEthReserve;
        uint256 fee = (grossEthOut * TRADE_FEE_BPS) / BPS;
        ethOut = grossEthOut - fee;

        if (ethOut < minEthOut) revert SlippageSell(ethOut, minEthOut);

        ethReserve = newEthReserve;
        tokenReserve = newTokenReserve;
        tokensSold -= tokenAmount;

        _sendEth(treasury, fee);
        _sendEth(msg.sender, ethOut);

        emit Sold(msg.sender, tokenAmount, ethOut, fee, priceX18(), ethReserve, tokenReserve, tokensSold);
    }

    function _sendEth(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
    }
}
