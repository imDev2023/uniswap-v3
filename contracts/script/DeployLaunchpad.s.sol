// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {V3Deployer} from "../src/periphery/V3Deployer.sol";
import {IUniswapV3Factory} from "../src/interfaces/IUniswapV3Minimal.sol";
import {LaunchpadFactory} from "../src/LaunchpadFactory.sol";
import {Constants} from "../src/Constants.sol";

/// @notice Build 07 (#18): the full production deploy pipeline. Stands up the platform's OWN Uniswap
///         V3 stack, deploys the LaunchpadFactory wired to it, hands the V3 fee switch to the
///         launchpad, and begins the two-step handoff of the launchpad to a Safe multisig.
///
/// @dev Ownership choreography (decision #9):
///        1. V3 factory is deployed owned by the broadcaster, then `setOwner(launchpad)` transfers the
///           protocol fee switch to the launchpad (single-step; that's Uniswap's own Ownable).
///        2. The LaunchpadFactory is deployed with the broadcaster as initial owner (so this script can
///           wire step 1's ordering deterministically), then `transferOwnership(SAFE)` starts the
///           `Ownable2Step` handoff. Ownership does NOT move until the Safe calls `acceptOwnership()`
///           — a mistyped SAFE can never brick the launchpad.
///
///      Run testnet first, then mainnet (see docs/deploy.md for the full runbook):
///        # dry run against real chain state (no broadcast):
///        SAFE=0x.. forge script script/DeployLaunchpad.s.sol --fork-url robinhood_testnet
///        # real testnet deploy + Blockscout verification:
///        SAFE=0x.. TREASURY=0x.. forge script script/DeployLaunchpad.s.sol \
///          --rpc-url robinhood_testnet --broadcast \
///          --verify --verifier blockscout --verifier-url $BLOCKSCOUT_TESTNET_API
///        # then, after smoke-testing testnet, the same command with --rpc-url robinhood.
contract DeployLaunchpad is Script, V3Deployer {
    function run() external {
        // --- Config (env-driven; testnet and mainnet differ only in RPC + these values) ---
        address safe = vm.envAddress("SAFE"); // the multisig that will own the launchpad
        address treasury = vm.envOr("TREASURY", safe); // fee sink; defaults to the Safe
        uint256 creationFee = vm.envOr("CREATION_FEE", uint256(0.01 ether));
        address weth9 = vm.envOr("WETH9", Constants.WETH9);
        address tokenDescriptor = vm.envOr("TOKEN_DESCRIPTOR", address(0xDEAD));

        // --- Chain guard: never deploy to a foreign chain, and if EXPECTED_CHAIN_ID is set, pin it. ---
        require(
            block.chainid == Constants.CHAIN_ID_MAINNET || block.chainid == Constants.CHAIN_ID_TESTNET,
            "DeployLaunchpad: not a Robinhood Chain (4663 / 46630)"
        );
        uint256 expected = vm.envOr("EXPECTED_CHAIN_ID", uint256(0));
        require(expected == 0 || expected == block.chainid, "DeployLaunchpad: chainid != EXPECTED_CHAIN_ID");
        require(safe != address(0), "DeployLaunchpad: SAFE is zero");

        vm.startBroadcast();

        // 1. Our own, unmodified Uniswap V3 (broadcaster owns the factory for now).
        address v3Factory = deployV3Factory();
        address router = deploySwapRouter(v3Factory, weth9);
        address positionManager = deployPositionManager(v3Factory, weth9, tokenDescriptor);

        // 2. The launchpad, wired to our V3 stack. Broadcaster is initial owner. WETH9 is threaded in
        //    (not hardcoded) so testnet 46630 and mainnet 4663 use their own wrapped-native.
        LaunchpadFactory launchpad =
            new LaunchpadFactory(msg.sender, treasury, creationFee, positionManager, v3Factory, weth9);

        // 3. Hand the V3 protocol-fee switch to the launchpad (so applyProtocolFee works at graduation).
        IUniswapV3Factory(v3Factory).setOwner(address(launchpad));

        // 4. Begin the two-step handoff of the launchpad to the Safe multisig. The Safe must call
        //    acceptOwnership() to finalize — until then the broadcaster remains owner.
        launchpad.transferOwnership(safe);

        vm.stopBroadcast();

        console2.log("chainid:                     ", block.chainid);
        console2.log("UniswapV3Factory:            ", v3Factory);
        console2.log("SwapRouter:                  ", router);
        console2.log("NonfungiblePositionManager:  ", positionManager);
        console2.log("WETH9:                       ", weth9);
        console2.log("LaunchpadFactory:            ", address(launchpad));
        console2.log("GraduationManager:           ", address(launchpad.graduationManager()));
        console2.log("LPLock:                      ", address(launchpad.lpLock()));
        // #35. Deployed by the factory's constructor like the two above, so it needs Blockscout
        // verification and a row in docs/deployments-testnet.md at #38's redeploy.
        console2.log("DevVesting:                  ", address(launchpad.devVesting()));
        console2.log("Treasury:                    ", treasury);
        console2.log("V3 factory owner (=launchpad):", IUniswapV3Factory(v3Factory).owner());
        console2.log("Launchpad owner (deployer):  ", launchpad.owner());
        console2.log("Launchpad pendingOwner (Safe):", launchpad.pendingOwner());
        console2.log(">> ACTION: the Safe must call launchpad.acceptOwnership() to finalize control.");
    }
}
