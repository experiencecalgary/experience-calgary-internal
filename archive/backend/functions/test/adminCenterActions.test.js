"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  completedPayrollWarning,
  createAdminCenterActions,
  correctSalesRep,
  createComplimentaryMembership,
  revokeMembership,
  setAccessActivation,
} = require("../lib/adminCenterActions");

const doc = (id, data, exists = true) => ({ id, exists, data: () => data });
const nowAdmin = {
  firestore: { FieldValue: { serverTimestamp: () => "SERVER_TIME" } },
};

test("dispatcher accepts only the four explicit Admin Center actions", async () => {
  const execute = createAdminCenterActions({});
  await assert.rejects(
    execute({ action: "deleteEverything" }, { uid: "admin-1" }),
    (error) => error.code === "unsupported_admin_action" && error.statusCode === 400
  );
});

test("completed payroll warning is based on the order paid date", async () => {
  const db = {
    collection: (name) => {
      assert.equal(name, "payrollSnapshots");
      return {
        where: () => ({ get: async () => ({ docs: [doc("pay-1", {
          payPeriodStart: "2026-08-01T00:00:00.000Z",
          payPeriodEnd: "2026-08-15T23:59:59.999Z",
        })] }) }),
      };
    },
  };
  const warning = await completedPayrollWarning(db, { datePaid: "2026-08-08T12:00:00.000Z" });
  assert.equal(warning.code, "completed_payroll_affected");
  assert.equal(warning.snapshotId, "pay-1");
  assert.equal(await completedPayrollWarning(db, {}), null);
});

test("Access activation changes no inventory fields and writes an audit", async () => {
  const writes = [];
  const refs = new Map();
  const db = {
    collection: (name) => ({
      doc: (id) => {
        const ref = { name, id };
        refs.set(`${name}/${id}`, ref);
        return ref;
      },
    }),
    runTransaction: async (callback) => callback({
      get: async (ref) => doc(ref.id, {
        activationEnabled: true,
        availablePasses: 6,
        totalPurchased: 8,
        totalActivated: 2,
      }),
      set: (ref, value, options) => writes.push({ ref, value, options }),
    }),
  };
  const result = await setAccessActivation({
    db,
    admin: nowAdmin,
    actor: { uid: "admin-1", email: "admin@example.com" },
    input: {
      requestId: "request_1234",
      reason: "Owner requested pause",
      targetId: "account-1",
      data: { activationEnabled: false },
    },
  });
  assert.deepEqual(result, { accessAccountId: "account-1", activationEnabled: false });
  const accountWrite = writes.find((write) => write.ref.name === "accessAccounts");
  assert.equal(accountWrite.value.activationEnabled, false);
  assert.equal("availablePasses" in accountWrite.value, false);
  assert.equal("totalPurchased" in accountWrite.value, false);
  assert.equal("totalActivated" in accountWrite.value, false);
  assert.ok(writes.some((write) => write.ref.name === "adminAudit"));
});

test("all operational actions require a bounded unique request ID", async () => {
  const execute = createAdminCenterActions({ db: {}, admin: nowAdmin });
  for (const action of [
    "correctSalesRep",
    "createComplimentaryMembership",
    "revokeMembership",
    "setAccessActivation",
  ]) {
    await assert.rejects(
      execute({ action, requestId: "bad", reason: "Valid reason" }, { uid: "admin-1" }),
      (error) => error.code === "invalid_request_id"
    );
  }
});

test("Sales Rep correction stamps the canonical hierarchy and mirrors Access Pass attribution", async () => {
  const writes = [];
  const records = {
    "reps/REP1": doc("REP1", { active: true, currentRoleId: "ROLE1",
      firstName: "Real", lastName: "Rep", programDirectorRepId: "PD1", directorRepId: "DIR1" }),
    "reps/PD1": doc("PD1", { active: true, currentRoleId: "ROLE7" }),
    "reps/DIR1": doc("DIR1", { active: true, currentRoleId: "ROLE8" }),
    "orderIngest/7001": doc("7001", { salesRepId: "OLD", datePaid: "2026-08-20T00:00:00Z" }),
    "accessPassPurchases/7001": doc("7001", { salesRepId: "OLD" }),
    "salesAttributionReviews/7001": doc("7001", { status: "open" }),
  };
  const ref = (name, id) => ({ name, id, path: `${name}/${id}` });
  const db = {
    collection: (name) => ({
      doc: (id) => ({ ...ref(name, id), get: async () => records[`${name}/${id}`] || doc(id, {}, false) }),
      where: () => ({ get: async () => ({ docs: [] }) }),
    }),
    runTransaction: async (callback) => callback({
      get: async (reference) => records[reference.path] || doc(reference.id, {}, false),
      set: (reference, value, options) => writes.push({ reference, value, options }),
    }),
  };
  const result = await correctSalesRep({
    db, admin: nowAdmin, actor: { uid: "admin-1", email: "admin@example.com" },
    input: { requestId: "request_7001", reason: "Verified with the customer",
      targetId: "7001", data: { salesRepId: "REP1" } },
  });
  assert.equal(result.salesRepId, "REP1");
  const orderWrite = writes.find((write) => write.reference.path === "orderIngest/7001");
  assert.equal(orderWrite.value.salesRepName, "Real Rep");
  assert.equal(orderWrite.value.roleIdAtSale, "ROLE1");
  assert.equal(orderWrite.value.programDirectorRepId, "PD1");
  assert.equal(orderWrite.value.directorRepId, "DIR1");
  assert.equal(orderWrite.value.attributionStatus, "admin_corrected");
  assert.ok(writes.some((write) => write.reference.path === "accessPassPurchases/7001"));
  assert.ok(writes.some((write) => write.reference.name === "salesAttributionAudits"));
});

test("complimentary membership reuses canonical creation and provisioning services", async () => {
  const calls = [];
  const membershipRef = {
    get: async () => doc("admin_request_9001", {}, false),
    set: async (value) => calls.push(["membershipSet", value]),
  };
  const db = { collection: (name) => ({
    doc: () => name === "memberships" ? membershipRef : {
      set: async (value) => calls.push(["audit", value]),
    },
  }) };
  const result = await createComplimentaryMembership({
    db, admin: nowAdmin, actor: { uid: "admin-1" },
    input: { requestId: "request_9001", reason: "Community partner",
      data: { email: "member@example.com", firstName: "New", lastName: "Member",
        tier: "vip", cityId: "yyc" } },
    getOrCreateAuthUserByEmail: async () => ({ uid: "customer-1" }),
    upsertUserDoc: async () => calls.push(["user"]),
    createMembershipForOrder: async (_db, _admin, value) => calls.push(["membership", value]),
    provisionMembershipEntitlements: async (_db, _admin, value) => calls.push(["provision", value]),
  });
  assert.equal(result.membershipId, "admin_request_9001");
  assert.equal(result.uid, "customer-1");
  assert.ok(calls.some(([name, value]) => name === "membership" && value.tier === "vip"));
  assert.ok(calls.some(([name, value]) => name === "provision" && value.membershipId === result.membershipId));
});

test("membership revocation preserves redeemed records and disables only unused access", async () => {
  const writes = [];
  const membershipRef = {
    id: "M1", path: "memberships/M1",
    get: async () => doc("M1", { uid: "customer-1", active: true }),
    set: async (value) => writes.push({ path: "memberships/M1", value }),
  };
  const accessDocs = {
    customer_offers: [
      { ...doc("available", { status: "available" }), ref: { path: "customer_offers/available" } },
      { ...doc("redeemed", { status: "redeemed" }), ref: { path: "customer_offers/redeemed" } },
    ],
    qrCodes: [
      { ...doc("unused", { status: "unused" }), ref: { path: "qrCodes/unused" } },
      { ...doc("redeemed", { status: "redeemed" }), ref: { path: "qrCodes/redeemed" } },
    ],
    vip_credits: [
      { ...doc("unused", { status: "unused" }), ref: { path: "vip_credits/unused" } },
      { ...doc("consumed", { status: "consumed" }), ref: { path: "vip_credits/consumed" } },
    ],
  };
  const db = {
    collection: (name) => ({
      doc: (id) => {
        if (name === "memberships" && id === "M1") return membershipRef;
        return { set: async (value) => writes.push({ path: `${name}/${id}`, value }) };
      },
      where: (field, _op, value) => {
        if (name === "memberships") return {
          where: () => ({ get: async () => ({ size: 1, docs: [doc("M2", {
            uid: "customer-1", active: true, tier: "vip", vipGiftsRemaining: 2,
            offersRemainingCount: 3, savingsRemainingDollars: 40,
          })] }) }),
        };
        assert.equal(field, "membershipId");
        assert.equal(value, "M1");
        return { get: async () => ({ docs: accessDocs[name] }) };
      },
    }),
    batch: () => {
      const batchWrites = [];
      return {
        set: (reference, value) => batchWrites.push({ path: reference.path, value }),
        commit: async () => writes.push(...batchWrites),
      };
    },
  };
  const result = await revokeMembership({
    db, admin: nowAdmin, actor: { uid: "admin-1" },
    input: { requestId: "request_revoke_1", reason: "Membership cancelled", targetId: "M1" },
  });
  assert.equal(result.offersRevoked, 1);
  assert.equal(result.qrsExpired, 1);
  assert.equal(result.creditsExpired, 1);
  assert.ok(writes.some((write) => write.path === "customer_offers/available" && write.value.status === "revoked"));
  assert.equal(writes.some((write) => write.path === "customer_offers/redeemed"), false);
  assert.equal(writes.some((write) => write.path === "qrCodes/redeemed"), false);
  assert.equal(writes.some((write) => write.path === "vip_credits/consumed"), false);
});


test("complimentary membership retries reject changed customer inputs", async () => {
  const existing = doc("admin_request_retry", {
    uid: "customer-1",
    billingEmail: "original@example.com",
    tier: "vip",
    cityId: "yyc",
  });
  const db = {
    collection: (name) => ({
      doc: () => name === "memberships"
        ? { get: async () => existing }
        : { set: async () => {} },
    }),
  };
  await assert.rejects(
    createComplimentaryMembership({
      db,
      admin: nowAdmin,
      actor: { uid: "admin-1" },
      input: {
        requestId: "request_retry",
        reason: "Community partner",
        data: {
          email: "different@example.com",
          tier: "signature",
          cityId: "yyc",
        },
      },
    }),
    (error) => error.code === "idempotency_conflict" && error.statusCode === 409
  );
});

test("an interrupted membership revocation resumes unused-access shutdown", async () => {
  const writes = [];
  const membershipRef = {
    get: async () => doc("M1", {
      uid: "customer-1",
      active: false,
      lastAdminRevocationId: "request_resume_1",
    }),
    set: async (value) => writes.push({ path: "memberships/M1", value }),
  };
  const unusedOffer = {
    ...doc("offer-1", { status: "available" }),
    ref: { path: "customer_offers/offer-1" },
  };
  const db = {
    collection: (name) => ({
      doc: (id) => {
        if (name === "memberships" && id === "M1") return membershipRef;
        return { set: async (value) => writes.push({ path: `${name}/${id}`, value }) };
      },
      where: () => {
        if (name === "memberships") {
          return { where: () => ({ get: async () => ({ size: 0, docs: [] }) }) };
        }
        return {
          get: async () => ({ docs: name === "customer_offers" ? [unusedOffer] : [] }),
        };
      },
    }),
    batch: () => {
      const pending = [];
      return {
        set: (reference, value) => pending.push({ path: reference.path, value }),
        commit: async () => writes.push(...pending),
      };
    },
  };

  const result = await revokeMembership({
    db,
    admin: nowAdmin,
    actor: { uid: "admin-1" },
    input: {
      requestId: "request_resume_1",
      reason: "Finish interrupted revocation",
      targetId: "M1",
    },
  });

  assert.equal(result.offersRevoked, 1);
  assert.ok(writes.some((write) =>
    write.path === "customer_offers/offer-1" && write.value.status === "revoked"
  ));
  assert.ok(writes.some((write) =>
    write.path === "memberships/M1" && write.value.revocationCompletedAt === "SERVER_TIME"
  ));
});
