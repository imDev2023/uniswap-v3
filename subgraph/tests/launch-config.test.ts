import { assert, describe, test, clearStore, beforeEach } from "matchstick-as";
import { Address } from "@graphprotocol/graph-ts";
import { LaunchCreated } from "../generated/LaunchpadFactory/LaunchpadFactory";
import { handleLaunchCreated, handleLaunchConfig } from "../src/factory";
import { handleClaimed } from "../src/dev-vesting";
import { handleLockRegistered, handleLockExtended, handleReclaimed } from "../src/lp-lock";
import {
  TOKEN,
  CURVE,
  CREATOR,
  POOL,
  bi,
  defaultLaunchCreatedEvent,
  defaultLaunchConfigEvent,
  launchConfigEvent,
  claimedEvent,
  lockRegisteredEvent,
  lockExtendedEvent,
  reclaimedEvent,
  DEV_ALLOCATION,
  VESTING_DURATION,
  LOCK_DURATION,
  CREATOR_FEE_BPS,
  LOCK_TOKEN_ID,
  PERMANENT_SENTINEL,
} from "./helpers";

let tokenId = TOKEN.toHexString();

/// The shared launch fixture. `defaultLaunchCreatedEvent` takes its identity args explicitly so a
/// test can launch a second token; every test here uses the one.
function launch(): LaunchCreated {
  return defaultLaunchCreatedEvent(TOKEN, CURVE, CREATOR, "Test Token", "TEST");
}

describe("LaunchConfig (#36)", () => {
  beforeEach(() => {
    clearStore();
  });

  test("fills in the carve, the vesting schedule and the frozen lock terms", () => {
    handleLaunchCreated(launch());
    handleLaunchConfig(defaultLaunchConfigEvent());

    assert.fieldEquals("Token", tokenId, "devAllocation", DEV_ALLOCATION);
    assert.fieldEquals("Token", tokenId, "vestingDuration", VESTING_DURATION);
    assert.fieldEquals("Token", tokenId, "lockDuration", LOCK_DURATION);
    assert.fieldEquals("Token", tokenId, "creatorFeeBps", CREATOR_FEE_BPS.toString());
    assert.fieldEquals("Token", tokenId, "permanentLock", "false");
  });

  test("a launch begins with the config fields zeroed, before LaunchConfig arrives", () => {
    handleLaunchCreated(launch());

    // ⚠️ This is the state that exists BETWEEN the two logs of one transaction. Asserted so the
    // placeholders are a known intermediate rather than something a reader has to infer.
    assert.fieldEquals("Token", tokenId, "devAllocation", "0");
    assert.fieldEquals("Token", tokenId, "lockDuration", "0");
    assert.fieldEquals("Token", tokenId, "permanentLock", "false");
  });

  test("⚠️ a config for an unknown token is dropped rather than creating a half-built Token", () => {
    // Exactly what happens if the emit order is ever reversed on-chain: the config arrives first
    // and there is no entity to load. It must not fabricate one - a Token without curve params
    // would read as a real launch and render a price of zero.
    handleLaunchConfig(defaultLaunchConfigEvent());
    assert.entityCount("Token", 0);
  });

  test("a zero carve is recorded as zero, which is a real answer and not a missing one", () => {
    handleLaunchCreated(launch());
    handleLaunchConfig(
      launchConfigEvent(TOKEN, bi("0"), bi(VESTING_DURATION), bi(LOCK_DURATION), CREATOR_FEE_BPS, false, 1000, 1)
    );

    assert.fieldEquals("Token", tokenId, "devAllocation", "0");
    // The lock terms still arrive, which is what distinguishes "no carve" from "no config".
    assert.fieldEquals("Token", tokenId, "lockDuration", LOCK_DURATION);
  });

  test("a permanent lock is carried as the flag, with the duration left intact", () => {
    handleLaunchCreated(launch());
    handleLaunchConfig(
      launchConfigEvent(TOKEN, bi(DEV_ALLOCATION), bi(VESTING_DURATION), bi(LOCK_DURATION), CREATOR_FEE_BPS, true, 1000, 1)
    );

    assert.fieldEquals("Token", tokenId, "permanentLock", "true");
    assert.fieldEquals("Token", tokenId, "lockDuration", LOCK_DURATION);
  });
});

describe("DevVesting (#35) - claims accumulate against the granted carve", () => {
  beforeEach(() => {
    clearStore();
    handleLaunchCreated(launch());
    handleLaunchConfig(defaultLaunchConfigEvent());
  });

  test("⚠️ claims ACCUMULATE: amount is this claim, not the running total", () => {
    // The defect this guards is assignment instead of addition, which would leave devClaimed
    // showing only the most recent claim and understate the creator's realised position.
    handleClaimed(claimedEvent(TOKEN, CREATOR, bi("10000000000000000000000000"), bi("30000000000000000000000000"), 2000, 1));
    assert.fieldEquals("Token", tokenId, "devClaimed", "10000000000000000000000000");

    handleClaimed(claimedEvent(TOKEN, CREATOR, bi("15000000000000000000000000"), bi("15000000000000000000000000"), 3000, 1));
    assert.fieldEquals("Token", tokenId, "devClaimed", "25000000000000000000000000");

    // And the grant total is untouched by claiming: granted and claimed are two separate facts.
    assert.fieldEquals("Token", tokenId, "devAllocation", DEV_ALLOCATION);
  });

  test("a fully claimed grant leaves granted and claimed equal, never zeroed", () => {
    handleClaimed(claimedEvent(TOKEN, CREATOR, bi(DEV_ALLOCATION), bi("0"), 5000, 1));

    assert.fieldEquals("Token", tokenId, "devClaimed", DEV_ALLOCATION);
    assert.fieldEquals("Token", tokenId, "devAllocation", DEV_ALLOCATION);
  });

  test("a claim for an unknown token is dropped", () => {
    let stranger = Address.fromString("0x9999999999999999999999999999999999999999");
    handleClaimed(claimedEvent(stranger, CREATOR, bi("1"), bi("0"), 5000, 1));

    assert.entityCount("Token", 1);
    assert.fieldEquals("Token", tokenId, "devClaimed", "0");
  });
});

describe("LPLock (#33) - lock records", () => {
  beforeEach(() => {
    clearStore();
    handleLaunchCreated(launch());
    handleLaunchConfig(defaultLaunchConfigEvent());
  });

  test("registers the lock and links it to the token", () => {
    handleLockRegistered(
      lockRegisteredEvent(bi(LOCK_TOKEN_ID), TOKEN, POOL, 1, bi("31536000"), CREATOR_FEE_BPS, 4000, 1)
    );

    assert.fieldEquals("Lock", LOCK_TOKEN_ID, "token", tokenId);
    assert.fieldEquals("Lock", LOCK_TOKEN_ID, "pool", POOL.toHexString());
    assert.fieldEquals("Lock", LOCK_TOKEN_ID, "origin", "Launch");
    assert.fieldEquals("Lock", LOCK_TOKEN_ID, "lockUntil", "31536000");
    assert.fieldEquals("Lock", LOCK_TOKEN_ID, "permanent", "false");
    assert.fieldEquals("Lock", LOCK_TOKEN_ID, "reclaimed", "false");
    assert.fieldEquals("Lock", LOCK_TOKEN_ID, "extendCount", "0");
    assert.fieldEquals("Token", tokenId, "lock", LOCK_TOKEN_ID);
  });

  test("⚠️ permanent is DERIVED from the uint64-max sentinel, not from a flag", () => {
    // There is no permanent boolean on-chain. Reading lockUntil as a date would render a permanent
    // lock as expiring in the year 584942417355.
    handleLockRegistered(
      lockRegisteredEvent(bi(LOCK_TOKEN_ID), TOKEN, POOL, 1, bi(PERMANENT_SENTINEL), CREATOR_FEE_BPS, 4000, 1)
    );

    assert.fieldEquals("Lock", LOCK_TOKEN_ID, "permanent", "true");
  });

  test("⚠️ the origin enum's ZERO slot is None, so an unregistered value is never Launch", () => {
    // The ordering is load-bearing: only Launch positions are reclaimable, so a mapping that shifted
    // this by one would mark third-party locks reclaimable.
    handleLockRegistered(lockRegisteredEvent(bi("7"), TOKEN, POOL, 0, bi("31536000"), CREATOR_FEE_BPS, 4000, 1));
    assert.fieldEquals("Lock", "7", "origin", "None");

    handleLockRegistered(lockRegisteredEvent(bi("8"), TOKEN, POOL, 2, bi("31536000"), CREATOR_FEE_BPS, 4000, 2));
    assert.fieldEquals("Lock", "8", "origin", "ThirdParty");
  });

  test("extending lengthens the lock and counts the extension", () => {
    handleLockRegistered(
      lockRegisteredEvent(bi(LOCK_TOKEN_ID), TOKEN, POOL, 1, bi("31536000"), CREATOR_FEE_BPS, 4000, 1)
    );
    handleLockExtended(lockExtendedEvent(bi(LOCK_TOKEN_ID), bi("31536000"), bi("63072000"), 5000, 1));

    assert.fieldEquals("Lock", LOCK_TOKEN_ID, "lockUntil", "63072000");
    assert.fieldEquals("Lock", LOCK_TOKEN_ID, "extendCount", "1");
    assert.fieldEquals("Lock", LOCK_TOKEN_ID, "permanent", "false");
  });

  test("⚠️ Token.permanentLock and Lock.permanent are DIFFERENT facts and may diverge", () => {
    // Token.permanentLock is the creator's CHOICE AT CREATION; Lock.permanent is the REALISED state
    // of the position, which extend can turn true later. Pinned because the divergence is by design
    // and a future reader would otherwise "fix" it by mirroring one onto the other - which would
    // silently rewrite what the creator originally chose.
    handleLockRegistered(
      lockRegisteredEvent(bi(LOCK_TOKEN_ID), TOKEN, POOL, 1, bi("31536000"), CREATOR_FEE_BPS, 4000, 1)
    );
    handleLockExtended(lockExtendedEvent(bi(LOCK_TOKEN_ID), bi("31536000"), bi(PERMANENT_SENTINEL), 5000, 1));

    assert.fieldEquals("Lock", LOCK_TOKEN_ID, "permanent", "true");
    assert.fieldEquals("Token", tokenId, "permanentLock", "false");
  });

  test("extending to the sentinel makes the lock permanent, which is terminal", () => {
    handleLockRegistered(
      lockRegisteredEvent(bi(LOCK_TOKEN_ID), TOKEN, POOL, 1, bi("31536000"), CREATOR_FEE_BPS, 4000, 1)
    );
    handleLockExtended(lockExtendedEvent(bi(LOCK_TOKEN_ID), bi("31536000"), bi(PERMANENT_SENTINEL), 5000, 1));

    assert.fieldEquals("Lock", LOCK_TOKEN_ID, "permanent", "true");
  });

  test("reclaim records the burn and the treasury payout, and is terminal", () => {
    handleLockRegistered(
      lockRegisteredEvent(bi(LOCK_TOKEN_ID), TOKEN, POOL, 1, bi("31536000"), CREATOR_FEE_BPS, 4000, 1)
    );
    handleReclaimed(reclaimedEvent(bi(LOCK_TOKEN_ID), TOKEN, bi("2000000000000000000"), bi("500000000000000000000"), 9000, 1));

    assert.fieldEquals("Lock", LOCK_TOKEN_ID, "reclaimed", "true");
    assert.fieldEquals("Lock", LOCK_TOKEN_ID, "reclaimedEth", "2000000000000000000");
    assert.fieldEquals("Lock", LOCK_TOKEN_ID, "reclaimedTokensBurned", "500000000000000000000");
    assert.fieldEquals("Lock", LOCK_TOKEN_ID, "reclaimedAtTimestamp", "9000");
  });

  test("⚠️ a third-party lock with no launch token creates no Lock entity", () => {
    // LPLock is designed to become a public locking service for arbitrary pairs, where launchToken
    // is address(0). Those must not be attached to a Token that does not exist.
    let zero = Address.fromString("0x0000000000000000000000000000000000000000");
    handleLockRegistered(lockRegisteredEvent(bi("99"), zero, POOL, 2, bi("31536000"), CREATOR_FEE_BPS, 4000, 1));

    assert.entityCount("Lock", 0);
  });
});
