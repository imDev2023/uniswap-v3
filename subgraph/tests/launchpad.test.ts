import {
  assert,
  beforeEach,
  clearStore,
  dataSourceMock,
  describe,
  test
} from "matchstick-as";
import { DataSourceContext, BigInt, Bytes } from "@graphprotocol/graph-ts";
import { handleLaunchCreated } from "../src/factory";
import { handleBought, handleSold, handleGraduation } from "../src/bonding-curve";
import { handleGraduated } from "../src/graduation-manager";
import {
  TOKEN,
  CURVE,
  CREATOR,
  BUYER,
  BUYER2,
  POOL,
  bi,
  launchCreatedEvent,
  boughtEvent,
  soldEvent,
  graduationEvent,
  graduatedEvent,
  holderIdHex
} from "./helpers";

// --- shared amounts ------------------------------------------------------------------------------

let CURVE_SUPPLY = "800000000000000000000000000"; // 800M * 1e18
let FIFTEEN_PCT = "120000000000000000000000000"; // 120M * 1e18 -> 1500 bps

// Point the mocked BondingCurve data source at TOKEN (mirrors the context factory.ts sets).
function setCurveContext(): void {
  let ctx = new DataSourceContext();
  ctx.setBytes("token", TOKEN as Bytes);
  dataSourceMock.setContext(ctx);
}

// A launch + a buy that leaves the curve at 15% progress, held by BUYER.
function seedLaunchAndBuy(): void {
  handleLaunchCreated(launchCreatedEvent(TOKEN, CURVE, CREATOR, "Test Token", "TEST"));
  setCurveContext();
  handleBought(
    boughtEvent(
      BUYER,
      bi("1000000000000000000"), // ethIn 1 ETH
      bi("990000000000000000"), // ethToCurve
      bi("10000000000000000"), // fee 0.01 ETH
      bi(FIFTEEN_PCT), // tokensOut -> 120M
      bi("1000000000000000000"), // priceX18
      bi("31000000000000000000"), // ethReserve
      bi("946666666666666666666666666"), // tokenReserve
      bi(FIFTEEN_PCT), // tokensSold
      2000,
      0
    )
  );
}

describe("LaunchCreated", () => {
  beforeEach(() => {
    clearStore();
    dataSourceMock.resetValues();
  });

  test("creates a Token with empty curve state and bumps the Factory launch count", () => {
    handleLaunchCreated(launchCreatedEvent(TOKEN, CURVE, CREATOR, "Test Token", "TEST"));

    let id = TOKEN.toHexString();
    assert.entityCount("Token", 1);
    assert.fieldEquals("Token", id, "curve", CURVE.toHexString());
    assert.fieldEquals("Token", id, "creator", CREATOR.toHexString());
    assert.fieldEquals("Token", id, "name", "Test Token");
    assert.fieldEquals("Token", id, "symbol", "TEST");
    assert.fieldEquals("Token", id, "tokensSold", "0");
    assert.fieldEquals("Token", id, "progressBps", "0");
    assert.fieldEquals("Token", id, "graduated", "false");
    assert.fieldEquals("Token", id, "holderCount", "0");

    assert.fieldEquals("Factory", "launchpad", "launchCount", "1");
  });
});

describe("Bought", () => {
  beforeEach(() => {
    clearStore();
    dataSourceMock.resetValues();
  });

  test("records a BUY trade, refreshes curve progress, and credits the buyer as a holder", () => {
    seedLaunchAndBuy();

    let tokenId = TOKEN.toHexString();
    // curve progress: 120M / 800M = 15% -> 1500 bps
    assert.fieldEquals("Token", tokenId, "tokensSold", FIFTEEN_PCT);
    assert.fieldEquals("Token", tokenId, "progressBps", "1500");
    assert.fieldEquals("Token", tokenId, "priceX18", "1000000000000000000");
    assert.fieldEquals("Token", tokenId, "buyCount", "1");
    assert.fieldEquals("Token", tokenId, "tradeCount", "1");
    assert.fieldEquals("Token", tokenId, "volumeEth", "1000000000000000000");
    assert.fieldEquals("Token", tokenId, "holderCount", "1");

    // one immutable Trade
    assert.entityCount("Trade", 1);

    // holder position
    let hid = holderIdHex(TOKEN, BUYER);
    assert.fieldEquals("Holder", hid, "account", BUYER.toHexString());
    assert.fieldEquals("Holder", hid, "balance", FIFTEEN_PCT);
    assert.fieldEquals("Holder", hid, "bought", FIFTEEN_PCT);
    assert.fieldEquals("Holder", hid, "sold", "0");

    // factory rollups
    assert.fieldEquals("Factory", "launchpad", "buyCount", "1");
    assert.fieldEquals("Factory", "launchpad", "tradeCount", "1");
    assert.fieldEquals("Factory", "launchpad", "totalVolumeEth", "1000000000000000000");
  });

  test("a second buy by the same wallet accumulates its position without double-counting holders", () => {
    seedLaunchAndBuy();
    handleBought(
      boughtEvent(
        BUYER,
        bi("1000000000000000000"),
        bi("990000000000000000"),
        bi("10000000000000000"),
        bi("10000000000000000000000000"), // +10M
        bi("1100000000000000000"),
        bi("32000000000000000000"),
        bi("936666666666666666666666666"),
        bi("130000000000000000000000000"), // 130M sold
        2100,
        0
      )
    );

    let tokenId = TOKEN.toHexString();
    assert.fieldEquals("Token", tokenId, "holderCount", "1");
    assert.fieldEquals("Token", tokenId, "buyCount", "2");
    let hid = holderIdHex(TOKEN, BUYER);
    assert.fieldEquals("Holder", hid, "balance", "130000000000000000000000000");
    assert.fieldEquals("Holder", hid, "tradeCount", "2");
  });

  test("the graduation-crossing buy counts only ETH that reached the curve, not the refund", () => {
    handleLaunchCreated(launchCreatedEvent(TOKEN, CURVE, CREATOR, "Test Token", "TEST"));
    setCurveContext();
    // A crossing buy: msg.value (ethIn) = 5 ETH, but only ethToCurve 2.97 + fee 0.03 = 3 ETH reached
    // the curve; the other 2 ETH was refunded. Volume must be 3 ETH, not 5.
    handleBought(
      boughtEvent(
        BUYER,
        bi("5000000000000000000"), // ethIn (msg.value, includes 2 ETH refund)
        bi("2970000000000000000"), // ethToCurve
        bi("30000000000000000"), // fee
        bi(CURVE_SUPPLY), // tokensOut completes the 800M allocation
        bi("2000000000000000000"),
        bi("120000000000000000000"),
        bi("266666666666666666666666666"),
        bi(CURVE_SUPPLY), // tokensSold == 800M -> 100%
        2000,
        0
      )
    );

    let tokenId = TOKEN.toHexString();
    assert.fieldEquals("Token", tokenId, "progressBps", "10000");
    assert.fieldEquals("Token", tokenId, "volumeEth", "3000000000000000000");
    assert.fieldEquals("Factory", "launchpad", "totalVolumeEth", "3000000000000000000");
  });

  test("a distinct buyer is counted as a separate holder", () => {
    seedLaunchAndBuy();
    handleBought(
      boughtEvent(
        BUYER2,
        bi("500000000000000000"),
        bi("495000000000000000"),
        bi("5000000000000000"),
        bi("5000000000000000000000000"),
        bi("1050000000000000000"),
        bi("31500000000000000000"),
        bi("941666666666666666666666666"),
        bi("125000000000000000000000000"),
        2200,
        0
      )
    );
    assert.fieldEquals("Token", TOKEN.toHexString(), "holderCount", "2");
    assert.entityCount("Holder", 2);
  });
});

describe("Sold", () => {
  beforeEach(() => {
    clearStore();
    dataSourceMock.resetValues();
  });

  test("debits the seller and drops the holder count when the position is fully exited", () => {
    seedLaunchAndBuy();
    // sell the entire 120M position back
    handleSold(
      soldEvent(
        BUYER,
        bi(FIFTEEN_PCT), // tokensIn = whole position
        bi("980000000000000000"), // ethOut
        bi("10000000000000000"), // fee
        bi("999000000000000000"), // priceX18
        bi("30000000000000000000"), // ethReserve back near virtual
        bi("1066666666666666666666666666"), // tokenReserve
        bi("0"), // tokensSold back to 0
        3000,
        0
      )
    );

    let tokenId = TOKEN.toHexString();
    assert.fieldEquals("Token", tokenId, "tokensSold", "0");
    assert.fieldEquals("Token", tokenId, "progressBps", "0");
    assert.fieldEquals("Token", tokenId, "sellCount", "1");
    assert.fieldEquals("Token", tokenId, "tradeCount", "2");
    assert.fieldEquals("Token", tokenId, "holderCount", "0");

    let hid = holderIdHex(TOKEN, BUYER);
    assert.fieldEquals("Holder", hid, "balance", "0");
    assert.fieldEquals("Holder", hid, "sold", FIFTEEN_PCT);
    assert.fieldEquals("Holder", hid, "bought", FIFTEEN_PCT);

    assert.fieldEquals("Factory", "launchpad", "sellCount", "1");
  });
});

describe("Graduation", () => {
  beforeEach(() => {
    clearStore();
    dataSourceMock.resetValues();
  });

  test("Graduated builds the feed entity, flags the token, and rolls up raised ETH", () => {
    seedLaunchAndBuy();

    handleGraduated(
      graduatedEvent(
        TOKEN,
        POOL,
        bi("42"), // tokenId
        bi("200000000000000000000000000"), // tokensSeeded = 200M
        bi("90000000000000000000"), // wethSeeded = 90 ETH raised
        bi("79228162514264337593543950336"), // sqrtPriceX96
        4000,
        0
      )
    );

    let tokenId = TOKEN.toHexString();
    assert.fieldEquals("Token", tokenId, "graduated", "true");
    assert.fieldEquals("Token", tokenId, "graduatedAtTimestamp", "4000");
    assert.fieldEquals("Token", tokenId, "graduation", tokenId);

    assert.entityCount("Graduation", 1);
    assert.fieldEquals("Graduation", tokenId, "pool", POOL.toHexString());
    assert.fieldEquals("Graduation", tokenId, "tokenId", "42");
    assert.fieldEquals("Graduation", tokenId, "tokensSeeded", "200000000000000000000000000");
    assert.fieldEquals("Graduation", tokenId, "wethSeeded", "90000000000000000000");
    assert.fieldEquals("Graduation", tokenId, "raisedEth", "90000000000000000000");

    assert.fieldEquals("Factory", "launchpad", "graduationCount", "1");
    assert.fieldEquals("Factory", "launchpad", "totalRaisedEth", "90000000000000000000");
  });

  test("the curve-side Graduation echo is idempotent and does not re-count the graduation", () => {
    seedLaunchAndBuy();
    handleGraduated(
      graduatedEvent(
        TOKEN,
        POOL,
        bi("42"),
        bi("200000000000000000000000000"),
        bi("90000000000000000000"),
        bi("79228162514264337593543950336"),
        4000,
        0
      )
    );
    // curve echo fires later in the same tx
    setCurveContext();
    handleGraduation(graduationEvent(POOL, bi("90000000000000000000"), 4000, 1));

    assert.fieldEquals("Token", TOKEN.toHexString(), "graduated", "true");
    // still exactly one graduation counted
    assert.fieldEquals("Factory", "launchpad", "graduationCount", "1");
    assert.entityCount("Graduation", 1);
  });
});
