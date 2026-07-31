// The LaunchToken-specific reads, kept apart from the generic erc20 ABI because `metadataURI` is
// ours, not part of ERC-20 - and reading it against an arbitrary address is expected to fail.
export const launchTokenAbi = [
  // Constructor-set in build #24, with no setter for anyone. Readable over plain RPC, which is what
  // lets the token and swap pages show a launch's identity through an indexer outage.
  {
    type: 'function',
    name: 'metadataURI',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
] as const
