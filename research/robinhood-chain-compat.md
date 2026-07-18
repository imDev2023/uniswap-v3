# Uniswap V3 on Robinhood Chain — Compatibility Findings

_Research date: 2026-07-16_

## TL;DR verdict

**YES — and it's already done.** The Uniswap Labs deployment of **v2, v3, v4, and UniswapX is
LIVE on Robinhood Chain mainnet** as of the chain's public launch (~July 1, 2026). Uniswap is the
primary public AMM on the chain, and the busiest pair (USDG/WETH) has traded well over $90M/24h on
"Uniswap V3 (Robinhood)". So the question "can V3 be deployed and run here?" is answered
empirically: it runs in production today.

Robinhood Chain is a fully EVM-compatible Arbitrum (Orbit / "Arbitrum Dedicated Blockchains" /
Nitro) Layer-2. Because v3-core / v3-periphery compile with Solidity **0.7.6** — which predates the
PUSH0 opcode (Shanghai) — the classic Arbitrum "PUSH0 not supported" gotcha does **not** apply to
V3 at all. WETH-equivalent and a canonical stablecoin (USDG) both exist. Foundry, Hardhat,
Blockscout verification, and The Graph subgraphs/substreams are all supported.

If you were going to deploy V3 fresh, the only real work is standard: point at the RPC, use the
canonical WETH9 address as `WETH9`, and run the normal v3 deploy scripts. But Uniswap Labs already
did this, so prefer using the existing canonical deployment.

---

## 1. Chain identity

| Property | Mainnet | Testnet |
|---|---|---|
| **Chain ID** | **4663** | **46630** |
| **RPC (HTTP)** | `https://rpc.mainnet.chain.robinhood.com` | `https://rpc.testnet.chain.robinhood.com` |
| **RPC (WSS)** | `wss://feed.mainnet.chain.robinhood.com` | `wss://feed.testnet.chain.robinhood.com` |
| **Block explorer** | `https://robinhoodchain.blockscout.com` (Blockscout) | `https://explorer.testnet.chain.robinhood.com` |
| **Native gas token** | **ETH** | ETH (test) |
| **Status** | **Mainnet LIVE** (public launch ~2026-07-01) | Public testnet live (launched earlier in 2026) |

- Architecture: **Arbitrum L2 built on Ethereum**, using **Ethereum blobs for data availability**
  and **ETH as native gas** — i.e. an Arbitrum Orbit / "Arbitrum Dedicated Blockchains" (Nitro)
  rollup. Built by Robinhood Crypto.
- Recommended infra provider is **Alchemy** (`https://robinhood-mainnet.g.alchemy.com/v2/{KEY}`,
  wss variant). Also supported by QuickNode, Blockdaemon, dRPC, Validation Cloud.
- Registered on The Graph as CAIP-2 `eip155:4663`, identifier `robinhood`.

## 2. EVM compatibility

- Docs state the chain is **"fully EVM-compatible"**; contracts in Solidity **or Vyper** "deploy
  without modification using standard Ethereum tooling." First-class **ERC-4337 account
  abstraction** support is advertised.
- **Solidity versions for V3:** Uniswap v3-core and v3-periphery target **0.7.6**. 0.7.6 predates
  the Shanghai `PUSH0` opcode entirely, so the well-known Arbitrum incompatibility (where Solidity
  ≥0.8.20 emits `PUSH0` and must be capped to `evm-version` ≤ paris / Solidity ≤0.8.19 on
  pre-ArbOS-11 chains) is a **non-issue for V3**. V3 bytecode contains no PUSH0.
- Being a **2026-launch Arbitrum Nitro chain**, it will be on a modern ArbOS (well past ArbOS 11,
  which added Shanghai/PUSH0 support), so even modern 0.8.2x contracts should work — but this
  specific ArbOS/EVM-target level was **not explicitly documented** and should be confirmed if you
  need newer Solidity. For V3 it does not matter.
- **Arbitrum precompile/opcode caveats that always apply** (inherited from Arbitrum, not V3-specific
  and not blocking for V3): `block.number`/`block.timestamp` follow Arbitrum's semantics; `blockhash`
  behavior differs; L1 gas is charged separately; some Arbitrum-specific precompiles exist at
  `0x64`–`0x6e`. None of these break Uniswap V3 (V3 does not depend on exact block timing beyond
  oracle timestamp accumulation, which works fine on Arbitrum as proven on Arbitrum One).

## 3. Canonical assets (pair-against targets)

Confirmed from the official token-contracts doc (`docs.robinhood.com/chain/contracts/`):

| Asset | Role | Address (mainnet) |
|---|---|---|
| **WETH** | Canonical wrapped-native (WETH9-equivalent) | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| **USDG** (Global Dollar) | Canonical stablecoin — "first stablecoin natively issued on Robinhood Chain", Paxos/Global Dollar Network | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |

- WETH is the single busiest contract on the chain (~61% of ERC-20 transfer volume). **USDG/WETH is
  the flagship Uniswap V3 pool.** Tokenized stocks/ETFs also exist as ERC-20s on the same contracts
  page. USDG is the cash/settlement leg of the ecosystem.
- **Action for a fresh V3 deploy:** use `0x0Bd7…D73` as the `WETH9` constructor arg for the router /
  position manager. (Verify this address on-chain against the official docs page before relying on
  it — see gaps.)

## 4. Tooling

- **Foundry and Hardhat**: both officially supported with step-by-step deploy instructions in the
  Robinhood Chain docs. ethers.js, viem, Wagmi listed as supported.
- **Contract verification**: via **Blockscout**. Verifier URL `https://robinhoodchain.blockscout.com/api/`.
  - Foundry: `forge verify-contract --verifier blockscout --verifier-url https://robinhoodchain.blockscout.com/api/ …`
  - Hardhat: `npx hardhat verify …` against the Blockscout endpoint.
  - Blockscout can also auto-verify on deploy via bytecode matching against already-seen contracts
    (useful — V3 factory/pool bytecode is likely already indexed from Uniswap's own deployment).
- Blockscout Pro API available for enriched data.

## 5. Indexing / data

- **The Graph officially supports Robinhood Chain Mainnet** (`thegraph.com/docs/en/supported-networks/robinhood/`):
  both **Subgraphs** and **Substreams** are supported on the decentralized network; network
  identifier `robinhood`, CAIP-2 `eip155:4663`. Quick-start guides exist. So the official
  Uniswap V3 subgraph can be re-pointed/deployed here rather than requiring custom indexing.
- Alternatives: Blockscout Pro API, SQD (Subsquid) has published Robinhood Chain guides, and the
  standard Alchemy/QuickNode data APIs.

---

## Confidence / gaps

**High confidence (multiple sources, incl. official docs):**
- Chain ID 4663 (mainnet) / 46630 (testnet), RPC/WSS/explorer URLs, ETH gas token, Arbitrum-L2
  architecture, mainnet-live status.
- WETH + USDG canonical addresses (from official `docs.robinhood.com/chain/contracts/`).
- Foundry/Hardhat + Blockscout verification + The Graph subgraph/substreams support.
- **Uniswap Labs officially deployed v2/v3/v4/UniswapX on Robinhood Chain, live from day one**
  (Uniswap blog + Binance Square + CoinGecko showing live "Uniswap V3 (Robinhood)" USDG/WETH pool).

**Confirmed but addresses not yet captured:**
- Exact **Uniswap V3 contract addresses** (v3 factory, SwapRouter02, NonfungiblePositionManager,
  QuoterV2, TickLens, multicall) on chain 4663 were **not** in the Uniswap blog post. They are on
  the linked **"Robinhood Chain Deployments"** page under
  `https://developers.uniswap.org/docs/protocols/v3/deployments` and can be cross-checked on
  Blockscout. Build team should pull these before integrating rather than guessing.

**Unverified / to confirm before building:**
- Exact **ArbOS version and EVM target hardfork** (Shanghai vs Cancun) — not documented. Irrelevant
  for V3 (0.7.6) but matters if you also deploy modern 0.8.2x contracts; set `evm_version` explicitly
  if unsure.
- Whether the Uniswap deployment went through formal **Uniswap governance** vs a Labs/partner
  deployment — sources say "official Uniswap deployment" but the governance-vote provenance wasn't
  independently confirmed. Does not affect technical usability.
- I did not on-chain-verify the WETH/USDG byte addresses via an RPC call; they come from the docs
  page. Recommend a `cast code`/explorer sanity check.

**Bottom line:** No blocking incompatibility identified. V3 is not merely deployable — it is already
running in production on Robinhood Chain mainnet.

---

## Sources

- Robinhood Chain docs — About: https://docs.robinhood.com/chain/
- Robinhood Chain docs — Connecting (chain IDs, RPC, WSS): https://docs.robinhood.com/chain/connecting/
- Robinhood Chain docs — Deploy smart contracts (Foundry/Hardhat, verification): https://docs.robinhood.com/chain/deploy-smart-contracts/
- Robinhood Chain docs — Token contracts (WETH, USDG): https://docs.robinhood.com/chain/contracts/
- Robinhood — Chain mainnet launch: https://robinhood.com/us/en/chain/
- Robinhood — Chain testnet launch newsroom: https://robinhood.com/us/en/newsroom/robinhood-chain-launches-public-testnet/
- Uniswap blog — "Uniswap is Live on Robinhood Chain": https://blog.uniswap.org/robinhood-chain-is-live
- Uniswap v3 deployments (chain-specific address list): https://developers.uniswap.org/docs/protocols/v3/deployments
- Binance Square — Uniswap V2/V3/V4/UniswapX launch on Robinhood Chain: https://www.binance.com/en-JP/square/post/07-02-2026-uniswap-v2-v3-v4-and-uniswapx-launch-on-robinhood-chain-340221305627905
- CoinGecko — Robinhood Wrapped ETH (shows live Uniswap V3 USDG/WETH pool): https://www.coingecko.com/en/coins/robinhood-wrapped-eth-robinhood-chain
- The Graph — Robinhood Chain Mainnet supported network: https://thegraph.com/docs/en/supported-networks/robinhood/
- Blockscout — Robinhood Chain explorer: https://robinhoodchain.blockscout.com/
- Blockscout blog — Build on Robinhood Chain with the Pro API: https://www.blog.blockscout.com/build-on-robinhood-chain-with-the-blockscout-pro-api/
- Alchemy — Robinhood Chain Mainnet is Live: https://www.alchemy.com/blog/robinhood-chain-mainnet-is-live-on-alchemy
- Arbitrum docs — Solidity support (PUSH0 / evm-version guidance): https://docs.arbitrum.io/solidity-support
- Arbitrum forum — ArbOS Version 11 (Shanghai/PUSH0 support): https://forum.arbitrum.foundation/t/aip-arbos-version-11/19696
- Global Dollar Network (USDG native on Robinhood Chain): https://x.com/global_dollar/status/2072395620342706266
- CoinDesk — Robinhood rolls out public blockchain (2026-07-01): https://www.coindesk.com/business/2026/07/01/robinhood-rolls-out-public-blockchain-as-it-expands-deeper-into-crypto
