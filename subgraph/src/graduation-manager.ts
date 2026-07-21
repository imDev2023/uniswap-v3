import { Graduated } from "../generated/GraduationManager/GraduationManager";
import { Graduation, Token } from "../generated/schema";
import { loadFactory } from "./factory";

/// A token graduated into a permanently-locked, full-range V3 pool. This event carries the pool, the
/// locked position NFT id, and the seeded amounts, so it's authoritative for the "just graduated"
/// feed. `wethSeeded` equals the ETH raised on the curve (the curve forwards 100% of the raise as the
/// mint's WETH side), so we use it as `raisedEth` too. Fires before the curve's own Graduation echo
/// in the same tx.
export function handleGraduated(event: Graduated): void {
  let token = Token.load(event.params.token);
  if (token == null) return;

  let grad = new Graduation(event.params.token);
  grad.token = token.id;
  grad.pool = event.params.pool;
  grad.tokenId = event.params.tokenId;
  grad.tokensSeeded = event.params.tokensSeeded;
  grad.wethSeeded = event.params.wethSeeded;
  grad.sqrtPriceX96 = event.params.sqrtPriceX96;
  grad.raisedEth = event.params.wethSeeded;
  grad.timestamp = event.block.timestamp;
  grad.block = event.block.number;
  grad.txHash = event.transaction.hash;
  grad.save();

  token.graduated = true;
  token.graduatedAtTimestamp = event.block.timestamp;
  token.graduation = grad.id;
  token.save();

  let factory = loadFactory();
  factory.graduationCount = factory.graduationCount + 1;
  factory.totalRaisedEth = factory.totalRaisedEth.plus(event.params.wethSeeded);
  factory.save();
}
