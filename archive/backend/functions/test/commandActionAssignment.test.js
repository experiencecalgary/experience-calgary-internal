"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  canAssignCommandAction,
} = require("../lib/command/commandActionAssignment");

test("a representative can assign an Action to themself", () => {
  assert.equal(
    canAssignCommandAction({
      actorUid: "user-a",
      actorData: { repId: 101 },
      assigneeUid: "user-a",
      assigneeData: { repId: 101 },
    }),
    true
  );
});

test("a representative can assign to program-director and director team members", () => {
  assert.equal(
    canAssignCommandAction({
      actorUid: "manager",
      actorData: { repId: 101 },
      assigneeUid: "rep-a",
      assigneeData: { programDirectorRepId: "101" },
    }),
    true
  );
  assert.equal(
    canAssignCommandAction({
      actorUid: "manager",
      actorData: { repId: "101" },
      assigneeUid: "rep-b",
      assigneeData: { directorRepId: 101 },
    }),
    true
  );
});

test("a representative cannot assign outside their team", () => {
  assert.equal(
    canAssignCommandAction({
      actorUid: "manager",
      actorData: { repId: 101 },
      assigneeUid: "rep-c",
      assigneeData: {
        programDirectorRepId: 202,
        directorRepId: 303,
      },
    }),
    false
  );
});

test("missing actor repId fails closed for another assignee", () => {
  assert.equal(
    canAssignCommandAction({
      actorUid: "manager",
      actorData: {},
      assigneeUid: "rep-c",
      assigneeData: { directorRepId: "" },
    }),
    false
  );
});
