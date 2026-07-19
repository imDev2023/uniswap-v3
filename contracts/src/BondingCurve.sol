// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice A pump.fun-style bonding curve: constant-product with virtual reserves (decision #5).
/// @dev Price follows `x*y=k` over an effective ETH reserve (virtual + real) and token reserve.
///      Buyers pay ETH; a per-curve fee (default 1%) on each buy/sell goes to the treasury. The
///      curve sells up to `curveTokenAllocation` (the 800M allocation); the crossing buy /
///      graduation is wired in Build 05 (#16), so here a buy that would exceed the allocation
///      reverts (`CurveSoldOut`). Reserve math is centralized in `_previewBuy`/`_previewSell` and
///      rounds AGAINST the trader (Uniswap convention) so rounding never favours extraction.
contract BondingCurve is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;

    IERC20 public immutable token;
    address public immutable treasury;
    uint16 public immutable tradeFeeBps;

    uint256 public immutable virtualEthReserve;
    uint256 public immutable virtualTokenReserve;
    uint256 public immutable curveTokenAllocation; // max tokens the curve will ever sell (800M)
    uint256 public immutable k; // invariant: ethReserve * tokenReserve

    // Anti-snipe (decision #7): a per-wallet buy cap that applies only during the early window
    // (while tokensSold < antiSnipeThreshold), then auto-lifts. `purchasedOf` is gross tokens
    // bought during the window and is NOT decremented on sell, so a wallet can't buy-sell-rebuy
    // to dodge the cap. The creator has no exemption — it's enforced on every buyer alike.
    uint256 public immutable maxBuyPerWallet;
    uint256 public immutable antiSnipeThreshold;
    mapping(address => uint256) public purchasedOf;

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
    error NoTokensOut();
    error CurveSoldOut();
    error BuyCapExceeded(uint256 attempted, uint256 cap);
    error SlippageBuy(uint256 tokensOut, uint256 minTokensOut);
    error SlippageSell(uint256 ethOut, uint256 minEthOut);
    error EthTransferFailed();

    constructor(
        IERC20 token_,
        address treasury_,
        uint256 virtualEthReserve_,
        uint256 virtualTokenReserve_,
        uint256 curveTokenAllocation_,
        uint16 tradeFeeBps_,
        uint256 maxBuyPerWallet_,
        uint256 antiSnipeThreshold_
    ) {
        require(address(token_) != address(0) && treasury_ != address(0), "BondingCurve: zero addr");
        require(virtualTokenReserve_ > curveTokenAllocation_, "BondingCurve: bad reserves");
        require(tradeFeeBps_ < BPS, "BondingCurve: bad fee");
        require(maxBuyPerWallet_ > 0, "BondingCurve: bad cap");

        token = token_;
        treasury = treasury_;
        tradeFeeBps = tradeFeeBps_;
        virtualEthReserve = virtualEthReserve_;
        virtualTokenReserve = virtualTokenReserve_;
        curveTokenAllocation = curveTokenAllocation_;
        maxBuyPerWallet = maxBuyPerWallet_;
        antiSnipeThreshold = antiSnipeThreshold_;
        k = virtualEthReserve_ * virtualTokenReserve_;

        ethReserve = virtualEthReserve_;
        tokenReserve = virtualTokenReserve_;
    }

    /// @notice True while the anti-snipe per-wallet cap is in force (early part of the curve).
    function buyCapActive() public view returns (bool) {
        return tokensSold < antiSnipeThreshold;
    }

    /// @notice Current marginal price, ETH per token, scaled by 1e18.
    function priceX18() public view returns (uint256) {
        return (ethReserve * 1e18) / tokenReserve;
    }

    /// @notice Tokens a buyer would receive for `ethIn` (net of fee), at current reserves.
    function quoteBuy(uint256 ethIn) external view returns (uint256 tokensOut, uint256 fee) {
        (tokensOut, fee,,) = _previewBuy(ethIn);
    }

    /// @notice ETH a seller would receive for `tokenAmount` (net of fee), at current reserves.
    function quoteSell(uint256 tokenAmount) external view returns (uint256 ethOut, uint256 fee) {
        (ethOut, fee,,) = _previewSell(tokenAmount);
    }

    /// @notice Buy tokens from the curve with ETH. `minTokensOut` bounds slippage.
    function buy(uint256 minTokensOut) external payable nonReentrant returns (uint256 tokensOut) {
        if (msg.value == 0) revert ZeroAmount();

        uint256 fee;
        uint256 newEthReserve;
        uint256 newTokenReserve;
        (tokensOut, fee, newEthReserve, newTokenReserve) = _previewBuy(msg.value);

        if (tokensOut == 0) revert NoTokensOut();
        if (tokensSold + tokensOut > curveTokenAllocation) revert CurveSoldOut();
        if (tokensOut < minTokensOut) revert SlippageBuy(tokensOut, minTokensOut);

        // Anti-snipe: cap per-wallet accumulation during the early window (decision #7).
        if (buyCapActive()) {
            uint256 purchased = purchasedOf[msg.sender] + tokensOut;
            if (purchased > maxBuyPerWallet) revert BuyCapExceeded(purchased, maxBuyPerWallet);
            purchasedOf[msg.sender] = purchased;
        }

        ethReserve = newEthReserve;
        tokenReserve = newTokenReserve;
        tokensSold += tokensOut;

        _sendEth(treasury, fee);
        token.safeTransfer(msg.sender, tokensOut);

        emit Bought(
            msg.sender, msg.value, msg.value - fee, fee, tokensOut, priceX18(), ethReserve, tokenReserve, tokensSold
        );
    }

    /// @notice Sell tokens back to the curve for ETH. Caller must approve first. `minEthOut` bounds slippage.
    function sell(uint256 tokenAmount, uint256 minEthOut) external nonReentrant returns (uint256 ethOut) {
        if (tokenAmount == 0) revert ZeroAmount();

        token.safeTransferFrom(msg.sender, address(this), tokenAmount);

        uint256 fee;
        uint256 newEthReserve;
        uint256 newTokenReserve;
        (ethOut, fee, newEthReserve, newTokenReserve) = _previewSell(tokenAmount);

        if (ethOut < minEthOut) revert SlippageSell(ethOut, minEthOut);

        ethReserve = newEthReserve;
        tokenReserve = newTokenReserve;
        tokensSold -= tokenAmount;

        _sendEth(treasury, fee);
        _sendEth(msg.sender, ethOut);

        emit Sold(msg.sender, tokenAmount, ethOut, fee, priceX18(), ethReserve, tokenReserve, tokensSold);
    }

    /// @dev Shared buy math. Rounds the new token reserve UP (ceil) so `tokensOut` rounds down —
    ///      against the buyer, never in their favour.
    function _previewBuy(uint256 ethIn)
        internal
        view
        returns (uint256 tokensOut, uint256 fee, uint256 newEthReserve, uint256 newTokenReserve)
    {
        fee = (ethIn * tradeFeeBps) / BPS;
        newEthReserve = ethReserve + (ethIn - fee);
        newTokenReserve = Math.ceilDiv(k, newEthReserve);
        tokensOut = tokenReserve - newTokenReserve;
    }

    /// @dev Shared sell math. Rounds the new ETH reserve UP (ceil) so `grossEthOut` rounds down —
    ///      against the seller, never in their favour.
    function _previewSell(uint256 tokenAmount)
        internal
        view
        returns (uint256 ethOut, uint256 fee, uint256 newEthReserve, uint256 newTokenReserve)
    {
        newTokenReserve = tokenReserve + tokenAmount;
        newEthReserve = Math.ceilDiv(k, newTokenReserve);
        uint256 grossEthOut = ethReserve - newEthReserve;
        fee = (grossEthOut * tradeFeeBps) / BPS;
        ethOut = grossEthOut - fee;
    }

    function _sendEth(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
    }
}
