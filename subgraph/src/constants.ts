import { BigInt, Bytes, Address } from "@graphprotocol/graph-ts";

export const FACTORY_ID = "launchpad";

export let ZERO_BI = BigInt.fromI32(0);

export let BPS = BigInt.fromI32(10000);

/// Fixed-point scale for `priceX18`, matching `BondingCurve.priceX18()`.
export let ONE_E18 = BigInt.fromString("1000000000000000000");

/// `LPLock` has no permanent flag: it encodes a permanent lock as `lockUntil == type(uint64).max`.
/// ⚠️ Compared against, never rendered. A client that treated this as a real date would show a lock
/// expiring in the year 584942417355.
export let PERMANENT_LOCK_SENTINEL = BigInt.fromString("18446744073709551615");

/// `LockOrigin` as the schema enum's string values, indexed by the on-chain enum's own ordering.
/// ⚠️ Index 0 MUST stay `None`. The contract reserves the zero slot so that an unregistered key -
/// every field of which reads as zero - can never be mistaken for a reclaimable launch position.
export let LOCK_ORIGINS: string[] = ["None", "Launch", "ThirdParty"];

/// Deterministic per-(token, account) position id: 20-byte token ++ 20-byte account.
export function curvePositionId(token: Bytes, account: Address): Bytes {
  return token.concat(account as Bytes);
}
