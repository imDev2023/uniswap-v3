# Contracts — DEX + Bonding-Curve Launchpad (Robinhood Chain)

Foundry project for the launchpad's on-chain layer. See spec [#11](https://github.com/imDev2023/uniswap-v3/issues/11) and the wayfinder map [#1](https://github.com/imDev2023/uniswap-v3/issues/1).

## What's here (Build 01 / #12)

The DEX is our **own instance of unmodified Uniswap V3** (decision #4). Rather than compile v3-core/periphery's Solidity 0.7.6 alongside our 0.8.x code, we deploy them from the **official precompiled artifacts** (`@uniswap/v3-core`, `@uniswap/v3-periphery` on npm) via `vm.getCode` — so what lands on-chain is byte-for-byte the audited release.

- `src/periphery/V3Deployer.sol` — deploys our own `UniswapV3Factory`, `SwapRouter`, `NonfungiblePositionManager` from prebuilt bytecode.
- `src/interfaces/IUniswapV3Minimal.sol` — minimal local interfaces (no 0.7.6 compile).
- `src/Constants.sol` — Robinhood Chain ids + canonical WETH9 / USDG addresses.
- `script/DeployV3.s.sol` — deployment script (dry-run on a fork, or `--broadcast`).
- `test/V3Harness.t.sol` — fork tests proving the harness end-to-end.

## Prerequisites

- [Foundry](https://book.getfoundry.sh/) (`curl -L https://foundry.paradigm.xyz | bash && foundryup`)
- Node (for the Uniswap V3 artifacts): `npm install`

## Networks

Configured in `foundry.toml` (`[rpc_endpoints]`):

| Alias                | Chain ID | RPC |
| -------------------- | -------- | --- |
| `robinhood`          | 4663     | `https://rpc.mainnet.chain.robinhood.com` |
| `robinhood_testnet`  | 46630    | `https://rpc.testnet.chain.robinhood.com` |

## Run

```bash
npm install                 # fetch the Uniswap V3 precompiled artifacts
forge build
forge test -vv              # runs the fork tests against Robinhood Chain (4663)
```

The tests fork mainnet (4663) to verify our own V3 deploys and a real 1%-tier pool can be created and initialized, and that the canonical WETH9 actually has code on-chain.

### Deploy (later tickets finalize ownership)

```bash
forge script script/DeployV3.s.sol --fork-url robinhood                       # dry run
forge script script/DeployV3.s.sol --rpc-url robinhood_testnet --broadcast    # real (needs a funded key)
# optional env: WETH9=0x... TOKEN_DESCRIPTOR=0x... OWNER=0x<multisig>
```

Ownership finalization (multisig / timelock) and full testnet→mainnet pipeline land in Build 07 (#18).
