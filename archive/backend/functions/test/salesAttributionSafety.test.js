"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ingestOrderEvent } = require("../lib/ingest");
const { createAttributionReview } = require("../lib/salesAttributionReview");

const serverTimestamp = { kind: "serverTimestamp" };
const increment = (value) => ({ kind: "increment", value });
const admin = {
  firestore: { FieldValue: { serverTimestamp: () => serverTimestamp, increment } },
};

function transactionDb({ order = null, reps = {} } = {}) {
  let currentOrder = order;
  let queue = Promise.resolve();
  const orderRef = { kind: "order", id: "1001" };

  const db = {
    collection(name) {
      if (name === "orderIngest") return { doc: () => orderRef };
      if (name === "reps") return { doc: (id) => ({ kind: "rep", id }) };
      throw new Error(`Unexpected collection: ${name}`);
    },
    runTransaction(callback) {
      const run = queue.then(async () => callback({
        async get(ref) {
          if (ref.kind === "order") {
            return { exists: currentOrder != null, data: () => currentOrder };
          }
          const rep = reps[ref.id];
          return { exists: rep != null, data: () => rep };
        },
        set(ref, value, options) {
          assert.equal(ref.kind, "order");
          const next = { ...value };
          if (next.eventCount?.kind === "increment") {
            next.eventCount = Number(currentOrder?.eventCount || 0) + next.eventCount.value;
          }
          currentOrder = options?.merge ? { ...(currentOrder || {}), ...next } : next;
        },
      }));
      queue = run.catch(() => {});
      return run;
    },
    readOrder: () => currentOrder,
  };
  return db;
}

const activeRep = {
  fullName: "Canonical Rep", active: true, status: "active",
  currentRoleId: "ROLE1", programDirectorRepId: "PD1", directorRepId: "D1",
};

test("concurrent first webhooks cannot replace the first accepted attribution", async () => {
  const db = transactionDb({ reps: { REP1: activeRep } });
  const base = {
    wooOrderId: "1001", status: "completed", billingEmail: "buyer@example.com",
    isPaid: true,
  };
  const [first, second] = await Promise.all([
    ingestOrderEvent(db, admin, { ...base, salesRepId: "REP1", attributionSource: "rep_qr" }),
    ingestOrderEvent(db, admin, { ...base, salesRepId: null }),
  ]);

  assert.equal(first.attributionStatus, "rep_attributed");
  assert.equal(second.preserved, true);
  assert.equal(db.readOrder().salesRepId, "REP1");
  assert.equal(db.readOrder().attributionStatus, "rep_attributed");
  assert.equal(db.readOrder().eventCount, 2);
});

test("metadata-free webhook canonicalizes complete legacy attribution without erasing it", async () => {
  const db = transactionDb({ order: {
    wooOrderId: "1001", eventCount: 3,
    salesRepId: "REP1", salesRepName: "Historical Rep", roleIdAtSale: "ROLE1",
    programDirectorRepId: "PD1", directorRepId: "D1",
  } });
  await ingestOrderEvent(db, admin, { wooOrderId: "1001", status: "refunded" });
  assert.equal(db.readOrder().salesRepId, "REP1");
  assert.equal(db.readOrder().salesRepName, "Historical Rep");
  assert.equal(db.readOrder().attributionStatus, "rep_attributed");
  assert.equal(db.readOrder().attributionSource, "legacy");
});

test("role-based platform administrators receive deterministic review notifications", async () => {
  const notifications = new Map();
  const queries = [];
  const db = {
    collection(name) {
      if (name === "salesAttributionReviews") return { doc: (id) => ({ id, async set() {} }) };
      if (name === "salesAttributionAudits") return { doc: () => ({ async create() {} }) };
      if (name === "commandNotifications") return { doc: (id) => ({ id }) };
      if (name === "users") return {
        where(field, op, value) {
          queries.push([field, op, value]);
          return { async get() {
            return { docs: field === "role" ? [{ id: "ADMIN1" }] : [] };
          } };
        },
      };
      throw new Error(`Unexpected collection: ${name}`);
    },
    runTransaction(callback) {
      return callback({
        async get() {
          return { exists: false };
        },
        set() {},
      });
    },
    batch() {
      return {
        set(ref, value) { notifications.set(ref.id, value); },
        async commit() {},
      };
    },
  };

  await createAttributionReview({
    db, admin, logger: { warn() {} },
    order: { wooOrderId: "1001", submittedSalesRepId: "TYPO", customerEmail: "buyer@example.com" },
    attribution: { requiresReview: true, reviewIssue: "invalid_rep_id" },
  });
  assert.ok(queries.some(([field, op, value]) =>
    field === "role" && op === "==" && value === "platform_admin"));
  assert.ok(notifications.has("ADMIN1_sales_attribution_1001"));
});
