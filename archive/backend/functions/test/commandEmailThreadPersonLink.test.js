"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildThreadPersonLinkUpdate,
  buildConnectionPersonLinkUpdate,
} = require("../lib/commandEmail/commandEmailThreadPersonLink");

test("manual ExMail linking changes only the Person association metadata", () => {
  const personRef = { path: "commandPeople/person-a" };
  const actorRef = { path: "users/user-a" };
  const timestamp = { serverTimestamp: true };

  const update = buildThreadPersonLinkUpdate({
    personRef,
    personName: "Matt McBride",
    actorRef,
    timestamp,
  });

  assert.deepEqual(update, {
    personRef,
    personName: "Matt McBride",
    organizationRef: null,
    organizationName: "",
    organizationLinkSource: null,
    linkSource: "manual",
    linkedAt: timestamp,
    linkedByRef: actorRef,
    autoLinkSuppressed: false,
    autoLinkSuppressedAt: null,
    autoLinkSuppressedByRef: null,
    updatedAt: timestamp,
  });
  assert.equal("senderEmail" in update, false);
  assert.equal("additionalEmails" in update, false);
});

test("email activity connections receive only the selected Person reference", () => {
  const personRef = { path: "commandPeople/person-a" };
  const update = buildConnectionPersonLinkUpdate({ personRef });

  assert.deepEqual(update, {
    personRef,
    organizationRef: null,
  });
});
