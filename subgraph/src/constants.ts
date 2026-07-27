import { BigInt, Bytes, Address } from "@graphprotocol/graph-ts";

export const FACTORY_ID = "launchpad";

export let ZERO_BI = BigInt.fromI32(0);

export let BPS = BigInt.fromI32(10000);

/// Fixed-point scale for `priceX18`, matching `BondingCurve.priceX18()`.
export let ONE_E18 = BigInt.fromString("1000000000000000000");

/// Deterministic per-(token, account) holder id: 20-byte token ++ 20-byte account.
export function holderId(token: Bytes, account: Address): Bytes {
  return token.concat(account as Bytes);
}
