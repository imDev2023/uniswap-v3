import { Bytes, DataSourceContext } from "@graphprotocol/graph-ts";
import { LaunchCreated, LaunchConfig } from "../generated/LaunchpadFactory/LaunchpadFactory";
import { Factory, Token } from "../generated/schema";
import { BondingCurve } from "../generated/templates";
import { FACTORY_ID, ONE_E18, ZERO_BI } from "./constants";

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
  token.metadataURI = event.params.metadataURI;

  token.createdAtTimestamp = event.block.timestamp;
  token.createdAtBlock = event.block.number;
  token.createdAtTx = event.transaction.hash;

  // The curve params frozen into this launch (build #24). Per-launch, not global: setCurveParams is
  // future-only, so replaying history must attribute each launch the params it was actually created
  // with rather than whatever the factory holds now.
  token.virtualEthReserve = event.params.virtualEthReserve;
  token.virtualTokenReserve = event.params.virtualTokenReserve;
  token.curveTokenAllocation = event.params.curveTokenAllocation;
  token.tradeFeeBps = event.params.tradeFeeBps;
  token.maxBuyPerWallet = event.params.maxBuyPerWallet;
  token.antiSnipeThreshold = event.params.antiSnipeThreshold;

  // The curve does NOT start empty: its constructor seeds the effective reserves to the virtual
  // ones, so it has a real opening price from block zero of its life. Initialising these to 0 (as
  // this handler used to) meant an untraded launch indexed with priceX18 == 0 and displayed a price
  // of zero until somebody happened to trade it. Now the opening state is known at creation.
  token.ethReserve = event.params.virtualEthReserve;
  token.tokenReserve = event.params.virtualTokenReserve;
  token.tokensSold = ZERO_BI;
  // Guarded for the same reason as progressBps in bonding-curve.ts: virtualTokenReserve is always
  // the calibration constant and can never be 0, but a division by zero halts the entire subgraph
  // deterministically — too blunt a failure to risk on an unreachable branch.
  token.priceX18 = event.params.virtualTokenReserve.gt(ZERO_BI)
    ? event.params.virtualEthReserve.times(ONE_E18).div(event.params.virtualTokenReserve)
    : ZERO_BI;
  token.progressBps = 0;
  // No trade has happened yet, so this stays 0 — createdAtTimestamp is the "age" field.
  token.lastTradeTimestamp = ZERO_BI;

  token.buyCount = 0;
  token.sellCount = 0;
  token.tradeCount = 0;
  token.volumeEth = ZERO_BI;
  token.curvePositionCount = 0;

  // Placeholders only. `LaunchConfig` is emitted immediately after `LaunchCreated` in this same
  // transaction and fills all six in; they are initialised here because the schema makes them
  // non-nullable and an entity cannot be saved half-built.
  //
  // ⚠️ If you ever see a launch sitting at these zero values, `LaunchConfig` did not arrive - check
  // the manifest's handler wiring rather than assuming the launch really has no carve and no lock.
  // A zero `devAllocation` is legitimate (the creator took no carve); a zero `lockDuration` is not.
  token.devAllocation = ZERO_BI;
  token.devClaimed = ZERO_BI;
  token.vestingDuration = ZERO_BI;
  token.lockDuration = ZERO_BI;
  token.creatorFeeBps = 0;
  token.permanentLock = false;

  token.graduated = false;
  token.save();

  BondingCurve.createWithContext(event.params.curve, curveContext(event.params.token));

  let factory = loadFactory();
  factory.launchCount = factory.launchCount + 1;
  factory.save();
}

/// The launch's dev carve, vesting schedule and frozen LP lock terms (#36).
///
/// ⚠️ Ordering is a hard dependency, not an optimisation. `LaunchConfig` is emitted AFTER
/// `LaunchCreated` in the same transaction, deliberately, so the Token entity exists by the time
/// this runs. If the emit sites are ever reordered this handler loads null and drops the config
/// silently - which is why `LaunchConfig.t.sol` pins the log order on the contract side.
///
/// Guarded rather than assumed: a null Token means that ordering broke, and skipping is better than
/// constructing a half-built entity that would then look like a real launch missing its curve params.
export function handleLaunchConfig(event: LaunchConfig): void {
  let token = Token.load(event.params.token);
  if (token == null) return;

  token.devAllocation = event.params.devAllocation;
  token.vestingDuration = event.params.vestingDuration;
  token.lockDuration = event.params.lockDuration;
  token.creatorFeeBps = event.params.creatorFeeBps;
  token.permanentLock = event.params.permanentLock;
  // devClaimed is NOT touched here. It is owned by the DevVesting Claimed handler, and vesting
  // cannot start until graduation, so it is always still zero at this point - but writing it would
  // make this handler a second owner of the field, and a replay would then reset a real balance.
  token.save();
}

/// Pass the token address to the curve template so its handlers can resolve their Token.
function curveContext(token: Bytes): DataSourceContext {
  let ctx = new DataSourceContext();
  ctx.setBytes("token", token);
  return ctx;
}
