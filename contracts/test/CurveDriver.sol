// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BondingCurve} from "../src/BondingCurve.sol";

/// @notice Shared helper for driving a curve to sellout in tests, honouring the anti-snipe cap.
/// @dev Exists because #34 re-scaled graduation from 90 ETH to 10 ETH. Every graduation test used to
///      open with a hardcoded `curve.buy{value: 0.15 ether}` per filler wallet, which sat under the
///      8M per-wallet cap at 90 ETH and blew straight through it at 10 ETH - the same fixed ETH now
///      buys roughly 9x the tokens. Nine tests failed at once with `BuyCapExceeded`.
///
///      ⚠️ The lesson is the reason this file exists rather than a 9x smaller literal. A buy size
///      hardcoded against one calibration is a test that silently depends on a number nobody thinks
///      of as a test input, and #34 is not the last time that number moves. `_maxBuyUnderCap` derives
///      the size from the curve's OWN cap and reserves, so it re-derives itself at any calibration.
abstract contract CurveDriver is Test {
    uint256 private constant BPS = 10_000;

    /// @notice Largest single buy this wallet can make without tripping the per-wallet cap, at the
    ///         curve's current reserves.
    /// @dev Solves the buy math backwards rather than searching. `tokensOut = tokenReserve -
    ///      ceil(k / newEthReserve)`, so the reserve that buys exactly `cap` is `tokenReserve - cap`,
    ///      and the ETH that lands there is `k / that`, grossed up for the trade fee. Every division
    ///      floors, which biases the result UNDER the cap - never over it, where the buy would revert.
    function _maxBuyUnderCap(BondingCurve curve) internal view returns (uint256 ethIn) {
        uint256 cap = curve.maxBuyPerWallet();
        uint256 tokenReserve = curve.tokenReserve();
        if (cap >= tokenReserve) return 0; // cap cannot bind; caller should buy freely
        uint256 needed = curve.k() / (tokenReserve - cap);
        uint256 ethReserve = curve.ethReserve();
        if (needed <= ethReserve) return 0;
        ethIn = ((needed - ethReserve) * BPS) / (BPS - curve.tradeFeeBps());
    }

    /// @notice Buy through the anti-snipe window with as many distinct wallets as the cap requires,
    ///         leaving the curve live but with the per-wallet cap lifted.
    /// @dev `tag` namespaces the filler addresses so two curves in one test do not share wallets -
    ///      `purchasedOf` is per curve, but a shared address would still make the intent unreadable.
    ///      The iteration bound is a test-hang guard, not a semantic limit: at the defaults the
    ///      window needs 15 wallets. It asserts rather than exits quietly, because a silent exit
    ///      would hand the caller a curve whose cap is still active and fail somewhere far away.
    function _liftAntiSnipe(BondingCurve curve, string memory tag) internal {
        uint256 i;
        for (; i < 200 && curve.buyCapActive(); ++i) {
            uint256 ethIn = _maxBuyUnderCap(curve);
            if (ethIn == 0) break;
            address filler = makeAddr(string(abi.encodePacked(tag, "filler", vm.toString(i))));
            vm.deal(filler, ethIn);
            vm.prank(filler);
            curve.buy{value: ethIn}(0);
        }
        assertFalse(curve.buyCapActive(), "anti-snipe window did not lift within the wallet budget");
    }
}
