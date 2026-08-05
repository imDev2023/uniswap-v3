import { Address, BigInt, Bytes, dataSource } from "@graphprotocol/graph-ts";
import { Bought, Sold, Graduation } from "../generated/templates/BondingCurve/BondingCurve";
import { Token, Trade, CurvePosition } from "../generated/schema";
import { loadFactory } from "./factory";
import { BPS, ZERO_BI, curvePositionId } from "./constants";

/// The token this curve belongs to, from the template's data-source context (set in factory.ts).
function contextToken(): Bytes {
  return dataSource.context().getBytes("token");
}

/// Refresh the live curve snapshot on a token from a trade's post-state fields.
function refreshCurveState(
  token: Token,
  ethReserve: BigInt,
  tokenReserve: BigInt,
  tokensSold: BigInt,
  priceX18: BigInt,
  timestamp: BigInt
): void {
  token.ethReserve = ethReserve;
  token.tokenReserve = tokenReserve;
  token.tokensSold = tokensSold;
  token.priceX18 = priceX18;
  // Progress is measured against the allocation THIS launch froze (from LaunchCreated), not a
  // constant copied out of the Solidity source. The guard is not expected to fire — the allocation
  // is always the 800M curve supply — but a division by zero would halt the whole subgraph
  // deterministically, which is a disproportionate failure for an unreachable branch.
  if (token.curveTokenAllocation.gt(ZERO_BI)) {
    token.progressBps = tokensSold.times(BPS).div(token.curveTokenAllocation).toI32();
  }
  token.lastTradeTimestamp = timestamp;
}

/// Buy on the curve: record the trade, refresh curve progress, credit the buyer's curve position.
export function handleBought(event: Bought): void {
  let token = Token.load(contextToken());
  if (token == null) return;

  let trade = new Trade(tradeId(event.transaction.hash, event.logIndex));
  trade.token = token.id;
  trade.trader = event.params.buyer;
  trade.type = "BUY";
  trade.amountEth = event.params.ethIn;
  trade.ethToCurve = event.params.ethToCurve;
  trade.fee = event.params.fee;
  trade.amountToken = event.params.tokensOut;
  trade.priceX18 = event.params.newPriceX18;
  trade.ethReserve = event.params.ethReserve;
  trade.tokenReserve = event.params.tokenReserve;
  trade.tokensSold = event.params.tokensSold;
  trade.timestamp = event.block.timestamp;
  trade.block = event.block.number;
  trade.txHash = event.transaction.hash;
  trade.logIndex = event.logIndex;
  trade.save();

  refreshCurveState(
    token,
    event.params.ethReserve,
    event.params.tokenReserve,
    event.params.tokensSold,
    event.params.newPriceX18,
    event.block.timestamp
  );
  // Volume is ETH actually traded against the curve: reserves-in + fee. On the graduation-crossing
  // buy `ethIn` (msg.value) includes a refund of the overshoot, which never reaches the curve — so
  // `ethToCurve + fee` (== ethIn - refund) is the truthful basis and equals ethIn on ordinary buys.
  let volume = event.params.ethToCurve.plus(event.params.fee);
  token.buyCount = token.buyCount + 1;
  token.tradeCount = token.tradeCount + 1;
  token.volumeEth = token.volumeEth.plus(volume);

  applyCurvePositionDelta(token, event.params.buyer, event.params.tokensOut, true, event.block.timestamp);
  token.save();

  let factory = loadFactory();
  factory.buyCount = factory.buyCount + 1;
  factory.tradeCount = factory.tradeCount + 1;
  factory.totalVolumeEth = factory.totalVolumeEth.plus(volume);
  factory.save();
}

/// Sell back to the curve: record the trade, refresh curve state, debit the seller's curve position.
export function handleSold(event: Sold): void {
  let token = Token.load(contextToken());
  if (token == null) return;

  let trade = new Trade(tradeId(event.transaction.hash, event.logIndex));
  trade.token = token.id;
  trade.trader = event.params.seller;
  trade.type = "SELL";
  trade.amountEth = event.params.ethOut;
  trade.ethToCurve = ZERO_BI;
  trade.fee = event.params.fee;
  trade.amountToken = event.params.tokensIn;
  trade.priceX18 = event.params.newPriceX18;
  trade.ethReserve = event.params.ethReserve;
  trade.tokenReserve = event.params.tokenReserve;
  trade.tokensSold = event.params.tokensSold;
  trade.timestamp = event.block.timestamp;
  trade.block = event.block.number;
  trade.txHash = event.transaction.hash;
  trade.logIndex = event.logIndex;
  trade.save();

  refreshCurveState(
    token,
    event.params.ethReserve,
    event.params.tokenReserve,
    event.params.tokensSold,
    event.params.newPriceX18,
    event.block.timestamp
  );
  // Gross ETH removed from the curve on the sell: what the seller receives + the fee (symmetric with
  // the buy-side basis above).
  let volume = event.params.ethOut.plus(event.params.fee);
  token.sellCount = token.sellCount + 1;
  token.tradeCount = token.tradeCount + 1;
  token.volumeEth = token.volumeEth.plus(volume);

  applyCurvePositionDelta(token, event.params.seller, event.params.tokensIn, false, event.block.timestamp);
  token.save();

  let factory = loadFactory();
  factory.sellCount = factory.sellCount + 1;
  factory.tradeCount = factory.tradeCount + 1;
  factory.totalVolumeEth = factory.totalVolumeEth.plus(volume);
  factory.save();
}

/// Curve-side graduation echo. GraduationManager.Graduated (which carries the pool + seed amounts +
/// raised ETH) fires earlier in the same tx and is authoritative for the feed; this just confirms the
/// graduated flag and backfills the timestamp if that handler somehow hasn't run. Idempotent.
export function handleGraduation(event: Graduation): void {
  let token = Token.load(contextToken());
  if (token == null) return;
  token.graduated = true;
  if (token.graduatedAtTimestamp === null) {
    token.graduatedAtTimestamp = event.block.timestamp;
  }
  token.save();
}

/// Net an account's curve position by `amount` (a gross buy or sell), maintaining the token's count
/// of distinct positive positions. `balance` is clamped at zero so rounding can never drive it
/// negative.
///
/// ⚠️ This tracks CURVE activity only, never ERC-20 balances, and it does not see the creator's dev
/// allocation - that is a free carve rather than a curve buy and lives on `Token.devAllocation`.
function applyCurvePositionDelta(
  token: Token,
  account: Address,
  amount: BigInt,
  isBuy: boolean,
  timestamp: BigInt
): void {
  let id = curvePositionId(token.id, account);
  let position = CurvePosition.load(id);
  if (position == null) {
    position = new CurvePosition(id);
    position.token = token.id;
    position.account = account;
    position.balance = ZERO_BI;
    position.bought = ZERO_BI;
    position.sold = ZERO_BI;
    position.firstTradeTimestamp = timestamp;
    position.lastTradeTimestamp = timestamp;
    position.tradeCount = 0;
  }

  let wasPositive = position.balance.gt(ZERO_BI);

  if (isBuy) {
    position.balance = position.balance.plus(amount);
    position.bought = position.bought.plus(amount);
  } else {
    position.balance = position.balance.minus(amount);
    if (position.balance.lt(ZERO_BI)) position.balance = ZERO_BI;
    position.sold = position.sold.plus(amount);
  }
  position.lastTradeTimestamp = timestamp;
  position.tradeCount = position.tradeCount + 1;
  position.save();

  let isPositive = position.balance.gt(ZERO_BI);
  if (!wasPositive && isPositive) {
    token.curvePositionCount = token.curvePositionCount + 1;
  } else if (wasPositive && !isPositive) {
    token.curvePositionCount = token.curvePositionCount - 1;
  }
}

function tradeId(txHash: Bytes, logIndex: BigInt): Bytes {
  return txHash.concatI32(logIndex.toI32());
}
