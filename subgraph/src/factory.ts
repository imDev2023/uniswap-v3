import { Bytes, DataSourceContext } from "@graphprotocol/graph-ts";
import { LaunchCreated } from "../generated/LaunchpadFactory/LaunchpadFactory";
import { Factory, Token } from "../generated/schema";
import { BondingCurve } from "../generated/templates";
import { FACTORY_ID, ZERO_BI } from "./constants";

/// Load the singleton Factory rollup, creating it on first launch.
export function loadFactory(): Factory {
  let factory = Factory.load(FACTORY_ID);
  if (factory == null) {
    factory = new Factory(FACTORY_ID);
    factory.launchCount = 0;
    factory.graduationCount = 0;
    factory.tradeCount = 0;
    factory.buyCount = 0;
    factory.sellCount = 0;
    factory.totalVolumeEth = ZERO_BI;
    factory.totalRaisedEth = ZERO_BI;
  }
  return factory as Factory;
}

/// A new launch: record the token + its (empty) curve state, and start indexing the curve. The curve
/// address isn't known until this event, so we spin up a BondingCurve template for it, passing the
/// token address through the data-source context so curve handlers can resolve their Token.
export function handleLaunchCreated(event: LaunchCreated): void {
  let token = new Token(event.params.token);
  token.curve = event.params.curve;
  token.creator = event.params.creator;
  token.name = event.params.name;
  token.symbol = event.params.symbol;

  token.createdAtTimestamp = event.block.timestamp;
  token.createdAtBlock = event.block.number;
  token.createdAtTx = event.transaction.hash;

  // Curve state starts empty; the first Bought/Sold refreshes reserves from the event payload.
  token.ethReserve = ZERO_BI;
  token.tokenReserve = ZERO_BI;
  token.tokensSold = ZERO_BI;
  token.priceX18 = ZERO_BI;
  token.progressBps = 0;
  token.lastTradeTimestamp = ZERO_BI;

  token.buyCount = 0;
  token.sellCount = 0;
  token.tradeCount = 0;
  token.volumeEth = ZERO_BI;
  token.holderCount = 0;

  token.graduated = false;
  token.save();

  BondingCurve.createWithContext(event.params.curve, curveContext(event.params.token));

  let factory = loadFactory();
  factory.launchCount = factory.launchCount + 1;
  factory.save();
}

/// Pass the token address to the curve template so its handlers can resolve their Token.
function curveContext(token: Bytes): DataSourceContext {
  let ctx = new DataSourceContext();
  ctx.setBytes("token", token);
  return ctx;
}
