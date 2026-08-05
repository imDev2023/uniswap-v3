import { Claimed } from "../generated/DevVesting/DevVesting";
import { Token } from "../generated/schema";

/// The creator claimed vested tokens (#35).
///
/// ⚠️ Accumulates rather than assigning: `Claimed.amount` is the size of THIS claim, not the running
/// total. The event's `remaining` field is the unclaimed balance, so `total - remaining` would also
/// work, but summing the deltas keeps this handler independent of the grant total.
///
/// This handler is the SOLE owner of `devClaimed`, exactly as `handleLaunchConfig` is the sole owner
/// of `devAllocation` and `vestingDuration`.
///
/// ⚠️ `GrantRegistered` is deliberately NOT indexed, though `DevVesting` is a fixed-address data
/// source and indexing it would be free. It carries `amount` and `duration`, both of which
/// `LaunchConfig` already delivers, from the same transaction, for every launch. Writing them here
/// too meant two handlers owning one field - the exact thing `handleLaunchConfig` refuses to do with
/// `devClaimed` - and it could not serve as a fallback either, because a zero carve registers no
/// grant and so emits nothing at all. A second writer that agrees by construction is not a
/// cross-check; it is one more place the value can come from. It was also untestable: the handler
/// could be gutted to a no-op and the whole matchstick suite stayed green, because the only test of
/// it asserted values `LaunchConfig` had already written.
export function handleClaimed(event: Claimed): void {
  let token = Token.load(event.params.token);
  if (token == null) return;

  token.devClaimed = token.devClaimed.plus(event.params.amount);
  token.save();
}
