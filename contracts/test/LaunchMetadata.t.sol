// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {LaunchpadFactory} from "../src/LaunchpadFactory.sol";
import {LaunchToken} from "../src/LaunchToken.sol";
import {BondingCurve} from "../src/BondingCurve.sol";

/// @notice Build #24 (Stage 1): the on-chain metadata URI and the self-sufficient `LaunchCreated`.
/// @dev These two changes exist to remove *read* dependencies, so the tests are written around the
///      question "what can a client learn without an indexer and without an `eth_call`?" rather than
///      around the setters and getters themselves. Both matter concretely:
///
///      - A pruned RPC rejects historical `eth_call` during backfill, so anything an indexer needs at
///        a past block has to be in the log itself.
///      - Before this build, token images lived in the creator's `localStorage`, which meant a token
///        you launched had no image for anybody else. That is a product bug, not a cosmetic one.
contract LaunchMetadataTest is Test {
    uint256 internal constant FEE = 0.01 ether;

    LaunchpadFactory internal factory;
    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");
    // Placeholder V3 addresses; nothing here graduates (that path is Graduation.t.sol).
    address internal positionManager = makeAddr("positionManager");
    address internal v3Factory = makeAddr("v3Factory");
    address internal weth9 = makeAddr("weth9");

    string internal constant URI = "ipfs://bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

    /// @dev The non-indexed half of `LaunchCreated`, in order. A struct ABI-encodes exactly as the
    ///      flat tuple the event emits, so `abi.decode(data, (LaunchData))` decodes the log in one
    ///      step — and, unlike a 9-way tuple destructure, in a single stack slot.
    struct LaunchData {
        string name;
        string symbol;
        string metadataURI;
        uint256 virtualEthReserve;
        uint256 virtualTokenReserve;
        uint256 curveTokenAllocation;
        uint16 tradeFeeBps;
        uint256 maxBuyPerWallet;
        uint256 antiSnipeThreshold;
    }

    bytes32 internal constant LAUNCH_CREATED_SIG = keccak256(
        "LaunchCreated(address,address,address,string,string,string,uint256,uint256,uint256,uint16,uint256,uint256)"
    );

    function setUp() public {
        factory = new LaunchpadFactory(owner, treasury, FEE, positionManager, v3Factory, weth9);
        vm.deal(creator, 100 ether);
    }

    function _create(string memory uri) internal returns (address token) {
        vm.prank(creator);
        token = factory.createLaunch{value: FEE}("Doge Killer", "DOGEK", uri);
    }

    /// @dev Create a launch and decode the `LaunchCreated` log it emitted. This is deliberately
    ///      decoding the *log* rather than reading contract state: it is exactly what an indexer or
    ///      a plain `eth_getLogs` consumer sees, so a test that passes here proves the data is
    ///      genuinely reachable without any `eth_call`.
    function _createAndDecode(string memory uri)
        internal
        returns (address token, address curve, LaunchData memory p)
    {
        vm.recordLogs();
        _create(uri);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] != LAUNCH_CREATED_SIG) continue;
            token = address(uint160(uint256(logs[i].topics[1])));
            curve = address(uint160(uint256(logs[i].topics[2])));
            assertEq(address(uint160(uint256(logs[i].topics[3]))), creator, "creator topic");
            // Event data is the bare tuple of non-indexed args. Decoding it as a single dynamic
            // STRUCT requires a leading head offset, which the log does not carry — so prepend the
            // canonical 0x20. (A struct's body encodes identically to the tuple of its fields, which
            // is what makes this equivalence hold.)
            p = abi.decode(bytes.concat(abi.encode(uint256(0x20)), logs[i].data), (LaunchData));
            return (token, curve, p);
        }
        revert("LaunchCreated not emitted");
    }

    // --- metadata URI -----------------------------------------------------------------------

    /// The URI is readable straight off the token over plain RPC — no indexer, no factory lookup.
    function test_MetadataURI_StoredOnToken() public {
        address token = _create(URI);
        assertEq(LaunchToken(token).metadataURI(), URI, "URI readable from the token itself");
    }

    /// The URI in the log is the same one the token stores, so an indexer never has to reconcile.
    function test_MetadataURI_LogMatchesTokenStorage() public {
        (address token,, LaunchData memory p) = _createAndDecode(URI);
        assertEq(p.metadataURI, URI, "URI present in the log");
        assertEq(LaunchToken(token).metadataURI(), p.metadataURI, "log agrees with token storage");
    }

    /// Immutability is the whole point: nobody — creator, launchpad owner, or anyone else — can
    /// swap the art after buyers have committed. There is no setter to call, so probing plausible
    /// setter selectors must find nothing. This is the token-side twin of the locked LP guarantee.
    function test_MetadataURI_HasNoSetter() public {
        address token = _create(URI);

        string[4] memory candidates = [
            "setMetadataURI(string)",
            "updateMetadataURI(string)",
            "setTokenURI(string)",
            "setURI(string)"
        ];
        for (uint256 i = 0; i < candidates.length; i++) {
            (bool ok,) = token.call(abi.encodeWithSignature(candidates[i], "ipfs://malicious"));
            assertFalse(ok, candidates[i]);
        }

        // And the owner of the launchpad has no privileged path either.
        vm.prank(owner);
        (bool ownerOk,) = token.call(abi.encodeWithSignature("setMetadataURI(string)", "ipfs://malicious"));
        assertFalse(ownerOk, "launchpad owner cannot rewrite metadata");

        assertEq(LaunchToken(token).metadataURI(), URI, "URI unchanged after every attempt");
    }

    /// An empty URI is a legitimate "no metadata" launch rather than a revert. The contract cannot
    /// validate that a URI resolves anyway, so rejecting the empty string would buy nothing and
    /// would only push creators toward a junk placeholder. Clients fall back to a default avatar.
    function test_MetadataURI_EmptyIsAllowed() public {
        address token = _create("");
        assertEq(LaunchToken(token).metadataURI(), "", "empty URI accepted");
    }

    /// URIs are creator-supplied and unbounded; a long one must round-trip through storage and the
    /// log without truncation.
    function test_MetadataURI_LongValueRoundTrips() public {
        string memory long = string(
            abi.encodePacked(
                "ipfs://bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
                "/metadata/collection/v1/token/very/deeply/nested/path/that/keeps/going",
                "?variant=banner&width=1500&height=500&cachebust=0123456789abcdef"
            )
        );
        (address token,, LaunchData memory p) = _createAndDecode(long);
        assertEq(p.metadataURI, long, "long URI survives the log");
        assertEq(LaunchToken(token).metadataURI(), long, "long URI survives storage");
    }

    /// Two launches must not share metadata state — each token owns its own string.
    function test_MetadataURI_IsPerToken() public {
        address a = _create("ipfs://aaa");
        address b = _create("ipfs://bbb");
        assertEq(LaunchToken(a).metadataURI(), "ipfs://aaa");
        assertEq(LaunchToken(b).metadataURI(), "ipfs://bbb");
    }

    // --- frozen curve params in the log -----------------------------------------------------

    /// The core guarantee: every param in the log is byte-identical to the immutable actually
    /// frozen into the deployed curve. If these could drift, the whole "trust the log" premise of
    /// the indexer and the RPC-only read path would be unsound.
    function test_LaunchCreated_ParamsMatchCurveImmutables() public {
        (address token, address curveAddr, LaunchData memory p) = _createAndDecode(URI);
        BondingCurve curve = BondingCurve(curveAddr);

        assertEq(curveAddr, factory.curveOf(token), "log curve matches registry");
        assertEq(p.virtualEthReserve, curve.virtualEthReserve(), "virtualEthReserve");
        assertEq(p.virtualTokenReserve, curve.virtualTokenReserve(), "virtualTokenReserve");
        assertEq(p.curveTokenAllocation, curve.curveTokenAllocation(), "curveTokenAllocation");
        assertEq(p.tradeFeeBps, curve.tradeFeeBps(), "tradeFeeBps");
        assertEq(p.maxBuyPerWallet, curve.maxBuyPerWallet(), "maxBuyPerWallet");
        assertEq(p.antiSnipeThreshold, curve.antiSnipeThreshold(), "antiSnipeThreshold");
    }

    /// The bug this build closes. An untraded launch used to index with `priceX18 == 0`, because
    /// price was only ever learned from a `Bought`/`Sold` event that had not happened yet — so a
    /// freshly created token displayed a price of zero. With both virtual reserves in the log, the
    /// opening price is computable from the creation log alone, before anyone has traded.
    function test_LaunchCreated_InitialPriceDerivableWithoutAnyTrade() public {
        (, address curveAddr, LaunchData memory p) = _createAndDecode(URI);

        uint256 priceFromLog = (p.virtualEthReserve * 1e18) / p.virtualTokenReserve;
        assertGt(priceFromLog, 0, "opening price is not zero");
        assertEq(priceFromLog, BondingCurve(curveAddr).priceX18(), "log-derived price == on-chain price");

        // Nothing has traded: the curve is genuinely untouched.
        assertEq(BondingCurve(curveAddr).tokensSold(), 0, "no trades yet");
    }

    /// The UI must be able to show the anti-snipe cap and the graduation target without an
    /// `eth_call` — the pruned RPC forbids those on backfill. Both fall out of the log.
    function test_LaunchCreated_CapAndGraduationTargetDerivableFromLog() public {
        (, address curveAddr, LaunchData memory p) = _createAndDecode(URI);
        BondingCurve curve = BondingCurve(curveAddr);

        // Anti-snipe cap and its auto-lift point.
        assertEq(p.maxBuyPerWallet, factory.DEFAULT_MAX_BUY_PER_WALLET(), "cap from log");
        assertEq(p.antiSnipeThreshold, factory.DEFAULT_ANTI_SNIPE_THRESHOLD(), "threshold from log");
        assertTrue(p.antiSnipeThreshold > 0 && curve.buyCapActive(), "cap is live at launch");

        // ETH-to-graduate is 3x the virtual ETH reserve for the calibrated curve. Assert it against
        // the curve's own precomputed final reserve rather than restating the formula.
        //
        // The identity is exact only up to one wei: `finalEthReserve` is `ceilDiv(k, ...)`, so the
        // target rounds UP. That direction is deliberate and consistent with the curve's rounding
        // convention everywhere else — rounding always favours the protocol, never the trader, so a
        // buyer can never complete the curve for one wei less than the calibration demands.
        uint256 raiseTarget = curve.finalEthReserve() - p.virtualEthReserve;
        assertGe(raiseTarget, 3 * p.virtualEthReserve, "ceil rounds the graduation target UP, never down");
        assertApproxEqAbs(raiseTarget, 3 * p.virtualEthReserve, 1, "graduation target = 3 x V_eth (within ceil)");
    }

    /// `curveTokenAllocation` in the log removes a hardcoded constant from every consumer: curve
    /// progress is (tokensSold / allocation) and both sides are now event-derived.
    function test_LaunchCreated_AllocationRemovesHardcodedConstant() public {
        (address token,, LaunchData memory p) = _createAndDecode(URI);
        assertEq(p.curveTokenAllocation, factory.CURVE_SUPPLY(), "allocation is the 800M curve supply");
        assertEq(
            p.curveTokenAllocation + factory.GRADUATION_RESERVE(),
            LaunchToken(token).TOTAL_SUPPLY(),
            "allocation + reserve accounts for the entire fixed supply"
        );
    }

    // --- retuning ---------------------------------------------------------------------------

    /// `setCurveParams` is future-only (decision #9). The log must track that exactly: a launch
    /// created after a retune emits the NEW params, and the previously created curve keeps its own
    /// frozen values. Without this, an indexer replaying history would attribute the current params
    /// to every historical launch.
    function test_LaunchCreated_ReflectsRetunedParams_AndLeavesEarlierLaunchesAlone() public {
        (, address oldCurve, LaunchData memory oldLog) = _createAndDecode(URI);

        uint256 newVEth = 1 ether;
        uint16 newFeeBps = 250;
        uint256 newMaxBuy = 25_000_000e18;
        uint256 newThreshold = 120_000_000e18;

        vm.prank(owner);
        factory.setCurveParams(newVEth, newFeeBps, newMaxBuy, newThreshold);

        (, address newCurve, LaunchData memory newLog) = _createAndDecode(URI);

        // The new launch's log carries the new params...
        assertEq(newLog.virtualEthReserve, newVEth, "new V_eth in log");
        assertEq(newLog.tradeFeeBps, newFeeBps, "new fee in log");
        assertEq(newLog.maxBuyPerWallet, newMaxBuy, "new cap in log");
        assertEq(newLog.antiSnipeThreshold, newThreshold, "new threshold in log");
        // ...and matches the curve that was actually deployed with them.
        assertEq(newLog.virtualEthReserve, BondingCurve(newCurve).virtualEthReserve());
        assertEq(newLog.tradeFeeBps, BondingCurve(newCurve).tradeFeeBps());

        // The earlier launch is untouched, in the log and on-chain alike.
        assertEq(oldLog.virtualEthReserve, factory.DEFAULT_VIRTUAL_ETH_RESERVE(), "old log unchanged");
        assertEq(
            BondingCurve(oldCurve).virtualEthReserve(),
            factory.DEFAULT_VIRTUAL_ETH_RESERVE(),
            "old curve keeps its frozen calibration"
        );
        assertEq(BondingCurve(oldCurve).tradeFeeBps(), factory.DEFAULT_TRADE_FEE_BPS(), "old fee frozen");

        // virtualTokenReserve stays calibration-locked across a retune, which is what preserves
        // graduation price continuity (#16) for any V_eth.
        assertEq(
            newLog.virtualTokenReserve,
            oldLog.virtualTokenReserve,
            "virtualTokenReserve is calibration-locked, not tunable"
        );
    }

    /// Retuning must not disturb metadata: the two features are independent.
    function test_MetadataURI_UnaffectedByCurveRetune() public {
        address token = _create(URI);
        vm.prank(owner);
        factory.setCurveParams(1 ether, 250, 25_000_000e18, 120_000_000e18);
        assertEq(LaunchToken(token).metadataURI(), URI, "metadata survives a param retune");
    }
}
