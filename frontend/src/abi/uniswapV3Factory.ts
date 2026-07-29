// Minimal typed ABI for the platform's own IUniswapV3Factory - only `getPool`, which is how the app
// resolves a graduated token's pool address WITHOUT the indexer (Stage 2).
//
// The factory address is not configured separately: it is read from
// `LaunchpadFactory.v3Factory()`, an immutable, so the launchpad address baked into the build stays
// the single root of trust for every address the trade path touches.
export const uniswapV3FactoryAbi = [
  {
    type: 'function',
    name: 'getPool',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
      { name: 'fee', type: 'uint24' },
    ],
    outputs: [{ name: 'pool', type: 'address' }],
  },
] as const
