import { Address, BigInt, ethereum, Bytes } from "@graphprotocol/graph-ts";
import { newMockEvent } from "matchstick-as";
import { LaunchCreated, LaunchConfig } from "../generated/LaunchpadFactory/LaunchpadFactory";
import { Claimed } from "../generated/DevVesting/DevVesting";
import { LockRegistered, LockExtended, Reclaimed } from "../generated/LPLock/LPLock";
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

/// The deterministic CurvePosition id used by the mappings: 20-byte token ++ 20-byte account, hex-encoded.
export function curvePositionIdHex(token: Address, account: Address): string {
  return (token as Bytes).concat(account as Bytes).toHexString();
}

// =================================================================================================
// #36 event builders: LaunchConfig, and the DevVesting / LPLock events that #33-#35 added
// =================================================================================================

/// Production defaults, matching the factory's constants.
export let DEV_ALLOCATION = "40000000000000000000000000"; // 40M == 5% of the 800M curve supply
export let VESTING_DURATION = "2592000"; // 30 days
export let LOCK_DURATION = "31536000"; // 365 days
export let CREATOR_FEE_BPS = 7000; // 70% of the position's LP fees
export let LOCK_TOKEN_ID = "42";
/// LPLock's permanent sentinel: type(uint64).max. Not a date - a flag.
export let PERMANENT_SENTINEL = "18446744073709551615";

export function launchConfigEvent(
  token: Address,
  devAllocation: BigInt,
  vestingDuration: BigInt,
  lockDuration: BigInt,
  creatorFeeBps: i32,
  permanentLock: boolean,
  timestamp: i64,
  logIndex: i64
): LaunchConfig {
  let e = changetype<LaunchConfig>(newMockEvent());
  e.parameters = new Array<ethereum.EventParam>();
  e.parameters.push(new ethereum.EventParam("token", ethereum.Value.fromAddress(token)));
  e.parameters.push(new ethereum.EventParam("devAllocation", ethereum.Value.fromUnsignedBigInt(devAllocation)));
  e.parameters.push(new ethereum.EventParam("vestingDuration", ethereum.Value.fromUnsignedBigInt(vestingDuration)));
  e.parameters.push(new ethereum.EventParam("lockDuration", ethereum.Value.fromUnsignedBigInt(lockDuration)));
  e.parameters.push(new ethereum.EventParam("creatorFeeBps", ethereum.Value.fromI32(creatorFeeBps)));
  e.parameters.push(new ethereum.EventParam("permanentLock", ethereum.Value.fromBoolean(permanentLock)));
  stamp(e, timestamp, 100, logIndex);
  return e;
}

/// The default 5% carve on production terms.
export function defaultLaunchConfigEvent(): LaunchConfig {
  return launchConfigEvent(
    TOKEN, bi(DEV_ALLOCATION), bi(VESTING_DURATION), bi(LOCK_DURATION), CREATOR_FEE_BPS, false, 1000, 1
  );
}

export function claimedEvent(
  token: Address,
  creator: Address,
  amount: BigInt,
  remaining: BigInt,
  timestamp: i64,
  logIndex: i64
): Claimed {
  let e = changetype<Claimed>(newMockEvent());
  e.parameters = new Array<ethereum.EventParam>();
  e.parameters.push(new ethereum.EventParam("token", ethereum.Value.fromAddress(token)));
  e.parameters.push(new ethereum.EventParam("creator", ethereum.Value.fromAddress(creator)));
  e.parameters.push(new ethereum.EventParam("amount", ethereum.Value.fromUnsignedBigInt(amount)));
  e.parameters.push(new ethereum.EventParam("remaining", ethereum.Value.fromUnsignedBigInt(remaining)));
  stamp(e, timestamp, 104, logIndex);
  return e;
}

/// `origin` is the on-chain enum's own ordering: 0 None, 1 Launch, 2 ThirdParty.
export function lockRegisteredEvent(
  tokenId: BigInt,
  launchToken: Address,
  pool: Address,
  origin: i32,
  lockUntil: BigInt,
  creatorFeeBps: i32,
  timestamp: i64,
  logIndex: i64
): LockRegistered {
  let e = changetype<LockRegistered>(newMockEvent());
  e.parameters = new Array<ethereum.EventParam>();
  e.parameters.push(new ethereum.EventParam("tokenId", ethereum.Value.fromUnsignedBigInt(tokenId)));
  e.parameters.push(new ethereum.EventParam("launchToken", ethereum.Value.fromAddress(launchToken)));
  e.parameters.push(new ethereum.EventParam("pool", ethereum.Value.fromAddress(pool)));
  e.parameters.push(new ethereum.EventParam("origin", ethereum.Value.fromI32(origin)));
  e.parameters.push(new ethereum.EventParam("lockUntil", ethereum.Value.fromUnsignedBigInt(lockUntil)));
  e.parameters.push(new ethereum.EventParam("creatorFeeBps", ethereum.Value.fromI32(creatorFeeBps)));
  stamp(e, timestamp, 103, logIndex);
  return e;
}

export function lockExtendedEvent(
  tokenId: BigInt,
  oldLockUntil: BigInt,
  newLockUntil: BigInt,
  timestamp: i64,
  logIndex: i64
): LockExtended {
  let e = changetype<LockExtended>(newMockEvent());
  e.parameters = new Array<ethereum.EventParam>();
  e.parameters.push(new ethereum.EventParam("tokenId", ethereum.Value.fromUnsignedBigInt(tokenId)));
  e.parameters.push(new ethereum.EventParam("oldLockUntil", ethereum.Value.fromUnsignedBigInt(oldLockUntil)));
  e.parameters.push(new ethereum.EventParam("newLockUntil", ethereum.Value.fromUnsignedBigInt(newLockUntil)));
  stamp(e, timestamp, 105, logIndex);
  return e;
}

export function reclaimedEvent(
  tokenId: BigInt,
  launchToken: Address,
  ethAmount: BigInt,
  tokensBurned: BigInt,
  timestamp: i64,
  logIndex: i64
): Reclaimed {
  let e = changetype<Reclaimed>(newMockEvent());
  e.parameters = new Array<ethereum.EventParam>();
  e.parameters.push(new ethereum.EventParam("tokenId", ethereum.Value.fromUnsignedBigInt(tokenId)));
  e.parameters.push(new ethereum.EventParam("launchToken", ethereum.Value.fromAddress(launchToken)));
  e.parameters.push(new ethereum.EventParam("ethAmount", ethereum.Value.fromUnsignedBigInt(ethAmount)));
  e.parameters.push(new ethereum.EventParam("tokensBurned", ethereum.Value.fromUnsignedBigInt(tokensBurned)));
  stamp(e, timestamp, 106, logIndex);
  return e;
}
