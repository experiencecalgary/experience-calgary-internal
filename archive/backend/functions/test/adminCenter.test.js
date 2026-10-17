"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const registerAdminCenterRoutes = require("../routes/adminCenter");
const {
  accessAccountSummary,
  accountingSummary,
  actorFromRequest,
  auditSummary,
  attributionAuditSummary,
  decodeCursor,
  isRefundedOrder,
  membershipSummary,
  newestFirst,
  overview,
  orderPaymentState,
  orderProcessingState,
  orderSummary,
  pageNewestFirst,
  pageOrdered,
  repSummary,
  exactOrderSearch,
  getAccountingDetail,
  listReps,
} = require("../routes/adminCenter");
const { repDetailRecord } = require("../lib/repLifecycle");

const doc = (id, data) => ({ id, exists: true, data: () => data });

test("payment classification uses datePaid and keeps refund distinct", () => {
  assert.equal(orderPaymentState({ datePaid: "2026-08-01" }), "paid");
  assert.equal(orderPaymentState({ processed: true }), "unpaid");
  assert.equal(orderPaymentState({ datePaid: "2026-08-01", status: "refunded" }), "refunded");
});

test("refund classification uses the canonical production normalizer", () => {
  assert.equal(isRefundedOrder({ status: "refunded" }), true);
  assert.equal(isRefundedOrder({ status: "partially-refunded" }), true);
  assert.equal(isRefundedOrder({ status: "wc-partially-refunded" }), true);
  assert.equal(isRefundedOrder({
    status: "completed",
    payloadRaw: JSON.stringify({ refunds: [{ id: 1 }] }),
  }), true);
  assert.equal(isRefundedOrder({ datePaid: "2026-08-01", status: "completed" }), false);
});

test("processing state is operational and independent from payment", () => {
  assert.equal(orderProcessingState({ processed: true }), "processed");
  assert.equal(orderProcessingState({ processing: true }), "processing");
  assert.equal(orderProcessingState({ error: "failed" }), "error");
  assert.equal(orderProcessingState({}), "not_processed");
});

test("order summaries are stable allowlists and redact raw WooCommerce payloads", () => {
  const row = orderSummary(doc("123", {
    wooOrderId: "123", datePaid: "2026-08-01", processed: true,
    billingEmail: "member@example.com", payloadRaw: "SECRET", arbitraryInternalField: "SECRET",
  }));
  assert.equal(row.paymentState, "paid");
  assert.equal(row.processingState, "processed");
  assert.equal(row.billingEmail, "member@example.com");
  assert.equal("payloadRaw" in row, false);
  assert.equal("arbitraryInternalField" in row, false);
});

test("rep summaries combine canonical rep and linked user lifecycle data", () => {
  const row = repSummary(
    doc("EC100", { firebaseUid: "uid-1", fullName: "Rep Name", programDirectorRepId: "PD1" }),
    doc("uid-1", { active: true, email: "rep@example.com", currentRoleId: "ROLE1" })
  );
  assert.equal(row.repId, "EC100");
  assert.equal(row.email, "rep@example.com");
  assert.equal(row.active, true);
  assert.equal(row.currentRoleId, "ROLE1");
  assert.equal(row.programDirectorRepId, "PD1");
});

test("cursor rejects malformed and structurally invalid values", () => {
  assert.throws(() => decodeCursor("not-base64-json"), /Invalid cursor/);
  const missingId = Buffer.from(JSON.stringify({ page: 2 })).toString("base64url");
  assert.throws(() => decodeCursor(missingId), /Invalid cursor/);
});

test("exact order search uses production fields, deduplicates, and returns summaries", async () => {
  const order = doc("1234", { wooOrderId: "1234", datePaid: "2026-08-01", payloadRaw: "SECRET" });
  const db = {
    collection: () => ({
      doc: () => ({ get: async () => order }),
      where: () => ({ limit: () => ({ get: async () => ({ docs: [order] }) }) }),
    }),
  };
  const rows = await exactOrderSearch(db, "1234", 25);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].wooOrderId, "1234");
  assert.equal(rows[0].paymentState, "paid");
  assert.equal("payloadRaw" in rows[0], false);
});


test("membership summary uses billing email and source Woo order identity", () => {
  const row = membershipSummary(doc("membership-42", {
    billingEmail: "billing@example.com",
    email: "legacy@example.com",
    sourceWooOrderId: "4200",
  }));
  assert.equal(row.email, "billing@example.com");
  assert.equal(row.wooOrderId, "4200");
  assert.equal(membershipSummary(doc("membership-43", {})).wooOrderId, "membership-43");
});

test("Access Account summary follows production status and activation fields", () => {
  const row = accessAccountSummary(doc("account-1", {
    ownerUid: "uid-1",
    ownerName: "Customer Name",
    ownerEmail: "customer@example.com",
    status: "active",
    activationEnabled: true,
    totalPurchased: 8,
    totalActivated: 3,
    availablePasses: 5,
    active: false,
  }));
  assert.equal(row.status, "active");
  assert.equal(row.activationEnabled, true);
  assert.equal(row.totalActivated, 3);
  assert.equal(row.ownerName, "Customer Name");
  assert.equal("active" in row, false);
});

test("accounting summary exposes stored payout totals and lifecycle state", () => {
  const row = accountingSummary(doc("snapshot-1", {
    snapshotType: "monthly_bonus",
    monthKey: "2026-07",
    grandTotal: 999,
    status: "complete",
    totalPersonalBonusPay: 400,
    totalLeadershipBonusPay: 350,
    totalDirectorBonusPay: 249,
  }));
  assert.equal(row.snapshotType, "monthly_bonus");
  assert.equal(row.totalPayout, 999);
  assert.equal(row.payoutStatus, "pending");
  assert.equal(row.personalBonusPay, 400);
  assert.equal(row.leadershipBonusPay, 350);
  assert.equal(row.directorBonusPay, 249);
});

test("attribution history exposes its production-specific audit contract", () => {
  const row = attributionAuditSummary(doc("audit-1", {
    wooOrderId: "4200",
    action: "attribution_corrected",
    reason: "Verified rep",
    source: "platform_admin",
    previousSalesRepId: "EC100",
    salesRepId: "EC200",
    affectedPayPeriod: "2026-08-A",
    actorUid: "admin-1",
    createdAt: "2026-08-08T18:00:00.000Z",
  }));
  assert.equal(row.wooOrderId, "4200");
  assert.equal(row.reason, "Verified rep");
  assert.equal(row.source, "platform_admin");
  assert.equal(row.previousSalesRepId, "EC100");
  assert.equal(row.salesRepId, "EC200");
  assert.equal(row.affectedPayPeriod, "2026-08-A");
});

test("history ordering is deterministic and newest first", () => {
  const rows = newestFirst([
    doc("a", { createdAt: "2026-08-01T00:00:00.000Z" }),
    doc("b", { createdAt: "2026-08-03T00:00:00.000Z" }),
    doc("c", { createdAt: "2026-08-03T00:00:00.000Z" }),
  ]);
  assert.deepEqual(rows.map((row) => row.id), ["c", "b", "a"]);
});

test("Platform Admin authorization rejects missing and unauthorized tokens", async () => {
  const db = {
    collection: () => ({
      doc: () => ({ get: async () => doc("uid-1", { role: "sales_rep" }) }),
    }),
  };
  const admin = { auth: () => ({ verifyIdToken: async () => ({ uid: "uid-1" }) }) };
  await assert.rejects(
    actorFromRequest({ headers: {} }, admin, db),
    (error) => error.statusCode === 401 && error.code === "authentication_required"
  );
  await assert.rejects(
    actorFromRequest({ headers: { authorization: "Bearer token" } }, admin, db),
    (error) => error.statusCode === 403 && error.code === "permission_denied"
  );

  const invalidAdmin = {
    auth: () => ({
      verifyIdToken: async () => {
        throw new Error("Firebase ID token has expired");
      },
    }),
  };
  await assert.rejects(
    actorFromRequest({ headers: { authorization: "Bearer expired" } }, invalidAdmin, db),
    (error) => error.statusCode === 401 && error.code === "invalid_authentication_token"
  );
});

test("Audit Log pagination is newest-first and resumes from a document cursor", async () => {
  const rows = [
    doc("audit-3", { createdAt: "2026-08-03T00:00:00.000Z", action: "third" }),
    doc("audit-2", { createdAt: "2026-08-02T00:00:00.000Z", action: "second" }),
  ];
  const calls = [];
  const query = {
    orderBy(field, direction) {
      calls.push(["orderBy", field, direction]);
      return this;
    },
    limit(value) {
      calls.push(["limit", value]);
      return this;
    },
    startAfter(value) {
      calls.push(["startAfter", value.id]);
      return this;
    },
    async get() {
      return { docs: rows };
    },
  };
  const db = {
    collection: () => ({
      orderBy: query.orderBy.bind(query),
      doc: (id) => ({ get: async () => doc(id, { createdAt: "2026-08-04T00:00:00.000Z" }) }),
    }),
  };
  const cursor = Buffer.from(JSON.stringify({ id: "audit-4" })).toString("base64url");
  const result = await pageNewestFirst(db, "adminAudit", (row) => row.id, {
    limit: 1,
    cursor,
  });
  assert.deepEqual(result.items, ["audit-3"]);
  assert.ok(result.nextCursor);
  assert.deepEqual(calls.slice(0, 3), [
    ["orderBy", "createdAt", "desc"],
    ["orderBy", "__name__", "desc"],
    ["limit", 2],
  ]);
  assert.ok(calls.some((call) => call[0] === "startAfter" && call[1] === "audit-4"));
});

test("overview uses non-empty error query and production payroll ordering", async () => {
  const calls = [];
  const db = {
    collection: (name) => ({
      where: (field, operator, value) => ({
        count: () => ({
          get: async () => {
            calls.push({ name, field, operator, value });
            return { data: () => ({ count: 2 }) };
          },
        }),
      }),
      orderBy: (field, direction) => ({
        limit: () => ({
          get: async () => {
            calls.push({ name, field, direction });
            return { empty: true, docs: [] };
          },
        }),
      }),
    }),
  };
  const result = await overview(db);
  assert.equal(result.systemExceptions, 2);
  assert.ok(calls.some((call) =>
    call.name === "orderIngest" && call.field === "error" &&
    call.operator === ">" && call.value === ""
  ));
  assert.ok(calls.some((call) =>
    call.name === "payrollSnapshots" && call.field === "updatedAt" &&
    call.direction === "desc"
  ));
});

test("routes register and reject unsupported mutations", async () => {
  const routes = new Map();
  const app = {
    get: (path, handler) => routes.set(`GET ${path}`, handler),
    post: (path, handler) => routes.set(`POST ${path}`, handler),
  };
  const admin = {
    auth: () => ({
      verifyIdToken: async () => ({ uid: "admin-1", platformAdmin: true }),
    }),
  };
  const db = {
    collection: (name) => ({
      doc: () => ({
        get: async () => doc("admin-1", name === "users" ? { platformAdmin: true } : {}),
      }),
    }),
  };
  registerAdminCenterRoutes(app, { admin, db, logger: { error: () => {} } });
  assert.ok(routes.has("GET /admin/center/overview"));
  assert.ok(routes.has("POST /admin/center/query"));
  assert.ok(routes.has("POST /admin/center/action"));

  let statusCode = null;
  let body = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { body = value; return value; },
  };
  await routes.get("POST /admin/center/action")(
    { headers: { authorization: "Bearer token" }, body: {}, path: "/admin/center/action" },
    res
  );
  assert.equal(statusCode, 400);
  assert.equal(body.code, "unsupported_admin_action");
});


test("membership detail exposes customer, balances, and provisioning state", () => {
  const row = membershipSummary(doc("membership-1", {
    billingEmail: "member@example.com",
    firstName: "Ada",
    lastName: "Lovelace",
    fullName: "Ada Lovelace",
    offersRemainingCount: 7,
    savingsRemainingDollars: 125,
    vipGiftsRemaining: 2,
    entitlementsProvisioned: true,
  }));
  assert.equal(row.fullName, "Ada Lovelace");
  assert.equal(row.offersRemainingCount, 7);
  assert.equal(row.savingsRemainingDollars, 125);
  assert.equal(row.vipGiftsRemaining, 2);
  assert.equal(row.entitlementsProvisioned, true);
});

test("Admin activity rows include the reason and action result", () => {
  const row = auditSummary(doc("audit-1", {
    action: "setAccessActivation",
    reason: "Owner requested pause",
    result: { activationEnabled: false },
  }));
  assert.equal(row.reason, "Owner requested pause");
  assert.deepEqual(row.result, { activationEnabled: false });
});

test("payroll detail paginates rows with a reusable cursor", async () => {
  const calls = [];
  const rowsQuery = {
    orderBy(field) { calls.push(["orderBy", field]); return this; },
    limit(value) { calls.push(["limit", value]); return this; },
    startAfter(value) { calls.push(["startAfter", value]); return this; },
    async get() {
      return { docs: [
        doc("REP1", { repId: "REP1", totalPay: 100 }),
        doc("REP2", { repId: "REP2", totalPay: 200 }),
      ] };
    },
  };
  const snapshotRef = {
    get: async () => doc("pay-1", { status: "complete" }),
    collection: (name) => {
      assert.equal(name, "rows");
      return rowsQuery;
    },
  };
  const db = {
    collection: (name) => {
      assert.equal(name, "payrollSnapshots");
      return { doc: () => snapshotRef };
    },
  };

  const firstPage = await getAccountingDetail(db, "pay-1", { limit: 1 });
  assert.deepEqual(firstPage.rows.map((row) => row.repId), ["REP1"]);
  assert.ok(firstPage.nextCursor);

  await getAccountingDetail(db, "pay-1", {
    limit: 1,
    cursor: firstPage.nextCursor,
  });
  assert.ok(calls.some((call) => call[0] === "startAfter" && call[1] === "REP1"));
});

test("rep search finds exact production identity fields", async () => {
  const rep = doc("REP1", {
    repId: "REP1",
    firebaseUid: "uid-1",
    fullName: "Ada Rep",
    email: "ada@example.com",
  });
  const db = {
    collection: (name) => {
      if (name === "reps") {
        return {
          doc: () => ({ get: async () => ({ exists: false }) }),
          where: () => ({
            limit: () => ({ get: async () => ({ docs: [rep] }) }),
          }),
        };
      }
      return { doc: (id) => ({ id }) };
    },
    getAll: async () => [doc("uid-1", { email: "ada@example.com" })],
  };
  const result = await listReps(db, { search: "ada@example.com", limit: 25 });
  assert.equal(result.exactSearch, true);
  assert.deepEqual(result.items.map((row) => row.repId), ["REP1"]);
  assert.equal(result.nextCursor, null);
});


test("rep detail preserves active and app-access defaults for legacy records", () => {
  const legacy = repDetailRecord({ fullName: "Legacy Rep" }, "REP-OLD");
  assert.equal(legacy.repId, "REP-OLD");
  assert.equal(legacy.active, true);
  assert.equal(legacy.appAccess, true);

  const disabled = repDetailRecord({ active: false, appAccess: false }, "REP-OFF");
  assert.equal(disabled.active, false);
  assert.equal(disabled.appAccess, false);
});

test("ordered pagination continues into records missing the ordering timestamp", async () => {
  const dated = doc("new", { createdAt: "2026-08-08T00:00:00.000Z" });
  const legacy = doc("legacy", { name: "Old record" });
  let orderedRead = false;

  const db = {
    collection: () => ({
      orderBy(field) {
        if (field === "createdAt") {
          const orderedQuery = {
            orderBy() { return this; },
            limit() { return this; },
            async get() {
              orderedRead = true;
              return { docs: [dated], empty: false };
            },
          };
          return orderedQuery;
        }
        const legacyQuery = {
          limit() { return this; },
          startAfter() { return this; },
          async get() { return { docs: [dated, legacy], empty: false }; },
        };
        return legacyQuery;
      },
      doc: (id) => ({ get: async () => doc(id, { createdAt: "2026-08-08T00:00:00.000Z" }) }),
    }),
  };

  const first = await pageOrdered(db, "memberships", (row) => row.id, "createdAt", { limit: 1 });
  assert.deepEqual(first.items, ["new"]);
  assert.ok(first.nextCursor);
  assert.equal(orderedRead, true);

  const second = await pageOrdered(db, "memberships", (row) => row.id, "createdAt", {
    limit: 1,
    cursor: first.nextCursor,
  });
  assert.deepEqual(second.items, ["legacy"]);
  assert.equal(second.nextCursor, null);
});
