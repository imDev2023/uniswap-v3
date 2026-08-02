# A Launch's metadata URI is immutable, with no setter for anyone

A Launch Token stores a pointer to its off-chain metadata, set once in the constructor.
There is **no setter - not for the creator, not for the owner, not for anyone, ever** - because the product's core promise is that a launch cannot be changed out from under the people who bought it, and a mutable metadata pointer is a bait-and-switch waiting to happen: clean art at launch, swapped once the curve fills.

## Considered options

Making it owner-settable, or creator-settable with a timelock, was considered and rejected.
Both reintroduce exactly the trust assumption that the permanently-locked LP exists to remove, and neither has a version that is safe against the creator, who is the party we are protecting buyers *from*.

## Consequences

- **A typo, a dead host or an unpinned document is permanent and uncorrectable.** The failure path is therefore the common path, not an edge case: every reader must fall back gracefully, and the identicon is a first-class state rather than an error.
- **Abusive imagery cannot be removed on-chain.** Moderation is necessarily a client-side denylist, which is why one exists.
- The client cannot fix a bad URI after the fact, so **the only place a mistake can be prevented is the create form** - before the irreversible write. That form currently accepts anything, which is a known open defect.
- Content-addressed metadata can be cached forever, since a given pointer addresses exactly one document.
