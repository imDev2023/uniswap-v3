import { Address, BigInt } from "@graphprotocol/graph-ts";
import { LockRegistered, LockExtended, FeesCollected, Reclaimed } from "../generated/LPLock/LPLock";
import { FeeCollection, Lock, Token } from "../generated/schema";
import { LOCK_ORIGINS, PERMANENT_LOCK_SENTINEL, ZERO_BI } from "./constants";

/// A graduated position was locked (#33).
///
/// ⚠️ Keyed by the position NFT id, NOT by the token: `LPLock` is designed to become a public
/// locking service for arbitrary pairs, where a lock has no launch token at all. `launchToken` is
/// `address(0)` for those, and this handler skips them rather than inventing a Token relation.
export function handleLockRegistered(event: LockRegistered): void {
  let token = Token.load(event.params.launchToken);
  if (token == null) return;

  let lock = new Lock(event.params.tokenId.toString());
  lock.token = token.id;
  lock.pool = event.params.pool;
  // The enum's ZERO slot is `None`, and that ordering is load-bearing on-chain: every field of an
  // unregistered key reads as zero, so a status enum whose first member were the privileged one
  // would silently grant that status to everything never registered.
  // Bounds-guarded: an origin added on-chain but not here would otherwise index out of range and
  // halt the whole subgraph deterministically, which is a disproportionate failure for one unknown
  // enum member. `None` is the honest fallback - it is the schema's "unregistered" value, so an
  // unrecognised origin reads as not-a-launch-position rather than as a reclaimable one.
  let origin = event.params.origin;
  lock.origin = origin < LOCK_ORIGINS.length ? LOCK_ORIGINS[origin] : "None";
  lock.lockUntil = event.params.lockUntil;
  // Derived, because there is no permanent flag on-chain - `LPLock` encodes it as a sentinel.
  lock.permanent = event.params.lockUntil.equals(PERMANENT_LOCK_SENTINEL);
  lock.creatorFeeBps = event.params.creatorFeeBps;
  lock.extendCount = 0;
  lock.reclaimed = false;

  lock.collectionCount = 0;
  lock.creatorFees0 = ZERO_BI;
  lock.creatorFees1 = ZERO_BI;
  lock.treasuryFees0 = ZERO_BI;
  lock.treasuryFees1 = ZERO_BI;

  lock.registeredAtTimestamp = event.block.timestamp;
  lock.registeredAtBlock = event.block.number;
  lock.registeredAtTx = event.transaction.hash;
  lock.save();

  // Link the lock so a launch can reach its position in one hop.
  //
  // ⚠️ `Token.permanentLock` is NOT the same fact and is deliberately not written here. It is the
  // creator's CHOICE AT CREATION, from `LaunchConfig`; `Lock.permanent` is the REALISED state of the
  // position, which `extend` can turn true later. They agree at graduation and can legitimately
  // diverge afterwards, so a client asking "is this position locked forever" must read `Lock`.
  token.lock = lock.id;
  token.save();
}

/// The creator lengthened the lock (#33). Monotonic on-chain: it can only ever move later.
///
/// ⚠️ Does not verify `newLockUntil > oldLockUntil`. The contract enforces that with
/// `CannotShortenLock`, and re-deriving a contract invariant in a mapping creates a second place it
/// can be stated differently. The count is tracked so a UI can show that a lock has been extended,
/// which is a materially different signal from one that never has.
export function handleLockExtended(event: LockExtended): void {
  let lock = Lock.load(event.params.tokenId.toString());
  if (lock == null) return;

  lock.lockUntil = event.params.newLockUntil;
  lock.permanent = event.params.newLockUntil.equals(PERMANENT_LOCK_SENTINEL);
  lock.extendCount = lock.extendCount + 1;
  lock.save();
}

/// Fees were collected from a locked position and split between the treasury and the creator (#39).
///
/// ⚠️ `collect` is PERMISSIONLESS. Its presence proves a collection happened, not that the creator
/// did anything, and its ABSENCE proves nothing at all: a position can accrue fees for a year with
/// no collection ever called, in which case every total here is legitimately zero while the creator
/// is genuinely owed money. Anything rendering these numbers has to say which question it answers.
///
/// ⚠️ A `Lock` only exists for launch positions - `handleLockRegistered` skips third-party ones,
/// which have no launch token and pay 100% to the treasury. Loading it is therefore the filter, and
/// a null lock is a third-party collection rather than an error.
export function handleFeesCollected(event: FeesCollected): void {
  let lock = Lock.load(event.params.tokenId.toString());
  if (lock == null) return;

  // One transaction can collect for several positions, so the log index is part of the key.
  let collection = new FeeCollection(
    event.transaction.hash.toHexString() + "-" + event.logIndex.toString()
  );
  collection.lock = lock.id;
  collection.token = lock.token;
  // ⚠️ Stored VERBATIM in the pool's token0/token1 ordering, not resolved to assets. Resolving them
  // needs `token0()` on the pool, and calling that from here deadlocks the subgraph: our RPC prunes
  // state, so a historical eth_call returns "missing trie node" and graph-node retries forever while
  // still reporting healthy. The client does the attribution at the chain head instead.
  collection.creator0 = event.params.creatorAmount0;
  collection.creator1 = event.params.creatorAmount1;
  collection.treasury0 = event.params.treasuryAmount0;
  collection.treasury1 = event.params.treasuryAmount1;
  // `LPLock` emits the zero address when the split did not apply. Null is the honest reading of
  // "there was no creator side to this collection"; defaulting it to an address would invent one.
  collection.creator = event.params.creator.equals(Address.zero()) ? null : event.params.creator;
  // ⚠️ `FeesCollected` carries no `msg.sender`, so this is the transaction's sender, which is not
  // the caller when a contract sits in between. The schema and the UI both label it as the sender.
  collection.sentBy = event.transaction.from;
  collection.collectedAtTimestamp = event.block.timestamp;
  collection.collectedAtBlock = event.block.number;
  collection.collectedAtTx = event.transaction.hash;
  collection.save();

  lock.collectionCount = lock.collectionCount + 1;
  lock.creatorFees0 = lock.creatorFees0.plus(event.params.creatorAmount0);
  lock.creatorFees1 = lock.creatorFees1.plus(event.params.creatorAmount1);
  lock.treasuryFees0 = lock.treasuryFees0.plus(event.params.treasuryAmount0);
  lock.treasuryFees1 = lock.treasuryFees1.plus(event.params.treasuryAmount1);
  lock.save();
}

/// The position was reclaimed (#33): expired, and no pool activity for >= 180 days. Terminal.
///
/// Tokens are burned and the WETH goes to the treasury, so this is the end of the position's life,
/// not a transfer of it.
export function handleReclaimed(event: Reclaimed): void {
  let lock = Lock.load(event.params.tokenId.toString());
  if (lock == null) return;

  lock.reclaimed = true;
  lock.reclaimedEth = event.params.ethAmount;
  lock.reclaimedTokensBurned = event.params.tokensBurned;
  lock.reclaimedAtTimestamp = event.block.timestamp;
  lock.save();
}
