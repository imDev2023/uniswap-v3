import { Address, BigInt, ethereum, Bytes } from "@graphprotocol/graph-ts";
import { newMockEvent } from "matchstick-as";
import { LaunchCreated } from "../generated/LaunchpadFactory/LaunchpadFactory";
import { Graduated } from "../generated/GraduationManager/GraduationManager";
import { Bought, Sold, Graduation } from "../generated/templates/BondingCurve/BondingCurve";

// Deterministic fixtures shared across tests.
export let TOKEN = Address.fromString("0x1111111111111111111111111111111111111111");
export let CURVE = Address.fromString("0x2222222222222222222222222222222222222222");
export let CREATOR = Address.fromString("0x3333333333333333333333333333333333333333");
export let BUYER = Address.fromString("0x4444444444444444444444444444444444444444");
export let BUYER2 = Address.fromString("0x5555555555555555555555555555555555555555");
export let POOL = Address.fromString("0x6666666666666666666666666666666666666666");

export function bi(v: string): BigInt {
  return BigInt.fromString(v);
}

/// Stamp a mock event with a deterministic block timestamp, block number, and log index.
function stamp(event: ethereum.Event, timestamp: i64, block: i64, logIndex: i64): void {
  event.block.timestamp = BigInt.fromI64(timestamp);
  event.block.number = BigInt.fromI64(block);
  event.logIndex = BigInt.fromI64(logIndex);
}

// Production curve calibration (LaunchpadFactory's DEFAULT_* constants), used by
// `defaultLaunchCreatedEvent` so tests that don't care about params read cleanly.
export let V_ETH = "30000000000000000000"; // 30 ETH
export let V_TOKEN = "1066666666666666666666666666"; // 800M^2 / 600M
export let ALLOCATION = "800000000000000000000000000"; // 800M
export let TRADE_FEE_BPS = 100; // 1%
export let MAX_BUY = "8000000000000000000000000"; // 8M (1% of the curve allocation)
export let SNIPE_THRESHOLD = "120000000000000000000000000"; // 120M (15%)

/// Full-arity LaunchCreated, for tests that assert on the metadata URI or the frozen curve params.
export function launchCreatedEvent(
  token: Address,
  curve: Address,
  creator: Address,
  name: string,
  symbol: string,
  metadataURI: string,
  virtualEthReserve: BigInt,
  virtualTokenReserve: BigInt,
  curveTokenAllocation: BigInt,
  tradeFeeBps: i32,
  maxBuyPerWallet: BigInt,
  antiSnipeThreshold: BigInt
): LaunchCreated {
  let e = changetype<LaunchCreated>(newMockEvent());
  e.parameters = new Array<ethereum.EventParam>();
  e.parameters.push(new ethereum.EventParam("token", ethereum.Value.fromAddress(token)));
  e.parameters.push(new ethereum.EventParam("curve", ethereum.Value.fromAddress(curve)));
  e.parameters.push(new ethereum.EventParam("creator", ethereum.Value.fromAddress(creator)));
  e.parameters.push(new ethereum.EventParam("name", ethereum.Value.fromString(name)));
  e.parameters.push(new ethereum.EventParam("symbol", ethereum.Value.fromString(symbol)));
  e.parameters.push(new ethereum.EventParam("metadataURI", ethereum.Value.fromString(metadataURI)));
  e.parameters.push(
    new ethereum.EventParam("virtualEthReserve", ethereum.Value.fromUnsignedBigInt(virtualEthReserve))
  );
  e.parameters.push(
    new ethereum.EventParam("virtualTokenReserve", ethereum.Value.fromUnsignedBigInt(virtualTokenReserve))
  );
  e.parameters.push(
    new ethereum.EventParam("curveTokenAllocation", ethereum.Value.fromUnsignedBigInt(curveTokenAllocation))
  );
  e.parameters.push(new ethereum.EventParam("tradeFeeBps", ethereum.Value.fromI32(tradeFeeBps)));
  e.parameters.push(new ethereum.EventParam("maxBuyPerWallet", ethereum.Value.fromUnsignedBigInt(maxBuyPerWallet)));
  e.parameters.push(
    new ethereum.EventParam("antiSnipeThreshold", ethereum.Value.fromUnsignedBigInt(antiSnipeThreshold))
  );
  stamp(e, 1000, 100, 0);
  return e;
}

/// LaunchCreated on the production calibration, for tests whose subject is something else.
export function defaultLaunchCreatedEvent(
  token: Address,
  curve: Address,
  creator: Address,
  name: string,
  symbol: string
): LaunchCreated {
  return launchCreatedEvent(
    token,
    curve,
    creator,
    name,
    symbol,
    "ipfs://QmTestMetadata",
    bi(V_ETH),
    bi(V_TOKEN),
    bi(ALLOCATION),
    TRADE_FEE_BPS,
    bi(MAX_BUY),
    bi(SNIPE_THRESHOLD)
  );
}

/// NOTE: `token` leads the parameter list because build #24 made it the first (indexed) arg of
/// `Bought`. Generated param getters index into this array positionally, so omitting it here would
/// silently shift every later field — `buyer` would decode as an amount rather than failing loudly.
export function boughtEvent(
  token: Address,
  buyer: Address,
  ethIn: BigInt,
  ethToCurve: BigInt,
  fee: BigInt,
  tokensOut: BigInt,
  newPriceX18: BigInt,
  ethReserve: BigInt,
  tokenReserve: BigInt,
  tokensSold: BigInt,
  timestamp: i64,
  logIndex: i64
): Bought {
  let e = changetype<Bought>(newMockEvent());
  e.parameters = new Array<ethereum.EventParam>();
  e.parameters.push(new ethereum.EventParam("token", ethereum.Value.fromAddress(token)));
  e.parameters.push(new ethereum.EventParam("buyer", ethereum.Value.fromAddress(buyer)));
  e.parameters.push(new ethereum.EventParam("ethIn", ethereum.Value.fromUnsignedBigInt(ethIn)));
  e.parameters.push(new ethereum.EventParam("ethToCurve", ethereum.Value.fromUnsignedBigInt(ethToCurve)));
  e.parameters.push(new ethereum.EventParam("fee", ethereum.Value.fromUnsignedBigInt(fee)));
  e.parameters.push(new ethereum.EventParam("tokensOut", ethereum.Value.fromUnsignedBigInt(tokensOut)));
  e.parameters.push(new ethereum.EventParam("newPriceX18", ethereum.Value.fromUnsignedBigInt(newPriceX18)));
  e.parameters.push(new ethereum.EventParam("ethReserve", ethereum.Value.fromUnsignedBigInt(ethReserve)));
  e.parameters.push(new ethereum.EventParam("tokenReserve", ethereum.Value.fromUnsignedBigInt(tokenReserve)));
  e.parameters.push(new ethereum.EventParam("tokensSold", ethereum.Value.fromUnsignedBigInt(tokensSold)));
  stamp(e, timestamp, 101, logIndex);
  return e;
}

/// See `boughtEvent`: `token` leads for the same positional-decoding reason.
export function soldEvent(
  token: Address,
  seller: Address,
  tokensIn: BigInt,
  ethOut: BigInt,
  fee: BigInt,
  newPriceX18: BigInt,
  ethReserve: BigInt,
  tokenReserve: BigInt,
  tokensSold: BigInt,
  timestamp: i64,
  logIndex: i64
): Sold {
  let e = changetype<Sold>(newMockEvent());
  e.parameters = new Array<ethereum.EventParam>();
  e.parameters.push(new ethereum.EventParam("token", ethereum.Value.fromAddress(token)));
  e.parameters.push(new ethereum.EventParam("seller", ethereum.Value.fromAddress(seller)));
  e.parameters.push(new ethereum.EventParam("tokensIn", ethereum.Value.fromUnsignedBigInt(tokensIn)));
  e.parameters.push(new ethereum.EventParam("ethOut", ethereum.Value.fromUnsignedBigInt(ethOut)));
  e.parameters.push(new ethereum.EventParam("fee", ethereum.Value.fromUnsignedBigInt(fee)));
  e.parameters.push(new ethereum.EventParam("newPriceX18", ethereum.Value.fromUnsignedBigInt(newPriceX18)));
  e.parameters.push(new ethereum.EventParam("ethReserve", ethereum.Value.fromUnsignedBigInt(ethReserve)));
  e.parameters.push(new ethereum.EventParam("tokenReserve", ethereum.Value.fromUnsignedBigInt(tokenReserve)));
  e.parameters.push(new ethereum.EventParam("tokensSold", ethereum.Value.fromUnsignedBigInt(tokensSold)));
  stamp(e, timestamp, 102, logIndex);
  return e;
}

export function graduationEvent(pool: Address, raisedEth: BigInt, timestamp: i64, logIndex: i64): Graduation {
  let e = changetype<Graduation>(newMockEvent());
  e.parameters = new Array<ethereum.EventParam>();
  e.parameters.push(new ethereum.EventParam("pool", ethereum.Value.fromAddress(pool)));
  e.parameters.push(new ethereum.EventParam("raisedEth", ethereum.Value.fromUnsignedBigInt(raisedEth)));
  stamp(e, timestamp, 103, logIndex);
  return e;
}

export function graduatedEvent(
  token: Address,
  pool: Address,
  tokenId: BigInt,
  tokensSeeded: BigInt,
  wethSeeded: BigInt,
  sqrtPriceX96: BigInt,
  timestamp: i64,
  logIndex: i64
): Graduated {
  let e = changetype<Graduated>(newMockEvent());
  e.parameters = new Array<ethereum.EventParam>();
  e.parameters.push(new ethereum.EventParam("token", ethereum.Value.fromAddress(token)));
  e.parameters.push(new ethereum.EventParam("pool", ethereum.Value.fromAddress(pool)));
  e.parameters.push(new ethereum.EventParam("tokenId", ethereum.Value.fromUnsignedBigInt(tokenId)));
  e.parameters.push(new ethereum.EventParam("tokensSeeded", ethereum.Value.fromUnsignedBigInt(tokensSeeded)));
  e.parameters.push(new ethereum.EventParam("wethSeeded", ethereum.Value.fromUnsignedBigInt(wethSeeded)));
  e.parameters.push(new ethereum.EventParam("sqrtPriceX96", ethereum.Value.fromUnsignedBigInt(sqrtPriceX96)));
  stamp(e, timestamp, 103, logIndex);
  return e;
}

/// The deterministic Holder id used by the mappings: 20-byte token ++ 20-byte account, hex-encoded.
export function holderIdHex(token: Address, account: Address): string {
  return (token as Bytes).concat(account as Bytes).toHexString();
}
