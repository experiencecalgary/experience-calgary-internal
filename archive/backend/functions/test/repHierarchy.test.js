"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  canonicalHierarchyForRole,
  validateRepHierarchy,
} = require("../lib/repHierarchy");

function db(reps) {
  return { collection: () => ({ doc: (id) => ({ get: async () => ({
    exists: Boolean(reps[id]), data: () => reps[id],
  }) }) }) };
}

const director = { active: true, status: "active", currentRoleId: "ROLE8" };
const pd = { active: true, status: "active", currentRoleId: "ROLE7" };

test("regular reps retain assigned PD and director", () => {
  assert.deepEqual(canonicalHierarchyForRole({
    repId: "R1", roleId: "ROLE1", programDirectorRepId: "PD1", directorRepId: "D1",
  }), { programDirectorRepId: "PD1", directorRepId: "D1" });
});

test("Program Director personal sales self-credit the PD pod", async () => {
  const result = await validateRepHierarchy(db({ PD1: pd, D1: director }), {
    repId: "PD1", currentRoleId: "ROLE7", directorRepId: "D1",
  });
  assert.equal(result.programDirectorRepId, "PD1");
  assert.equal(result.directorRepId, "D1");
});

test("director personal sales self-credit both leadership levels", async () => {
  const result = await validateRepHierarchy(db({ D1: director }), {
    repId: "D1", currentRoleId: "ROLE8",
  });
  assert.equal(result.programDirectorRepId, "D1");
  assert.equal(result.directorRepId, "D1");
});

test("non-leader self hierarchy is rejected", async () => {
  await assert.rejects(() => validateRepHierarchy(db({ R1: { active: true, currentRoleId: "ROLE1" } }), {
    repId: "R1", currentRoleId: "ROLE1", programDirectorRepId: "R1", directorRepId: "R1",
  }), /cannot lead themselves/);
});
