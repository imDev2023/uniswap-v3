# Deployment — Robinhood Chain **testnet** (46630)

Broadcast of [`contracts/script/DeployLaunchpad.s.sol`](../contracts/script/DeployLaunchpad.s.sol)
per the runbook in [`docs/deploy.md`](./deploy.md). Addresses are public; this file is committed.

| Field | Value |
| --- | --- |
| Chain | Robinhood Chain Testnet, chainId **46630** |
| RPC | `https://rpc.testnet.chain.robinhood.com` |
| Explorer | https://explorer.testnet.chain.robinhood.com |
| Deployer EOA | `0x8Ec5f1e04531416d337E61733DfC5d1685D9A80C` |
| Deploy block | **93090712** (first tx) – 93090715 (last) |
| Gas spent | ~0.00023 ETH total (deploy + `acceptOwnership`) |

## Addresses

| Contract | Address | Verified |
| --- | --- | --- |
| `LaunchpadFactory` | `0xE98B99ADD42c550bf40B887Bf07A8f0119a22232` | ✅ Blockscout |
| `GraduationManager` | `0xE44a178EaD9D35D4e0e6d0fE77Cee82F81F785a5` | ✅ Blockscout |
| `LPLock` | `0xf9D783674b2F575aFe2fcd70a8BCEfe38Ea33aAd` | ✅ Blockscout |
| `UniswapV3Factory` (ours) | `0x808088B7949877b0eF9CC514627426505CF069bA` | ⬜ see note |
| `SwapRouter` (ours) | `0x7a9232B5af20635AbC85c5f854648E916B3b8826` | ⬜ see note |
| `NonfungiblePositionManager` (ours) | `0x52e32e892E43b945a3FE747305CC7C2496dDbB61` | ⬜ see note |
| `WETH9` (canonical, pre-existing) | `0x7943e237c7F95DA44E0301572D358911207852Fa` | n/a |
| Treasury | `0x8Ec5f1e04531416d337E61733DfC5d1685D9A80C` | n/a |

**V3 stack verification note:** the factory / router / position manager are deployed byte-for-byte
from the audited Uniswap release artifacts via `vm.getCode` (decision #4), so there is no in-repo
Solidity source for `forge verify-contract` to compile. Verifying them needs a standard-JSON input
built from the upstream `@uniswap/v3-core` / `v3-periphery` package artifacts — tracked as a
follow-up, not a blocker.

## ⚠️ Testnet WETH9 differs from mainnet

`contracts/src/Constants.sol` hardcodes the **mainnet** WETH9
(`0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`). That address has **no code on 46630**. The canonical
testnet WETH9 is `0x7943e237c7F95DA44E0301572D358911207852Fa` — confirmed equivalent, not merely
similar:

- its proxy bytecode is **byte-identical** to mainnet `0x0Bd7…AD73`, and
- its EIP-1967 implementation bytecode is **byte-identical** to the mainnet implementation, and
- `deposit()` succeeds and `withdraw()` reverts with the correct `ERC20: burn amount exceeds balance`.

The deploy therefore passed `WETH9=0x7943e237c7F95DA44E0301572D358911207852Fa` explicitly. **Any
re-deploy or mainnet deploy must keep passing the right per-chain value** — the script's default is
mainnet-only. `GraduationManager.weth9()` on this deployment reads back the testnet address.

## Transactions

| Step | Tx |
| --- | --- |
| Deploy `UniswapV3Factory` | `0xbc2fb6b5eeda196814d2c9506ae2ea340ece09e272b7da7b3847f47f7cbfdbc4` |
| Deploy `SwapRouter` | `0xb57bd8c71f9530cffad9d0a472a0ab6b371ef8369370cbe34941976519b5deb1` |
| Deploy `NonfungiblePositionManager` | `0x5df9e5bf2051fe8b4436ea10eadc88cf8cfb2a2f6cad256a563197b20f0f10d9` |
| Deploy `LaunchpadFactory` | `0xc04d91b98620902d6020c6ff008e508890a58563fa5f5077af5d8d37dea90b21` |
| `v3Factory.setOwner(launchpad)` | `0x7a60375cfc0fb8a485cb57697a03d60394f991ab21c999078e7d92de5b719ed8` |
| `launchpad.transferOwnership(SAFE)` | `0xf7dbdcf9d0c492e9148b2c2f5b486202c781030c3c66a37a26a855d6f0e09bef` |
| `launchpad.acceptOwnership()` | `0x71ba77c46ee14d863ac6592d4b835372af98619c34ee4cc10d3662ad50d57545` |

All receipts `status = 0x1`.

## Post-deploy state (verified via `cast`)

```
launchpad.owner()             = 0x8Ec5f1e04531416d337E61733DfC5d1685D9A80C   # == SAFE ✅
launchpad.pendingOwner()      = 0x0000000000000000000000000000000000000000   # handoff complete ✅
launchpad.treasury()          = 0x8Ec5f1e04531416d337E61733DfC5d1685D9A80C
launchpad.creationFee()       = 10000000000000000                            # 0.01 ETH
launchpad.graduationManager() = 0xE44a178EaD9D35D4e0e6d0fE77Cee82F81F785a5
launchpad.lpLock()            = 0xf9D783674b2F575aFe2fcd70a8BCEfe38Ea33aAd
v3Factory.owner()             = 0xE98B99ADD42c550bf40B887Bf07A8f0119a22232   # == launchpad ✅
graduationManager.weth9()     = 0x7943e237c7F95DA44E0301572D358911207852Fa   # testnet WETH9 ✅
swapRouter.WETH9()            = 0x7943e237c7F95DA44E0301572D358911207852Fa
positionManager.WETH9()       = 0x7943e237c7F95DA44E0301572D358911207852Fa
positionManager.factory()     = 0x808088B7949877b0eF9CC514627426505CF069bA
```

On this testnet the deployer EOA **is** the `SAFE` value, so `acceptOwnership()` was sent from the
EOA. On mainnet the Safe multisig must execute it as a multisig transaction.

## Notes on the broadcast

- `forge script --broadcast` needs **`--non-interactive`**: `LaunchpadFactory` compiles to 26,586
  bytes, over the EIP-170 24,576 limit, and forge otherwise opens a TTY confirmation prompt that
  fails with `IO error: not a terminal` in a non-TTY shell. (The oversize contract is our own
  `LaunchpadFactory` — **not** the position manager, which lands at 24,384.) Robinhood Chain is an
  Arbitrum Orbit chain with a raised code-size limit, so the deploy succeeds.
- `forge verify-contract` reads `[etherscan]` in `foundry.toml`, which interpolates
  `BLOCKSCOUT_API_KEY` / `BLOCKSCOUT_TESTNET_API` / `BLOCKSCOUT_MAINNET_API`. **All three** must be
  exported or forge errors on the unused mainnet one.

## Reproduce

```bash
export PATH="$HOME/.foundry/bin:$PATH"
cd contracts && set -a && . ./.env && set +a

EXPECTED_CHAIN_ID=46630 WETH9=0x7943e237c7F95DA44E0301572D358911207852Fa \
  forge script script/DeployLaunchpad.s.sol \
  --rpc-url robinhood_testnet --broadcast --non-interactive --private-key $PRIVATE_KEY
```
