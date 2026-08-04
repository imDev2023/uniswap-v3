// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LaunchpadFactory, LaunchParams} from "../src/LaunchpadFactory.sol";
import {BondingCurve} from "../src/BondingCurve.sol";

/// @notice Populates a TESTNET launchpad with a realistic spread of launches so the frontend's
///         browse surfaces can actually be designed and judged.
///
/// @dev Why this exists: the live board redesign (build #28) is a density problem. Against a single
///      graduated token the board renders as one card in an empty grid, which tells you nothing
///      about whether the layout, sort order, progress meters or trade feed work. Screenshots of a
///      one-item board are not evidence. So we seed the chain, not fixtures - the whole point of
///      Stage 2 was that the app reads real contract state, and mocking the board would test the
///      mock instead of the product.
///
///      Seeded state deliberately includes the awkward cases, because those are the ones design
///      forgets: a launch with NO metadata URI (the common case - v1 is bring-your-own-URI), a
///      launch with a URI that does not resolve, an untraded launch at 0% (which is also the
///      regression guard for the `priceX18 = 0` bug fixed in #24), and launches at both ends of the
///      progress meter. It also leaves multiple holders and both trade directions on some curves so
///      the holders table and the trades feed have something truthful to render.
///
///      Two entrypoints:
///        run()   - create the launch table and buy each curve up to its target progress.
///        churn() - trade on the already-seeded live curves, to refresh "recent trades" while
///                  iterating on the feed. Safe to run repeatedly.
///
/// ⚠️ TESTNET ONLY. Hard-reverts on mainnet 4663: this spends real ETH across seven keys and
///    creates permanent, unremovable launches on a factory we own. There is no undo, and
///    `metadataURI` has no setter by design, so a stray mainnet run would be public forever.
///
/// Usage (from contracts/, with .env providing PRIVATE_KEY and TEST_PK_1..6):
///   forge script script/SeedTestnet.s.sol:SeedTestnet --sig 'run()' \
///     --rpc-url robinhood_testnet --broadcast --slow
///   forge script script/SeedTestnet.s.sol:SeedTestnet --sig 'churn()' \
///     --rpc-url robinhood_testnet --broadcast --slow
///
/// `--slow` matters: it waits for each tx to land before sending the next. Without it, nonce-ordered
/// submission on a 0.3 s-block chain can have a buy arrive before the creation it depends on.
contract SeedTestnet is Script {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant MAINNET_CHAIN_ID = 4663;

    struct Plan {
        string name;
        string symbol;
        string metadataURI;
        uint256 targetBps; // progress to buy the curve up to; BPS == graduate
        uint8 buyers; // how many distinct wallets split the climb (>=1)
        bool sellAfter; // have the last buyer dump part of their bag
    }

    LaunchpadFactory internal launchpad;
    uint256[6] internal testKeys;

    function setUp() public {
        require(block.chainid != MAINNET_CHAIN_ID, "SeedTestnet: refusing to seed mainnet 4663");

        launchpad = LaunchpadFactory(vm.envAddress("LAUNCHPAD"));
        testKeys[0] = vm.envUint("TEST_PK_1");
        testKeys[1] = vm.envUint("TEST_PK_2");
        testKeys[2] = vm.envUint("TEST_PK_3");
        testKeys[3] = vm.envUint("TEST_PK_4");
        testKeys[4] = vm.envUint("TEST_PK_5");
        testKeys[5] = vm.envUint("TEST_PK_6");
    }

    // -----------------------------------------------------------------------------------------
    // run() - build the board
    // -----------------------------------------------------------------------------------------

    function run() public {
        Plan[11] memory plans = _plans();

        console.log("seeding launchpad", address(launchpad));
        console.log("launches before", launchpad.launchCount());

        for (uint256 i = 0; i < plans.length; i++) {
            _seedOne(plans[i], i);
        }

        console.log("launches after", launchpad.launchCount());
    }

    /// @dev The spread is chosen so the board has something at every visual extreme simultaneously:
    ///      a nearly-full meter next to an empty one, a graduated card next to an untraded one. A
    ///      tidy even distribution would hide exactly the layout bugs we are looking for.
    function _plans() internal pure returns (Plan[11] memory plans) {
        // Empty metadataURI is the honest common case for v1 (bring-your-own-URI), so it dominates.
        // The two ipfs:// URIs below are well-formed but do NOT resolve - that is deliberate, and is
        // the state the fallback avatar has to survive.
        plans[0] = Plan("Robinhood Doge", "RDOGE", "", 9_600, 3, false);
        plans[1] = Plan("Octo Cat", "OCAT", "ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsei6af7kunjlzhu", 8_600, 2, true);
        plans[2] = Plan("Green Candle", "CANDLE", "", 7_200, 3, false);
        plans[3] = Plan("Diamond Hands", "DIAMOND", "", 5_800, 2, false);
        plans[4] = Plan("Moon Boots", "BOOTS", "ipfs://bafkreie7q2cx4kmrqxqhb7yzqxvfhbxvqz2wqmzqxqzqxqzqxqzqxqzqxq", 4_500, 1, false);
        plans[5] = Plan("Liquid Courage", "COURAGE", "", 3_100, 2, true);
        plans[6] = Plan("Tentacle", "TENT", "", 1_900, 1, false);
        plans[7] = Plan("Paper Hands", "PAPER", "", 1_000, 2, false);
        plans[8] = Plan("Rug Proof", "RUGPRF", "", 300, 1, false);
        // Graduates on the crossing buy, giving the "just graduated" feed a second entry.
        plans[9] = Plan("Full Send", "SEND", "", BPS, 2, false);
        // Never traded: 0% meter, opening price from LaunchCreated, no holders, no trades.
        plans[10] = Plan("Silent Launch", "QUIET", "", 0, 0, false);
    }

    function _seedOne(Plan memory p, uint256 i) internal {
        uint256 creatorKey = testKeys[i % testKeys.length];

        uint256 fee = launchpad.creationFee();

        // start/stopBroadcast rather than a bare broadcast: forge forbids view calls after a
        // one-shot `broadcast`, and this script has to read curve state between every transaction.
        vm.startBroadcast(creatorKey);
        // Seeds a zero dev allocation: the board's job is to exercise the curve, and a pre-mine
        // would make every seeded launch's calibration differ from the 0% reference (#34).
        address token = launchpad.createLaunch{value: fee}(LaunchParams(p.name, p.symbol, p.metadataURI, false, 0));
        vm.stopBroadcast();

        BondingCurve curve = BondingCurve(launchpad.curveOf(token));
        console.log(string.concat("  ", p.symbol), token);

        if (p.buyers == 0 || p.targetBps == 0) return;

        // Walk the curve up in `buyers` steps, each from a different wallet, so the launch ends with
        // several holders and several trades rather than one whale print.
        for (uint8 b = 0; b < p.buyers; b++) {
            uint256 stepBps = (p.targetBps * (b + 1)) / p.buyers;
            uint256 buyerKey = testKeys[(i + b + 1) % testKeys.length];
            _buyToProgress(curve, stepBps, buyerKey, p.targetBps == BPS && b + 1 == p.buyers);
        }

        if (p.sellAfter) {
            uint256 sellerKey = testKeys[(i + p.buyers) % testKeys.length];
            _sellPortion(curve, IERC20(token), sellerKey, 3_000); // dump 30% of the bag
        }
    }

    // -----------------------------------------------------------------------------------------
    // churn() - refresh recent activity
    // -----------------------------------------------------------------------------------------

    /// @notice Trades a little on every live (non-graduated) curve, alternating buys and sells, so
    ///         the "recent trades" feed has fresh timestamps. Idempotent in the sense that it never
    ///         graduates anything: buys are capped well below the remaining allocation.
    function churn() public {
        uint256 n = launchpad.launchCount();
        console.log("churning across launches", n);

        for (uint256 i = 0; i < n; i++) {
            address token = launchpad.launches(i);
            BondingCurve curve = BondingCurve(launchpad.curveOf(token));
            if (curve.graduated()) continue;

            uint256 sold = curve.tokensSold();
            uint256 alloc = curve.curveTokenAllocation();
            uint256 currentBps = (sold * BPS) / alloc;

            // Nudge progress by ~1.5% - visible in the feed, never enough to cross graduation.
            uint256 targetBps = currentBps + 150;
            if (targetBps >= BPS) continue;

            uint256 key = testKeys[i % testKeys.length];
            _buyToProgress(curve, targetBps, key, false);

            // Every third launch also gets a sell, so the feed is not all one colour.
            if (i % 3 == 0) {
                _sellPortion(curve, IERC20(token), key, 4_000);
            }
        }
    }

    // -----------------------------------------------------------------------------------------
    // internals
    // -----------------------------------------------------------------------------------------

    /// @dev Buys exactly enough ETH to drive `tokensSold` to `targetBps` of the allocation, derived
    ///      from the curve's own invariant rather than a hardcoded table, so it stays correct if the
    ///      testnet calibration is re-scaled with `setCurveParams`.
    /// @param overpay When true, deliberately sends 10% more than needed. Only used on the crossing
    ///        buy, where it exercises the refund path in the wild rather than only in a fork test.
    function _buyToProgress(BondingCurve curve, uint256 targetBps, uint256 key, bool overpay) internal {
        uint256 gross = _grossForTargetBps(curve, targetBps);
        if (gross == 0) return;
        if (overpay) gross += gross / 10;

        vm.startBroadcast(key);
        curve.buy{value: gross}(0);
        vm.stopBroadcast();
    }

    function _grossForTargetBps(BondingCurve curve, uint256 targetBps) internal view returns (uint256) {
        uint256 alloc = curve.curveTokenAllocation();
        uint256 targetSold = (alloc * targetBps) / BPS;
        if (targetSold <= curve.tokensSold()) return 0;

        // Invert the constant product: the reserves that correspond to having sold `targetSold`.
        uint256 targetTokenReserve = curve.virtualTokenReserve() - targetSold;
        uint256 targetEthReserve = Math.ceilDiv(curve.k(), targetTokenReserve);

        uint256 current = curve.ethReserve();
        if (targetEthReserve <= current) return 0;

        // Gross the net up by the trade fee, the same way the crossing buy does.
        uint256 net = targetEthReserve - current;
        return Math.ceilDiv(net * BPS, BPS - curve.tradeFeeBps());
    }

    function _sellPortion(BondingCurve curve, IERC20 token, uint256 key, uint256 portionBps) internal {
        address seller = vm.addr(key);
        uint256 balance = token.balanceOf(seller);
        uint256 amount = (balance * portionBps) / BPS;
        if (amount == 0) return;

        vm.startBroadcast(key);
        token.approve(address(curve), amount);
        curve.sell(amount, 0);
        vm.stopBroadcast();
    }
}
