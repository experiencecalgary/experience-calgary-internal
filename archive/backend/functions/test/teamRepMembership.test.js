"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildRepMembershipId,
  ensureTeamRepMembership,
} = require("../lib/teamRepMembership");

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function mergeInto(target, patch) {
  const out = { ...(target || {}) };
  for (const [key, value] of Object.entries(patch || {})) {
    if (key.includes(".")) {
      const parts = key.split(".");
      let cursor = out;
      for (const part of parts.slice(0, -1)) {
        cursor[part] = { ...(cursor[part] || {}) };
        cursor = cursor[part];
      }
      const leaf = parts[parts.length - 1];
      if (value && value.__increment != null) {
        cursor[leaf] = Number(cursor[leaf] || 0) + value.__increment;
      } else {
        cursor[leaf] = clone(value);
      }
    } else if (value && value.__increment != null) {
      out[key] = Number(out[key] || 0) + value.__increment;
    } else {
      out[key] = clone(value);
    }
  }
  return out;
}

function makeFirestore(initial = {}) {
  const store = new Map(Object.entries(initial).map(([key, value]) => [key, clone(value)]));

  function docRef(collection, id) {
    const key = `${collection}/${id}`;
    return {
      id: String(id),
      path: key,
      async get() {
        return {
          exists: store.has(key),
          id: String(id),
          data: () => clone(store.get(key)),
        };
      },
      async set(value, options = {}) {
        store.set(key, options.merge ? mergeInto(store.get(key), value) : clone(value));
      },
    };
  }

  const db = {
    collection(name) {
      return {
        doc(id) {
          return docRef(name, id);
        },
      };
    },
    async runTransaction(handler) {
      return handler({
        get: (ref) => ref.get(),
        create(ref, value) {
          if (store.has(ref.path)) throw new Error("already exists");
          store.set(ref.path, clone(value));
        },
        update(ref, value) {
          if (!store.has(ref.path)) throw new Error(`missing document ${ref.path}`);
          store.set(ref.path, mergeInto(store.get(ref.path), value));
        },
      });
    },
  };

  return { db, store };
}

const admin = {
  firestore: {
    FieldValue: {
      serverTimestamp: () => "SERVER_TIMESTAMP",
      increment: (amount) => ({ __increment: amount }),
    },
  },
};

async function markProvisioned(db, adminArg, { membershipId }) {
  await db.collection("memberships").doc(membershipId).set({
    offersProvisionedAt: "OFFERS_READY",
    vipCreditsProvisionedAt: "CREDITS_READY",
  }, { merge: true });
}

test("buildRepMembershipId creates only deterministic R-prefixed IDs", () => {
  assert.equal(buildRepMembershipId("4827"), "R4827");
  assert.equal(buildRepMembershipId(4827), "R4827");
  for (const value of ["", "0", "-1", "R4827", "48.27", "4827x"]) {
    assert.throws(() => buildRepMembershipId(value));
  }
});

test("creates a separate R membership even when the user already owns a paid VIP", async () => {
  const paid = {
    membershipId: "9001",
    uid: "uid-1",
    tier: "vip",
    wooOrderId: "9001",
    vipGiftsRemaining: 2,
  };
  const { db, store } = makeFirestore({
    "users/uid-1": {
      uid: "uid-1",
      userType: "rep",
      membershipId: "9001",
      membershipType: "VIP",
      membershipTier: "vip",
      membershipStatus: "active",
      summary: {
        activeMembershipCount: 1,
        vipGiftsRemainingTotal: 2,
      },
    },
    "memberships/9001": paid,
  });

  const result = await ensureTeamRepMembership({
    db,
    admin,
    repId: "4827",
    firebaseUid: "uid-1",
    email: "rep@example.com",
    provisionEntitlements: markProvisioned,
  });

  assert.equal(result.membershipId, "R4827");
  assert.equal(result.created, true);
  assert.deepEqual(store.get("memberships/9001"), paid);
  assert.equal(store.get("memberships/R4827").wooOrderId, null);
  assert.equal(store.get("memberships/R4827").sourceWooOrderId, null);
  assert.equal(store.get("memberships/R4827").vipGiftsRemaining, 5);

  const user = store.get("users/uid-1");
  assert.equal(user.membershipId, "9001");
  assert.equal(user.membershipType, "VIP");
  assert.equal(user.membershipTier, "vip");
  assert.equal(user.membershipStatus, "active");
  assert.equal(user.teamRepMembershipId, "R4827");
  assert.equal(user.teamRepMembershipTier, "vip");
  assert.equal(user.teamRepMembershipStatus, "active");
  assert.equal(user.summary.activeMembershipCount, 2);
  assert.equal(user.summary.vipGiftsRemainingTotal, 7);
  assert.equal(user.complimentaryMembershipId, undefined);
  assert.equal(store.has("orderIngest/R4827"), false);
});

test("completed retry preserves consumed rep credits and does not reprovision", async () => {
  let provisionCalls = 0;
  const { db, store } = makeFirestore({
    "users/uid-1": { uid: "uid-1" },
    "memberships/R4827": {
      membershipId: "R4827",
      uid: "uid-1",
      repId: "4827",
      wooOrderId: null,
      sourceWooOrderId: null,
      vipGiftsTotal: 5,
      vipGiftsRemaining: 2,
      provisioningStatus: "complete",
      offersProvisionedAt: "READY",
      vipCreditsProvisionedAt: "READY",
    },
  });

  const result = await ensureTeamRepMembership({
    db,
    admin,
    repId: "4827",
    firebaseUid: "uid-1",
    email: "rep@example.com",
    provisionEntitlements: async () => { provisionCalls += 1; },
  });

  assert.equal(result.alreadyComplete, true);
  assert.equal(provisionCalls, 0);
  assert.equal(store.get("memberships/R4827").vipGiftsRemaining, 2);
});

test("failed provisioning remains recoverable without restoring balances", async () => {
  const { db, store } = makeFirestore({
    "users/uid-1": { uid: "uid-1" },
  });

  await assert.rejects(() => ensureTeamRepMembership({
    db,
    admin,
    repId: "4827",
    firebaseUid: "uid-1",
    email: "rep@example.com",
    provisionEntitlements: async () => { throw new Error("temporary failure"); },
  }), /temporary failure/);

  assert.equal(store.get("memberships/R4827").provisioningStatus, "failed");
  store.get("memberships/R4827").vipGiftsRemaining = 3;

  const result = await ensureTeamRepMembership({
    db,
    admin,
    repId: "4827",
    firebaseUid: "uid-1",
    email: "rep@example.com",
    provisionEntitlements: markProvisioned,
  });

  assert.equal(result.resumed, true);
  assert.equal(store.get("memberships/R4827").vipGiftsRemaining, 3);
  assert.equal(store.get("memberships/R4827").provisioningStatus, "complete");
});

test("partial provisioning retry never restores redeemed offer balances", async () => {
  const { db, store } = makeFirestore({
    "users/uid-1": { uid: "uid-1" },
    "memberships/R4827": {
      membershipId: "R4827",
      uid: "uid-1",
      repId: "4827",
      wooOrderId: null,
      sourceWooOrderId: null,
      offersTotalCount: 20,
      offersRemainingCount: 14,
      savingsTotalDollars: 900,
      savingsRemainingDollars: 525,
      provisioningStatus: "failed",
      vipGiftsTotal: 5,
      vipGiftsRemaining: 3,
    },
  });

  const result = await ensureTeamRepMembership({
    db,
    admin,
    repId: "4827",
    firebaseUid: "uid-1",
    email: "rep@example.com",
    provisionEntitlements: async (dbArg, adminArg, { membershipId }) => {
      await dbArg.collection("memberships").doc(membershipId).set({
        offersProvisionedAt: "OFFERS_READY",
        vipCreditsProvisionedAt: "CREDITS_READY",
        offersTotalCount: 20,
        offersRemainingCount: 20,
        savingsTotalDollars: 900,
        savingsRemainingDollars: 900,
      }, { merge: true });
    },
  });

  assert.equal(result.resumed, true);
  const membership = store.get("memberships/R4827");
  assert.equal(membership.offersTotalCount, 20);
  assert.equal(membership.savingsTotalDollars, 900);
  assert.equal(membership.offersRemainingCount, 14);
  assert.equal(membership.savingsRemainingDollars, 525);
  assert.equal(membership.vipGiftsRemaining, 3);
});

test("rejects an R membership owned by a different rep or Firebase user", async () => {
  const { db } = makeFirestore({
    "users/uid-1": { uid: "uid-1" },
    "memberships/R4827": {
      membershipId: "R4827",
      uid: "someone-else",
      repId: "4827",
      wooOrderId: null,
    },
  });

  await assert.rejects(() => ensureTeamRepMembership({
    db,
    admin,
    repId: "4827",
    firebaseUid: "uid-1",
    email: "rep@example.com",
    provisionEntitlements: markProvisioned,
  }), /different rep or user/);
});

test("rep membership service stays outside every paid-order module", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../lib/teamRepMembership.js"),
    "utf8"
  );
  for (const forbidden of [
    "./memberships",
    "./ingest",
    "./refunds",
    "./salesAttribution",
    "./payrollSnapshots",
    "orderIngest",
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  assert.match(source, /require\("\.\/provision"\)/);
  assert.match(source, /wooOrderId: null/);
  assert.match(source, /sourceWooOrderId: null/);
});
