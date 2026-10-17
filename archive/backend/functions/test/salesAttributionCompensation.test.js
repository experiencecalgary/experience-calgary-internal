"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeOrder,
  detectCompensationAttributionEligibility,
} = require("../lib/orderNormalizer");
const { resolveSalesAttribution } = require("../lib/salesAttribution");

const activeRep = {
  fullName: "Canonical Rep",
  active: true,
  status: "active",
  currentRoleId: "ROLE1",
  programDirectorRepId: "PD1",
  directorRepId: "D1",
};
const serverTimestamp = { kind: "serverTimestamp" };
const admin = {
  firestore: {
    FieldValue: { serverTimestamp: () => serverTimestamp },
  },
};
function fakeDb(reps = {}) {
  return {
    collection(name) {
      assert.equal(name, "reps");
      return {
        doc(id) {
          return {
            async get() {
              return {
                exists: Object.prototype.hasOwnProperty.call(reps, id),
                data: () => reps[id],
              };
            },
          };
        },
      };
    },
  };
}
function commercialOrder(overrides = {}) {
  return {
    datePaid: "2026-08-07T18:00:00Z",
    processed: true,
    tier: "vip",
    xValue: 250,
    total: "250.00",
    ...overrides,
  };
}

test("finalized validated rep attribution is compensation eligible", () => {
  const order = commercialOrder({
    salesRepId: "REP1",
    attributionStatus: "rep_attributed",
    attributionFinalized: true,
  });
  assert.equal(detectCompensationAttributionEligibility(order), true);
  assert.equal(normalizeOrder(order).isPayable, true);
});

test("needs-review order is never payable even when a retained rep ID exists", () => {
  const order = commercialOrder({
    salesRepId: "REP1",
    attributionStatus: "needs_review",
    attributionFinalized: true,
  });
  assert.equal(normalizeOrder(order).isPayable, false);
});

test("self-serve and provisional orders are never rep payable", () => {
  assert.equal(normalizeOrder(commercialOrder({
    attributionStatus: "self_serve",
    attributionFinalized: true,
  })).isPayable, false);
  assert.equal(normalizeOrder(commercialOrder({
    salesRepId: "REP1",
    attributionStatus: null,
    attributionFinalized: false,
  })).isPayable, false);
});

test("complete historical snapshots remain payable without a bulk migration", () => {
  const order = commercialOrder({
    salesRepId: "REP1",
    salesRepName: "Historical Rep",
    roleIdAtSale: "ROLE1",
    programDirectorRepId: "PD1",
    directorRepId: "D1",
  });
  assert.equal(normalizeOrder(order).isPayable, true);
});

test("partial historical snapshots are held out of compensation", () => {
  const order = commercialOrder({
    salesRepId: "REP1",
    salesRepName: "Historical Rep",
  });
  assert.equal(normalizeOrder(order).isPayable, false);
});

test("concurrent paid rep claim replaces unprocessed self-serve snapshot", async () => {
  const result = await resolveSalesAttribution({
    db: fakeDb({ REP1: activeRep }),
    admin,
    submittedSalesRepId: "REP1",
    isPaid: true,
    existingAttribution: {
      attributionStatus: "self_serve",
      attributionFinalized: true,
      processed: false,
    },
  });
  assert.equal(result.attributionStatus, "rep_attributed");
  assert.equal(result.salesRepId, "REP1");
  assert.equal(result.requiresReview, false);
});

test("processed self-serve attribution remains immutable", async () => {
  const result = await resolveSalesAttribution({
    db: fakeDb({ REP1: activeRep }),
    admin,
    submittedSalesRepId: "REP1",
    isPaid: true,
    existingAttribution: {
      attributionStatus: "self_serve",
      attributionFinalized: true,
      processed: true,
    },
  });
  assert.equal(result.attributionStatus, "self_serve");
  assert.equal(result.salesRepId, null);
  assert.equal(result.reviewIssue, "conflicting_attribution");
});
