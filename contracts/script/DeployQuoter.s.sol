// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {V3Deployer} from "../src/periphery/V3Deployer.sol";
import {Constants} from "../src/Constants.sol";

/// @notice Deploys a `QuoterV2` against an ALREADY-DEPLOYED V3 factory, so the swap page (#21) can
///         show exact quotes instead of a `slot0` spot-price estimate.
///
/// @dev This is deliberately a standalone script, not a step in `DeployLaunchpad.s.sol`: the quoter
///      is a pure read-side lens. It holds no funds, has no owner, and nothing in the protocol
///      references it — so it can be added to (or replaced on) a live deployment with zero risk to
///      pools, positions or the launchpad. Re-running it just yields another independent instance.
///
///      Like the rest of the V3 stack (decision #4) it is deployed byte-for-byte from the audited
///      Uniswap release artifact via `vm.getCode`, so no v3-periphery Solidity 0.7.6 is compiled
///      alongside our 0.8.x sources.
///
///      ⚠️ `WETH9` is PER-CHAIN — `Constants.WETH9` is mainnet-only and has no code on 46630. Always
///      pass `WETH9=` explicitly for testnet. The quoter only uses it to unwrap-aware-path quotes,
///      but a wrong value yields silently wrong quotes rather than a revert.
///
///        export PATH="$HOME/.foundry/bin:$PATH"
///        cd contracts && set -a && . ./.env && set +a
///
///        # dry run against real chain state:
///        EXPECTED_CHAIN_ID=46630 \
///          V3_FACTORY=0x808088B7949877b0eF9CC514627426505CF069bA \
///          WETH9=0x7943e237c7F95DA44E0301572D358911207852Fa \
///          forge script script/DeployQuoter.s.sol --fork-url robinhood_testnet
///
///        # broadcast (--non-interactive: see docs/deployments-testnet.md):
///        ... same env ... forge script script/DeployQuoter.s.sol \
///          --rpc-url robinhood_testnet --broadcast --non-interactive --private-key $PRIVATE_KEY
contract DeployQuoter is Script, V3Deployer {
    function run() external {
        address v3Factory = vm.envAddress("V3_FACTORY");
        address weth9 = vm.envOr("WETH9", Constants.WETH9);

        require(
            block.chainid == Constants.CHAIN_ID_MAINNET || block.chainid == Constants.CHAIN_ID_TESTNET,
            "DeployQuoter: not a Robinhood Chain (4663 / 46630)"
        );
        uint256 expected = vm.envOr("EXPECTED_CHAIN_ID", uint256(0));
        require(expected == 0 || expected == block.chainid, "DeployQuoter: chainid != EXPECTED_CHAIN_ID");

        // Catch the two ways this silently produces a useless quoter: a factory address with no code,
        // and the mainnet WETH9 constant on testnet (which has no code on 46630).
        require(v3Factory.code.length > 0, "DeployQuoter: V3_FACTORY has no code on this chain");
        require(weth9.code.length > 0, "DeployQuoter: WETH9 has no code on this chain (per-chain address!)");

        vm.startBroadcast();
        address quoter = deployQuoterV2(v3Factory, weth9);
        vm.stopBroadcast();

        console2.log("chainid:       ", block.chainid);
        console2.log("V3 factory:    ", v3Factory);
        console2.log("WETH9:         ", weth9);
        console2.log("QuoterV2:      ", quoter);
        console2.log(">> Set VITE_QUOTER_ADDRESS in frontend/.env.local to the QuoterV2 address.");
    }
}
