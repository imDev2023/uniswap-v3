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

export function launchCreatedEvent(
  token: Address,
  curve: Address,
  creator: Address,
  name: string,
  symbol: string
): LaunchCreated {
  let e = changetype<LaunchCreated>(newMockEvent());
  e.parameters = new Array<ethereum.EventParam>();
  e.parameters.push(new ethereum.EventParam("token", ethereum.Value.fromAddress(token)));
  e.parameters.push(new ethereum.EventParam("curve", ethereum.Value.fromAddress(curve)));
  e.parameters.push(new ethereum.EventParam("creator", ethereum.Value.fromAddress(creator)));
  e.parameters.push(new ethereum.EventParam("name", ethereum.Value.fromString(name)));
  e.parameters.push(new ethereum.EventParam("symbol", ethereum.Value.fromString(symbol)));
  stamp(e, 1000, 100, 0);
  return e;
}

export function boughtEvent(
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

export function soldEvent(
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
