"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseAddressList,
  parseEnvelopeRecipients,
  inboundRecipientCandidates,
  routedReceivingAddress,
  validateCcAddresses,
  threadParticipantAddresses,
  resolveReplyRecipients,
} = require("../lib/commandEmail/emailRecipients");

test("parses and normalizes To and CC address lists", () => {
  assert.deepEqual(
    parseAddressList('"Doe, Jane" <JANE@example.com>, boss@example.com'),
    ["jane@example.com", "boss@example.com"]
  );
});

test("reads SendGrid envelope recipients", () => {
  assert.deepEqual(
    parseEnvelopeRecipients(JSON.stringify({
      to: ["Rep@connect.experiencecalgary.ca", "other@example.com"],
    })),
    ["rep@connect.experiencecalgary.ca", "other@example.com"]
  );
});

test("deduplicates CC and removes To and sender addresses", () => {
  assert.deepEqual(
    validateCcAddresses(
      ["BOSS@example.com", "boss@example.com", "to@example.com"],
      {
        toAddresses: ["to@example.com"],
        excludeAddresses: ["rep@connect.experiencecalgary.ca"],
      }
    ),
    ["boss@example.com"]
  );
});

test("rejects malformed CC entries", () => {
  assert.throws(
    () => validateCcAddresses(["valid@example.com", "not-an-email"]),
    /valid email address/
  );
});

test("rejects more than ten CC recipients", () => {
  const recipients = Array.from({ length: 11 }, (_, index) => `cc${index}@example.com`);
  assert.throws(() => validateCcAddresses(recipients), /maximum of 10/);
});

test("legacy threads derive participants from existing fields", () => {
  assert.deepEqual(
    threadParticipantAddresses({
      toAddress: "Customer@example.com",
      senderEmail: "customer@example.com",
    }),
    ["customer@example.com"]
  );
});

test("reply sends only to the primary recipient", () => {
  assert.deepEqual(
    resolveReplyRecipients({
      toAddress: "primary@example.com",
      participantAddresses: ["primary@example.com", "cc@example.com"],
    }),
    { toAddress: "primary@example.com", ccAddresses: [] }
  );
});

test("reply all includes external CC participants and excludes ExMail", () => {
  assert.deepEqual(
    resolveReplyRecipients({
      toAddress: "primary@example.com",
      participantAddresses: [
        "primary@example.com",
        "cc@example.com",
        "rep@connect.experiencecalgary.ca",
      ],
    }, {
      replyAll: true,
      senderAddress: "rep@connect.experiencecalgary.ca",
    }),
    { toAddress: "primary@example.com", ccAddresses: ["cc@example.com"] }
  );
});


test("reply targets the latest inbound CC participant", () => {
  assert.deepEqual(
    resolveReplyRecipients({
      toAddress: "primary@example.com",
      senderEmail: "cc-replier@example.com",
      participantAddresses: [
        "primary@example.com",
        "cc-replier@example.com",
        "other@example.com",
      ],
    }),
    { toAddress: "cc-replier@example.com", ccAddresses: [] }
  );
});

test("reply all puts latest sender in To and remaining participants in CC", () => {
  assert.deepEqual(
    resolveReplyRecipients({
      toAddress: "primary@example.com",
      senderEmail: "cc-replier@example.com",
      participantAddresses: [
        "primary@example.com",
        "cc-replier@example.com",
        "other@example.com",
      ],
    }, {
      replyAll: true,
      senderAddress: "rep@connect.experiencecalgary.ca",
    }),
    {
      toAddress: "cc-replier@example.com",
      ccAddresses: ["primary@example.com", "other@example.com"],
    }
  );
});


test("CC-only ExMail is included in inbound mailbox candidates", () => {
  assert.deepEqual(
    inboundRecipientCandidates(
      ["customer@example.com"],
      ["rep@connect.experiencecalgary.ca"],
      []
    ),
    ["customer@example.com", "rep@connect.experiencecalgary.ca"]
  );
});

test("SendGrid envelope provides the inbound mailbox fallback", () => {
  assert.deepEqual(
    inboundRecipientCandidates(
      ["customer@example.com"],
      [],
      ["rep@connect.experiencecalgary.ca"]
    ),
    ["customer@example.com", "rep@connect.experiencecalgary.ca"]
  );
});

test("routed replies must target the thread mailbox", () => {
  const thread = { replyAddress: "owner@connect.experiencecalgary.ca" };
  assert.equal(
    routedReceivingAddress(thread, [
      "customer@example.com",
      "owner@connect.experiencecalgary.ca",
    ]),
    "owner@connect.experiencecalgary.ca"
  );
  assert.equal(
    routedReceivingAddress(thread, [
      "different@connect.experiencecalgary.ca",
    ]),
    ""
  );
});
