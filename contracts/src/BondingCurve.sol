// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IGraduationManager {
    function graduate(address token) external payable returns (address pool);
}

/// @notice Deploy-time configuration for a bonding curve. Prefactored into a struct (from the
///         #15 review) now that graduation wiring has grown the parameter list.
struct CurveConfig {
    IERC20 token;
    address treasury;
    address graduationManager; // executes atomic graduation on the crossing buy (#16)
    uint256 virtualEthReserve;
    uint256 virtualTokenReserve;
    uint256 curveTokenAllocation; // max tokens the curve will ever sell (800M)
    uint16 tradeFeeBps;
    uint256 maxBuyPerWallet; // anti-snipe per-wallet cap (decision #7)
    uint256 antiSnipeThreshold; // tokensSold level at which the cap auto-lifts
}

/// @notice A pump.fun-style bonding curve: constant-product with virtual reserves (decision #5).
/// @dev Price follows `x*y=k` over an effective ETH reserve (virtual + real) and token reserve.
///      Buyers pay ETH; a per-curve fee (default 1%) on each buy/sell goes to the treasury. The
///      curve sells up to `curveTokenAllocation` (the 800M allocation). The buy that would complete
///      the allocation is the **graduation trigger** (decision #6): it is capped at exactly the
///      remaining allocation, any ETH overflow is refunded, and the curve hands 100% of the raised
///      ETH to the `GraduationManager`, which atomically seeds a locked full-range V3 pool — all in
///      the same transaction. After that the curve is permanently disabled. Reserve math is
///      centralized in `_previewBuy`/`_previewSell` and rounds AGAINST the trader (Uniswap
///      convention) so rounding never favours extraction.
contract BondingCurve is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;

    IERC20 public immutable token;
    address public immutable treasury;
    address public immutable graduationManager;
    uint16 public immutable tradeFeeBps;

    uint256 public immutable virtualEthReserve;
    uint256 public immutable virtualTokenReserve;
    uint256 public immutable curveTokenAllocation; // max tokens the curve will ever sell (800M)
    uint256 public immutable k; // invariant: ethReserve * tokenReserve

    // Precomputed final reserves at sellout (when tokensSold == curveTokenAllocation). The crossing
    // buy drives the reserves to exactly these values, so the raised ETH and final price are
    // deterministic and the graduation seed is calibrated.
    uint256 public immutable finalTokenReserve; // = virtualTokenReserve - curveTokenAllocation
    uint256 public immutable finalEthReserve; // = ceil(k / finalTokenReserve)

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

    /// @notice True once the curve has graduated. All buys/sells revert afterward.
    bool public graduated;

    /// @dev `token` is indexed (build #24) even though it is constant for a given curve, and is
    ///      therefore redundant for anyone already filtering by this curve's address. It is here for
    ///      consumers who are NOT: curve addresses are only discoverable from `LaunchCreated`, so
    ///      without this topic a global "live trades across all launches" feed is impossible over
    ///      plain `eth_getLogs` — you would have to enumerate every curve first and then filter by
    ///      N addresses. With it, one filter on `Bought`/`Sold` covers every launch, forever,
    ///      including launches that do not exist yet. That is what lets the app read trades straight
    ///      from an RPC node instead of depending on the indexer being up.
    event Bought(
        address indexed token,
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
    /// @dev See `Bought` for why `token` is indexed.
    event Sold(
        address indexed token,
        address indexed seller,
        uint256 tokensIn,
        uint256 ethOut,
        uint256 fee,
        uint256 newPriceX18,
        uint256 ethReserve,
        uint256 tokenReserve,
        uint256 tokensSold
    );
    /// @notice Emitted on the crossing buy, once the curve has handed off to the GraduationManager.
    event Graduation(address indexed pool, uint256 raisedEth);

    error ZeroAmount();
    error NoTokensOut();
    error CurveSoldOut();
    error AlreadyGraduated();
    error BuyCapExceeded(uint256 attempted, uint256 cap);
    error SlippageBuy(uint256 tokensOut, uint256 minTokensOut);
    error SlippageSell(uint256 ethOut, uint256 minEthOut);
    error EthTransferFailed();

    constructor(CurveConfig memory cfg) {
        require(
            address(cfg.token) != address(0) && cfg.treasury != address(0) && cfg.graduationManager != address(0),
            "BondingCurve: zero addr"
        );
        require(cfg.virtualTokenReserve > cfg.curveTokenAllocation, "BondingCurve: bad reserves");
        require(cfg.tradeFeeBps < BPS, "BondingCurve: bad fee");
        require(cfg.maxBuyPerWallet > 0, "BondingCurve: bad cap");

        token = cfg.token;
        treasury = cfg.treasury;
        graduationManager = cfg.graduationManager;
        tradeFeeBps = cfg.tradeFeeBps;
        virtualEthReserve = cfg.virtualEthReserve;
        virtualTokenReserve = cfg.virtualTokenReserve;
        curveTokenAllocation = cfg.curveTokenAllocation;
        maxBuyPerWallet = cfg.maxBuyPerWallet;
        antiSnipeThreshold = cfg.antiSnipeThreshold;
        k = cfg.virtualEthReserve * cfg.virtualTokenReserve;

        finalTokenReserve = cfg.virtualTokenReserve - cfg.curveTokenAllocation;
        finalEthReserve = Math.ceilDiv(k, finalTokenReserve);

        ethReserve = cfg.virtualEthReserve;
        tokenReserve = cfg.virtualTokenReserve;
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

    /// @notice Buy tokens from the curve with ETH. `minTokensOut` bounds slippage. A buy that
    ///         completes the 800M allocation triggers atomic graduation and refunds ETH overflow.
    // ⚠️ `reentrancy-eth` is reported here and is a false positive with a real shape behind it.
    // Slither sees state written after `.call`s: `_graduate()` runs last and sets `graduated`. Three
    // things make it unreachable. `buy` is `nonReentrant`, so a re-entrant call reverts at the
    // modifier. `_graduate` sets `graduated = true` BEFORE its own external call, so even a path that
    // bypassed the guard finds the curve already closed. And every reserve write above happens before
    // any transfer. The finding is kept visible rather than silenced globally because the ordering it
    // points at is exactly what must not be rearranged. Verified by mutation in `SameBlockRaces.t.sol`.
    //
    // ⚠️ `disable-START`, not `disable-next-line`, and the difference is not cosmetic. A
    // `-next-line` directive applies to the LITERAL next line, and the solhint suppression below has
    // to occupy that slot for its own rule. #40 shipped both as `-next-line` for several hours: the
    // solhint comment block landed between slither's directive and the function, slither's
    // suppression silently applied to a comment, the High-impact finding came back, and the evidence
    // recorded in `.evm-standards.json` said "clean" about a run that exits 255. Found by review, not
    // by the run that recorded it. Two suppressions on one declaration need a block, not a race for
    // the adjacent line.
    // slither-disable-start reentrancy-eth
    // ⚠️ Over the line length and complexity limits on purpose, and splitting it is not free. `buy`
    // carries the crossing-buy branch, the anti-snipe window and the graduation hand-off, and every
    // one of those reads state the others write. `LaunchpadFactory._emitLaunchCreated` exists solely
    // because inlining it overflowed the EVM's 16-slot reachable stack; carving helpers out of this
    // function invites the same failure, and `viaIR` was rejected as too disruptive.
    // solhint-disable-next-line code-complexity, function-max-lines
    function buy(uint256 minTokensOut) external payable nonReentrant returns (uint256 tokensOut) {
        if (graduated) revert AlreadyGraduated();
        if (msg.value == 0) revert ZeroAmount();

        // Snapshot the anti-snipe window state BEFORE mutating tokensSold: the cap applies based on
        // how much had sold at the start of this buy, so a single buy can't cross the threshold to
        // escape the cap (decision #7).
        bool capActive = buyCapActive();

        uint256 remaining = curveTokenAllocation - tokensSold;
        (uint256 previewTokens,,,) = _previewBuy(msg.value);

        uint256 fee;
        // ⚠️ `uninitialized-local`: the zero default is the answer on the ordinary path, since only
        // the crossing branch below ever produces a refund. Left implicit rather than written as
        // `= 0` for one reason worth recording: an explicit zero here CHANGES THE BYTECODE. Measured
        // in #40 - the optimizer does not elide the store, and `BondingCurve`'s runtime code moved,
        // taking `LaunchpadFactory`'s with it because the factory embeds the curve's creation code.
        // The same explicit-zero change in `LPLock.collect` was byte-identical, so this is not a
        // general rule about the compiler; it has to be measured per site. #40 is a tooling ticket
        // and does not move deployed bytecode.
        // slither-disable-next-line uninitialized-local
        uint256 refund;
        bool crossing = previewTokens >= remaining;

        if (crossing) {
            // Cap the buy at exactly the remaining allocation and charge only the ETH needed to
            // drive the reserves to their final (calibrated) values; refund the rest.
            tokensOut = remaining;
            uint256 netNeeded = finalEthReserve - ethReserve;
            uint256 grossNeeded = Math.ceilDiv(netNeeded * BPS, BPS - tradeFeeBps);
            // Clamp to msg.value: `previewTokens >= remaining` guarantees msg.value >= netNeeded, but
            // the fee floor and this ceil gross-up may not compose to the wei, so an honest buy sized
            // to exactly complete the curve must never underflow-revert on the refund.
            if (grossNeeded > msg.value) grossNeeded = msg.value;
            fee = grossNeeded - netNeeded;
            refund = msg.value - grossNeeded;
            ethReserve = finalEthReserve;
            tokenReserve = finalTokenReserve;
            tokensSold = curveTokenAllocation;
        } else {
            uint256 newEthReserve;
            uint256 newTokenReserve;
            (tokensOut, fee, newEthReserve, newTokenReserve) = _previewBuy(msg.value);
            if (tokensOut == 0) revert NoTokensOut();
            if (tokensSold + tokensOut > curveTokenAllocation) revert CurveSoldOut(); // safety; unreachable
            ethReserve = newEthReserve;
            tokenReserve = newTokenReserve;
            tokensSold += tokensOut;
        }

        if (tokensOut < minTokensOut) revert SlippageBuy(tokensOut, minTokensOut);

        // Anti-snipe: cap per-wallet accumulation during the early window (decision #7).
        if (capActive) {
            uint256 purchased = purchasedOf[msg.sender] + tokensOut;
            if (purchased > maxBuyPerWallet) revert BuyCapExceeded(purchased, maxBuyPerWallet);
            purchasedOf[msg.sender] = purchased;
        }

        _sendEth(treasury, fee);
        token.safeTransfer(msg.sender, tokensOut);
        if (refund > 0) _sendEth(msg.sender, refund); // before graduation so it isn't seeded into the pool

        emit Bought(
            address(token),
            msg.sender,
            msg.value,
            msg.value - fee - refund,
            fee,
            tokensOut,
            priceX18(),
            ethReserve,
            tokenReserve,
            tokensSold
        );

        if (crossing) _graduate();
    }

    // slither-disable-end reentrancy-eth

    /// @notice Sell tokens back to the curve for ETH. Caller must approve first. `minEthOut` bounds slippage.
    function sell(uint256 tokenAmount, uint256 minEthOut) external nonReentrant returns (uint256 ethOut) {
        if (graduated) revert AlreadyGraduated();
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

        emit Sold(
            address(token), msg.sender, tokenAmount, ethOut, fee, priceX18(), ethReserve, tokenReserve, tokensSold
        );
    }

    /// @dev Hands 100% of the raised ETH to the GraduationManager, which seeds the locked full-range
    ///      pool. Uses the CALIBRATED raised amount (finalEthReserve - virtualEthReserve), not the raw
    ///      balance, so ETH force-fed via selfdestruct can't inflate the seed and break price
    ///      continuity; any such surplus is simply left stranded in the curve. `graduated` is set
    ///      before the external call as a belt-and-suspenders re-entrancy guard (buy() is nonReentrant).
    // `arbitrary-send-eth`: the destination is `graduationManager`, an immutable set in the
    // constructor from the factory's own immutable. It is not a parameter, not owner-settable and not
    // reachable by any caller, so there is no "arbitrary" recipient to control.
    // slither-disable-next-line arbitrary-send-eth
    function _graduate() private {
        graduated = true;
        uint256 raised = finalEthReserve - virtualEthReserve;
        address pool = IGraduationManager(graduationManager).graduate{value: raised}(address(token));
        emit Graduation(pool, raised);
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
