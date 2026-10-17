"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { sixWeekTarget, nextMonthStart, dateKey } = require("../lib/edmontonTime");

test("six-week target is 42 days after first actual shift", () => {
  const first = new Date("2026-08-06T15:00:00.000Z");
  assert.equal(sixWeekTarget(first).toISOString(), "2026-09-17T15:00:00.000Z");
});

test("next promotion month uses Edmonton calendar date", () => {
  assert.equal(dateKey(nextMonthStart(new Date("2026-08-31T20:00:00.000Z"))), "2026-09-01");
});

test("December promotion rolls into January", () => {
  assert.equal(dateKey(nextMonthStart(new Date("2026-12-15T20:00:00.000Z"))), "2027-01-01");
});

const { chunk, completeCamp } = require("../lib/repLifecycle");
const { validateRepHierarchy } = require("../lib/repHierarchy");
const { isPlatformAdmin } = require("../routes/repLifecycle");

function hierarchyDb(rows) {
  return { collection: () => ({ doc: (id) => ({ get: async () => ({
    exists: Object.hasOwn(rows, id),
    data: () => rows[id],
  }) }) }) };
}

test("reassignment chunks never exceed Firestore's 500-write limit", () => {
  const groups = chunk(Array.from({ length: 1500 }, (_, i) => i), 400);
  assert.deepEqual(groups.map((group) => group.length), [400, 400, 400, 300]);
  assert.ok(groups.every((group) => group.length <= 500));
});

test("invalid Firestore batch size is rejected", () => {
  assert.throws(() => chunk([1], 501), /between 1 and 500/);
});

test("platform-admin authorization accepts canonical claim and rejects ordinary users", () => {
  assert.equal(isPlatformAdmin({ platform_admin: true }, {}), true);
  assert.equal(isPlatformAdmin({}, { isPlatformAdmin: true }), true);
  assert.equal(isPlatformAdmin({ role: "sales_rep" }, { isAdmin: true }), false);
});

test("hierarchy validation accepts eligible active leaders", async () => {
  const result = await validateRepHierarchy(hierarchyDb({
    PD1: { active: true, currentRoleId: "ROLE4" },
    RD1: { active: true, currentRoleId: "ROLE5" },
  }), { repId: "REP1", programDirectorRepId: "PD1", directorRepId: "RD1" });
  assert.equal(result.programDirectorRepId, "PD1");
  assert.equal(result.directorRepId, "RD1");
});

test("hierarchy validation rejects inactive or duplicate leaders", async () => {
  await assert.rejects(validateRepHierarchy(hierarchyDb({
    PD1: { active: false, currentRoleId: "ROLE4" },
    RD1: { active: true, currentRoleId: "ROLE5" },
  }), { repId: "REP1", programDirectorRepId: "PD1", directorRepId: "RD1" }), /Program Director is not active/);
  await assert.rejects(validateRepHierarchy(hierarchyDb({}), {
    repId: "REP1", programDirectorRepId: "LEAD1", directorRepId: "LEAD1",
  }), /must be different/);
});


test("camp completion requires a reason", async () => {
  await assert.rejects(
    completeCamp({ db: {}, admin: {}, actor: { uid: "ADMIN" }, repId: "REP1", reason: "", requestId: "REQ1" }),
    /reason is required/
  );
});

test("camp completion is blocked until automated evaluation awaits admin review", async () => {
  const ref = {
    id: "REP1",
    get: async () => ({ exists: true, data: () => ({ developmentCampStatus: "active" }) }),
  };
  const db = { collection: () => ({ doc: () => ref }) };
  await assert.rejects(
    completeCamp({
      db,
      admin: {},
      actor: { uid: "ADMIN", email: "admin@example.com" },
      repId: "REP1",
      reason: "Reviewed",
      requestId: "REQ2",
    }),
    /awaiting admin review/
  );
});
