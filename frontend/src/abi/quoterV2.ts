// Minimal Uniswap v3-periphery QuoterV2 ABI — exact swap quotes for graduated pools.
//
// `quoteExactInputSingle` is NOT a view function: the quoter executes a real swap against the pool
// and reverts with the result encoded in the revert data, which it decodes and returns. So it must
// be called with `eth_call` (wagmi's useSimulateContract), never sent as a transaction — a
// transaction would burn gas and revert.
export const quoterV2Abi = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'fee', type: 'uint24' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96After', type: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
] as const
