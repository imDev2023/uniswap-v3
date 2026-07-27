import { BigInt, Bytes, Address } from "@graphprotocol/graph-ts";

export const FACTORY_ID = "launchpad";

export let ZERO_BI = BigInt.fromI32(0);

/// Graduation progress used to be measured against a CURVE_SUPPLY constant hardcoded here — an
/// unverifiable copy of a Solidity constant that would have drifted silently if the contract ever
/// changed it. Since build #24 `LaunchCreated` emits `curveTokenAllocation`, so progress is measured
/// against the value each launch actually froze (`Token.curveTokenAllocation`) and the constant is gone.
export let BPS = BigInt.fromI32(10000);

/// Fixed-point scale for `priceX18`, matching `BondingCurve.priceX18()`.
export let ONE_E18 = BigInt.fromString("1000000000000000000");

/// Deterministic per-(token, account) holder id: 20-byte token ++ 20-byte account.
export function holderId(token: Bytes, account: Address): Bytes {
  return token.concat(account as Bytes);
}
