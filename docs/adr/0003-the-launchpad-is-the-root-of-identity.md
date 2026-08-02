# The launchpad is the root of identity, not the token

To decide whether an address is a genuine Octopus Launch, the Trading UI asks **our launchpad** "is this token yours?" and treats a non-empty answer as membership.
It deliberately does **not** ask the token which launchpad it belongs to, even though the token carries a back-reference and that lookup is one call shorter.

## Consequences

- **The shorter path is a spoofing vector, which is why it is not taken.** A token is an arbitrary contract that can name any launchpad it likes. Trusting a token's own claim would let a hostile ERC-20 at `/token/0x…` point the UI at a fake curve and collect real ETH. Asking our own launchpad cannot be spoofed, because the answer comes from a contract we deployed.
- The token's back-reference still has a legitimate use - discovering *which* launchpad to ask when you have no prior knowledge of the factory set - but its answer must then be verified against that launchpad, never trusted directly.
- This is a **security boundary wearing the costume of a lookup**. It will look like redundant indirection to anyone optimising the resolution path. It is not.
- Verified in practice: a well-known non-Launch token correctly resolves to "not a token launched on Octopus".
