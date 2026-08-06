// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.24;

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
///      Three entrypoints:
///        run()      - create the launch table and buy each curve up to its target progress.
///        showcase() - the carved / permanently-locked / carved-and-graduated launches, which are
///                     the only ones that exercise the tokenomics panels rather than their empty
///                     states. Needs SHOWCASE_PK. Meant to run at a different calibration to run().
///        churn()    - trade on the already-seeded live curves, to refresh "recent trades" while
///                     iterating on the feed. Safe to run repeatedly.
///
/// ⚠️ TESTNET ONLY. Hard-reverts on mainnet 4663: this spends real ETH across seven keys and
///    creates permanent, unremovable launches on a factory we own. There is no undo, and
///    `metadataURI` has no setter by design, so a stray mainnet run would be public forever.
///
/// Usage (from contracts/, with .env providing PRIVATE_KEY and TEST_PK_1..6, and LAUNCHPAD set):
///   forge script script/SeedTestnet.s.sol:SeedTestnet --sig 'run()' \
///     --rpc-url robinhood_testnet --broadcast --slow
///   SHOWCASE_PK=0x<throwaway> forge script script/SeedTestnet.s.sol:SeedTestnet --sig 'showcase()' \
///     --rpc-url robinhood_testnet --broadcast --slow
///   forge script script/SeedTestnet.s.sol:SeedTestnet --sig 'churn()' \
///     --rpc-url robinhood_testnet --broadcast --slow
///
/// ⚠️ Fund the wallets generously FIRST. `forge script` simulates the whole script before
/// broadcasting anything, so one under-funded wallet fails the entire run at simulation time with
/// `OutOfFunds` and writes nothing at all. That is a safe failure, not a half-built board, but it
/// costs a full re-run.
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
        uint16 devAllocationBps; // creator's carve out of CURVE_SUPPLY, 0..maxDevAllocationBps (#34)
        bool permanentLock; // lock the graduation LP forever instead of defaultLockDuration (#33)
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
        plans[0] = Plan("Robinhood Doge", "RDOGE", "", 9_600, 3, false, 0, false);
        plans[1] = Plan(
            "Octo Cat",
            "OCAT",
            "ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsei6af7kunjlzhu",
            8_600,
            2,
            true,
            0,
            false
        );
        plans[2] = Plan("Green Candle", "CANDLE", "", 7_200, 3, false, 0, false);
        plans[3] = Plan("Diamond Hands", "DIAMOND", "", 5_800, 2, false, 0, false);
        plans[4] = Plan(
            "Moon Boots",
            "BOOTS",
            "ipfs://bafkreie7q2cx4kmrqxqhb7yzqxvfhbxvqz2wqmzqxqzqxqzqxqzqxqzqxq",
            4_500,
            1,
            false,
            0,
            false
        );
        plans[5] = Plan("Liquid Courage", "COURAGE", "", 3_100, 2, true, 0, false);
        plans[6] = Plan("Tentacle", "TENT", "", 1_900, 1, false, 0, false);
        plans[7] = Plan("Paper Hands", "PAPER", "", 1_000, 2, false, 0, false);
        plans[8] = Plan("Rug Proof", "RUGPRF", "", 300, 1, false, 0, false);
        // Graduates on the crossing buy, giving the "just graduated" feed a second entry.
        plans[9] = Plan("Full Send", "SEND", "", BPS, 2, false, 0, false);
        // Never traded: 0% meter, opening price from LaunchCreated, no holders, no trades.
        plans[10] = Plan("Silent Launch", "QUIET", "", 0, 0, false, 0, false);
    }

    // -----------------------------------------------------------------------------------------
    // showcase() - the launches that exercise the tokenomics UI
    // -----------------------------------------------------------------------------------------

    /// @notice Creates the launches that `run()`'s board deliberately cannot: carved, permanently
    ///         locked, and carved-and-graduated.
    ///
    /// @dev ⚠️ Why this is separate from `run()`. Every panel #33-#37 built - the lock card, the
    ///      vesting card, the creator-concentration figure - renders its EMPTY state against a
    ///      zero-carve, default-lock launch, and an empty state is indistinguishable from a broken
    ///      one. A board made entirely of `run()`'s launches leaves the whole tokenomics UI
    ///      unexercised against real indexed data, which is #38's actual acceptance test.
    ///
    ///      It is also a separate entrypoint because it is meant to run at a DIFFERENT calibration.
    ///      `setCurveParams` is future-only, so one board can carry both: seed the density board at
    ///      the cheap 0.1 ETH target, then re-calibrate to 1 ETH and run this, so the launches that
    ///      matter graduate at a scale near the 10 ETH mainnet target. Rebuilding the whole board at
    ///      1 ETH would cost ~3.6 ETH, which the testnet wallets do not hold.
    ///
    ///      ⚠️ Creator is `SHOWCASE_PK`, deliberately NOT one of the `TEST_PK_*` keys and NOT the
    ///      deployer. The acceptance test has to import the creator's key into a real MetaMask to
    ///      see the claim button, and no key that lives in `contracts/.env` may ever be typed into a
    ///      browser session. Generate a throwaway, fund it, use it here, and it is the only key that
    ///      is exposed.
    function showcase() public {
        uint256 creatorKey = vm.envUint("SHOWCASE_PK");
        address creator = vm.addr(creatorKey);
        console.log("showcase creator", creator);

        Plan[3] memory plans = _showcasePlans();
        for (uint256 i = 0; i < plans.length; i++) {
            _seedOneAs(plans[i], creatorKey, i);
        }
    }

    /// @dev Each of the three exists for one UI state that nothing else on the board reaches.
    function _showcasePlans() internal pure returns (Plan[3] memory plans) {
        // The maximum carve, ungraduated: the vesting card's "not started" branch, and a
        // concentration figure that must read 5% of the launch's OWN curve allocation rather than
        // 0% (which is what the whole board read before #37).
        plans[0] = Plan("Vesting Dev", "VEST", "", 3_500, 2, false, 500, false);
        // Permanent lock: the lock card must say permanent and never offer a reclaim countdown.
        // Carved as well, so the two panels are proven independent of each other.
        plans[1] = Plan("Locked Forever", "FOREVER", "", 2_000, 1, false, 300, true);
        // ⚠️ The one that matters most. Carved AND graduated, so the vesting schedule is actually
        // RUNNING: this is the only launch on which the claim button, the released-vs-granted split
        // and the `graduatedAt`-over-RPC path (#37's review finding 1) can be seen at all. That path
        // has never run against a deployed contract, because DevVesting has never been deployed.
        plans[2] = Plan("Claim Me", "CLAIM", "", BPS, 2, false, 400, false);
    }

    function _seedOne(Plan memory p, uint256 i) internal {
        _seedOneAs(p, testKeys[i % testKeys.length], i);
    }

    /// @param keyOffset Where in `testKeys` this launch's BUYERS start. In `run()` it is the plan's
    ///        index, which is what spreads holders across wallets; in `showcase()` it is just an
    ///        offset, since the creator comes from `SHOWCASE_PK` rather than from `testKeys`. It is
    ///        deliberately not called `i`: it stopped being an index the moment `showcase()` began
    ///        passing one that indexes nothing.
    function _seedOneAs(Plan memory p, uint256 creatorKey, uint256 keyOffset) internal {
        uint256 fee = launchpad.creationFee();

        // start/stopBroadcast rather than a bare broadcast: forge forbids view calls after a
        // one-shot `broadcast`, and this script has to read curve state between every transaction.
        vm.startBroadcast(creatorKey);
        // ⚠️ `p.permanentLock` and `p.devAllocationBps` are plan fields, NOT the literal `false, 0`
        // this call used to pass. That literal is the same defect #37 found hardcoded in the create
        // form, where it silently gave every launch made through the UI no carve and no permanent
        // lock. Left here it would have been just as effective at hiding the tokenomics UI, only
        // from the acceptance test instead of from creators. `run()`'s board still passes zero for
        // both - see `_plans()` - because its job is the density problem and a carve would make
        // every one of its calibrations differ from the 0% reference. `showcase()` is where the
        // non-zero values live.
        address token = launchpad.createLaunch{value: fee}(
            LaunchParams(p.name, p.symbol, p.metadataURI, p.permanentLock, p.devAllocationBps)
        );
        vm.stopBroadcast();

        BondingCurve curve = BondingCurve(launchpad.curveOf(token));
        console.log(string.concat("  ", p.symbol), token);

        if (p.buyers == 0 || p.targetBps == 0) return;

        // Walk the curve up in `buyers` steps, each from a different wallet, so the launch ends with
        // several holders and several trades rather than one whale print.
        for (uint8 b = 0; b < p.buyers; b++) {
            uint256 stepBps = (p.targetBps * (b + 1)) / p.buyers;
            uint256 buyerKey = testKeys[(keyOffset + b + 1) % testKeys.length];
            _buyToProgress(curve, stepBps, buyerKey, p.targetBps == BPS && b + 1 == p.buyers);
        }

        if (p.sellAfter) {
            uint256 sellerKey = testKeys[(keyOffset + p.buyers) % testKeys.length];
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
