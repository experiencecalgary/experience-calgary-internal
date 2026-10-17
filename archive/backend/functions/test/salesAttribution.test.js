"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  canonicalRepName,
  legacyAttributionState,
  preserveExistingAttribution,
  resolveSalesAttribution,
} = require("../lib/salesAttribution");

const serverTimestamp = { kind: "serverTimestamp" };
const admin = {
  firestore: {
    FieldValue: { serverTimestamp: () => serverTimestamp },
  },
};

function fakeDb(reps = {}) {
  reps = {
    PD1: { fullName: "PD", active: true, currentRoleId: "ROLE7", programDirectorRepId: "PD1", directorRepId: "D1" },
    D1: { fullName: "Director", active: true, currentRoleId: "ROLE8", programDirectorRepId: "D1", directorRepId: "D1" },
    ...reps,
  };
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

const activeRep = {
  fullName: "Canonical Rep",
  active: true,
  status: "active",
  currentRoleId: "ROLE1",
  programDirectorRepId: "PD1",
  directorRepId: "D1",
};

test("blank rep ID creates a valid self-serve attribution", async () => {
  const result = await resolveSalesAttribution({ db: fakeDb(), admin });
  assert.equal(result.attributionStatus, "self_serve");
  assert.equal(result.salesRepId, null);
  assert.equal(result.requiresReview, false);
});

test("valid rep creates a complete immutable sale-time snapshot", async () => {
  const result = await resolveSalesAttribution({
    db: fakeDb({ REP1: activeRep }), admin,
    submittedSalesRepId: " REP1 ", source: "rep_qr",
  });
  assert.deepEqual({
    status: result.attributionStatus,
    id: result.salesRepId,
    name: result.salesRepName,
    role: result.roleIdAtSale,
    pd: result.programDirectorRepId,
    director: result.directorRepId,
    source: result.attributionSource,
  }, {
    status: "rep_attributed", id: "REP1", name: "Canonical Rep",
    role: "ROLE1", pd: "PD1", director: "D1", source: "rep_qr",
  });
});

test("submitted rep name is never authoritative", () => {
  assert.equal(canonicalRepName({ firstName: "Real", lastName: "Name" }), "Real Name");
});

test("unknown rep is held for review without receiving credit", async () => {
  const result = await resolveSalesAttribution({
    db: fakeDb(), admin, submittedSalesRepId: "TYPO9",
  });
  assert.equal(result.attributionStatus, "needs_review");
  assert.equal(result.attributionIssue, "invalid_rep_id");
  assert.equal(result.submittedSalesRepId, "TYPO9");
  assert.equal(result.salesRepId, null);
});

test("inactive rep is held for review", async () => {
  const result = await resolveSalesAttribution({
    db: fakeDb({ REP1: { ...activeRep, active: false } }), admin,
    submittedSalesRepId: "REP1",
  });
  assert.equal(result.attributionIssue, "inactive_rep");
  assert.equal(result.salesRepId, null);
});

test("rep with incomplete hierarchy is held for review", async () => {
  const result = await resolveSalesAttribution({
    db: fakeDb({ REP1: { ...activeRep, directorRepId: null } }), admin,
    submittedSalesRepId: "REP1",
  });
  assert.equal(result.attributionIssue, "missing_hierarchy");
  assert.equal(result.salesRepId, "REP1");
  assert.equal(result.salesRepName, "Canonical Rep");
  assert.equal(result.roleIdAtSale, "ROLE1");
});

test("missing-hierarchy review is revalidated after rep hierarchy is repaired", async () => {
  const result = await resolveSalesAttribution({
    db: fakeDb({ REP1: activeRep }), admin,
    submittedSalesRepId: "REP1", isPaid: true,
    existingAttribution: {
      attributionStatus: "needs_review",
      attributionIssue: "missing_hierarchy",
      submittedSalesRepId: "REP1",
      salesRepId: "REP1",
      salesRepName: "Canonical Rep",
      roleIdAtSale: "ROLE1",
      attributionFinalized: true,
    },
  });
  assert.equal(result.attributionStatus, "rep_attributed");
  assert.equal(result.programDirectorRepId, "PD1");
  assert.equal(result.directorRepId, "D1");
});

test("later webhook without metadata preserves accepted attribution", () => {
  const result = preserveExistingAttribution({
    salesRepId: "REP1", salesRepName: "Canonical Rep",
    roleIdAtSale: "ROLE1", programDirectorRepId: "PD1", directorRepId: "D1",
    attributionStatus: "rep_attributed", attributionSource: "rep_qr",
    attributionVersion: 1, submittedSalesRepId: "REP1",
  }, null);
  assert.equal(result.salesRepId, "REP1");
  assert.equal(result.requiresReview, false);
  assert.equal(result.reviewIssue, null);
});

test("later conflicting rep claim cannot replace accepted attribution", () => {
  const result = preserveExistingAttribution({
    salesRepId: "REP1", salesRepName: "Canonical Rep",
    roleIdAtSale: "ROLE1", programDirectorRepId: "PD1", directorRepId: "D1",
    attributionStatus: "rep_attributed", attributionSource: "rep_qr",
    attributionVersion: 1, submittedSalesRepId: "REP1",
  }, "REP2");
  assert.equal(result.salesRepId, "REP1");
  assert.equal(result.reviewIssue, "conflicting_attribution");
});

test("complete legacy attribution is protected and canonicalized", () => {
  const legacy = {
    salesRepId: "REP1", salesRepName: "Historical Rep",
    roleIdAtSale: "ROLE1", programDirectorRepId: "PD1", directorRepId: "D1",
  };
  assert.equal(legacyAttributionState(legacy), "complete");
  const result = preserveExistingAttribution(legacy, null);
  assert.equal(result.salesRepId, "REP1");
  assert.equal(result.attributionStatus, "rep_attributed");
  assert.equal(result.attributionSource, "legacy");
  assert.equal(result.requiresReview, false);
  assert.equal(result.preserved, false);
});

test("partial legacy attribution is retained and opened for review", () => {
  const legacy = { salesRepId: "REP1", salesRepName: "Historical Rep" };
  assert.equal(legacyAttributionState(legacy), "partial");
  const result = preserveExistingAttribution(legacy, null);
  assert.equal(result.salesRepId, "REP1");
  assert.equal(result.salesRepName, "Historical Rep");
  assert.equal(result.attributionStatus, "needs_review");
  assert.equal(result.reviewIssue, "partial_legacy_snapshot");
  assert.equal(result.requiresReview, true);
});


test("unpaid webhook without a rep remains provisional, not self-serve", async () => {
  const result = await resolveSalesAttribution({
    db: fakeDb(), admin, isPaid: false,
  });
  assert.equal(result.attributionStatus, null);
  assert.equal(result.attributionFinalized, false);
  assert.equal(result.requiresReview, false);
});

test("unpaid rep claim is captured provisionally and validated only when paid", async () => {
  const provisional = await resolveSalesAttribution({
    db: fakeDb({ REP1: activeRep }), admin,
    submittedSalesRepId: "REP1", source: "rep_qr", isPaid: false,
  });
  assert.equal(provisional.salesRepId, null);
  assert.equal(provisional.provisionalSubmittedSalesRepId, "REP1");
  assert.equal(provisional.attributionFinalized, false);

  const finalized = await resolveSalesAttribution({
    db: fakeDb({ REP1: activeRep }), admin,
    existingAttribution: provisional, isPaid: true,
  });
  assert.equal(finalized.salesRepId, "REP1");
  assert.equal(finalized.attributionStatus, "rep_attributed");
  assert.equal(finalized.attributionFinalized, true);
});

test("paid metadata-free webhook finalizes self-serve only at payment", async () => {
  const provisional = await resolveSalesAttribution({
    db: fakeDb(), admin, isPaid: false,
  });
  const finalized = await resolveSalesAttribution({
    db: fakeDb(), admin, existingAttribution: provisional, isPaid: true,
  });
  assert.equal(finalized.attributionStatus, "self_serve");
  assert.equal(finalized.attributionFinalized, true);
});

test("already-finalized paid self-serve cannot be replaced by a later rep claim", async () => {
  const finalized = await resolveSalesAttribution({
    db: fakeDb(), admin, isPaid: true,
  });
  const later = await resolveSalesAttribution({
    db: fakeDb({ REP1: activeRep }), admin,
    existingAttribution: { ...finalized, processed: true }, submittedSalesRepId: "REP1", isPaid: true,
  });
  assert.equal(later.attributionStatus, "self_serve");
  assert.equal(later.salesRepId, null);
  assert.equal(later.reviewIssue, "conflicting_attribution");
});
