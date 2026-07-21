import { BigInt, Bytes, Address } from "@graphprotocol/graph-ts";

export const FACTORY_ID = "launchpad";

export let ZERO_BI = BigInt.fromI32(0);

/// The curve sells at most 800,000,000 tokens (LaunchpadFactory.CURVE_SUPPLY). Graduation progress
/// is measured against this fixed allocation, so it is a constant here rather than an eth_call.
export let CURVE_SUPPLY = BigInt.fromString("800000000000000000000000000");
export let BPS = BigInt.fromI32(10000);

/// Deterministic per-(token, account) holder id: 20-byte token ++ 20-byte account.
export function holderId(token: Bytes, account: Address): Bytes {
  return token.concat(account as Bytes);
}
