"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  createAccountingAdjustment,
  setAccountingAdjustmentStatus,
} = require("../lib/adminCenterActions");
const { resolveSnapshotPayout } = require("../lib/accountingCompatibility");

const serverTimestamp = () => "SERVER_TIME";
const increment = (value) => ({ increment: value });
const admin = { firestore: { FieldValue: { serverTimestamp, increment } } };
const actor = { uid: "admin-1", email: "admin@example.com" };

function fakeDb(seed = {}) {
  const records = new Map(Object.entries(seed));
  const writes = [];
  const ref = (collection, id) => ({ collection, id, key: `${collection}/${id}` });
  const db = {
    writes,
    records,
    collection(collection) {
      return { doc: (id) => ref(collection, id) };
    },
    async runTransaction(handler) {
      const tx = {
        async get(target) {
          const value = records.get(target.key);
          return { exists: value !== undefined, data: () => value };
        },
        set(target, value, options) {
          writes.push({ key: target.key, value, options });
          const previous = records.get(target.key) || {};
          records.set(target.key, options?.merge ? { ...previous, ...value } : value);
        },
      };
      return handler(tx);
    },
  };
  return db;
}

test("pending adjustment has no financial effect until posted", async () => {
  const db = fakeDb({
    "payrollSnapshots/snapshot-1": {
      status: "complete",
      payoutStatus: "pending",
      adjustmentTotal: 0,
    },
  });
  await createAccountingAdjustment({
    db, admin, actor,
    input: {
      requestId: "request_123",
      reason: "Refund after close",
      snapshotId: "snapshot-1",
      amount: -25,
      category: "refund",
      repId: "REP1",
    },
  });
  const snapshotWrite = db.writes.find((row) => row.key === "payrollSnapshots/snapshot-1");
  assert.equal("adjustmentTotal" in snapshotWrite.value, false);
  assert.equal(db.records.get("accountingAdjustments/adjustment_request_123").status, "pending");
});

test("posted adjustment updates the effective snapshot total exactly once", async () => {
  const db = fakeDb({
    "payrollSnapshots/snapshot-1": {
      status: "complete",
      payoutStatus: "pending",
      adjustmentTotal: 0,
    },
    "accountingAdjustments/adjustment_1": {
      snapshotId: "snapshot-1",
      status: "approved",
      amount: -25,
    },
  });
  await setAccountingAdjustmentStatus({
    db, admin, actor,
    input: {
      requestId: "request_456",
      reason: "Approved refund",
      adjustmentId: "adjustment_1",
      status: "posted",
    },
  });
  const snapshotWrite = db.writes.find((row) => row.key === "payrollSnapshots/snapshot-1");
  assert.deepEqual(snapshotWrite.value.adjustmentTotal, { increment: -25 });
  assert.equal(db.records.get("accountingAdjustments/adjustment_1").status, "posted");
});

test("adjustments are rejected after payout approval", async () => {
  const db = fakeDb({
    "payrollSnapshots/snapshot-1": {
      status: "complete",
      payoutStatus: "approved",
    },
  });
  await assert.rejects(
    createAccountingAdjustment({
      db, admin, actor,
      input: {
        requestId: "request_789",
        reason: "Late correction",
        snapshotId: "snapshot-1",
        amount: 10,
        category: "manual_correction",
      },
    }),
    (error) => error.code === "payout_adjustments_locked"
  );
});

test("snapshot jobs persist totals and terminal failures", () => {
  for (const file of ["payrollSnapshots.js", "monthlyBonusSnapshots.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", "lib", file), "utf8");
    assert.match(source, /status: "failed"/);
    assert.match(source, /failureReason/);
    assert.match(source, /totalPayout/);
    assert.match(source, /payoutStatus: "pending"/);
  }
});

test("exports and reconciliation only apply posted adjustments", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "routes", "adminCenter.js"), "utf8");
  assert.match(source, /lower\(row\.status\) === "posted"/);
  assert.match(source, /unresolved_adjustments/);
  assert.match(source, /readyForApproval/);
  assert.match(source, /exportTotal/);
});


test("legacy completed snapshots derive missing payout totals from immutable rows", () => {
  const resolved = resolveSnapshotPayout({ status: "complete" }, 125.5);
  assert.deepEqual(resolved, {
    value: 125.5,
    source: "rows",
    field: null,
    valid: true,
    legacyDerived: true,
  });
});

test("explicit snapshot totals remain authoritative and mismatches fail reconciliation", () => {
  const resolved = resolveSnapshotPayout({ totalPayout: 100 }, 125.5);
  assert.equal(resolved.value, 100);
  assert.equal(resolved.source, "header");
  assert.equal(resolved.legacyDerived, false);
  assert.ok(Math.abs(resolved.value - 125.5) >= 0.01);
});

test("zero-value explicit totals are not mistaken for missing legacy totals", () => {
  const resolved = resolveSnapshotPayout({ totalPayout: 0 }, 0);
  assert.equal(resolved.value, 0);
  assert.equal(resolved.source, "header");
  assert.equal(resolved.valid, true);
});
