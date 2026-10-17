"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  appendSignature,
  validateSettingsInput,
  sanitizeSignatureHtml,
} = require("../lib/commandEmail/commandEmailSettings");

test("appends an enabled signature exactly once", () => {
  const content = { bodyText: "Hello", bodyHtml: "Hello", preview: "Hello" };
  const mailbox = {
    signatureText: "Matt\nExperience Calgary",
    signatureHtml: "<strong>Matt</strong><br>Experience Calgary",
    includeSignatureNew: true,
    includeSignatureReplies: true,
  };
  const result = appendSignature(content, mailbox, "new");
  assert.equal(result.signatureApplied, true);
  assert.equal(result.bodyText, "Hello\n\nMatt\nExperience Calgary");
  assert.match(result.bodyHtml, /<strong>Matt<\/strong>/);
  assert.equal(result.preview, "Hello");
});

test("does not append a disabled reply signature", () => {
  const result = appendSignature(
    { bodyText: "Reply", bodyHtml: "Reply", preview: "Reply" },
    {
      signatureText: "Signature",
      signatureHtml: "<b>Signature</b>",
      includeSignatureNew: true,
      includeSignatureReplies: false,
    },
    "reply"
  );
  assert.equal(result.signatureApplied, false);
  assert.equal(result.bodyText, "Reply");
});

test("sanitizes executable signature markup", () => {
  const html = sanitizeSignatureHtml(
    '<p onclick="bad()">Safe</p><script>alert(1)</script><a href="javascript:bad()">Link</a>'
  );
  assert.doesNotMatch(html, /script|onclick|javascript:/i);
  assert.match(html, /Safe/);
});

test("normalizes signature settings without accepting an address", () => {
  const result = validateSettingsInput({
    senderName: "Matt McBride",
    signatureHtml: "<b>Matt</b>",
    includeSignatureNew: true,
    includeSignatureReplies: false,
    commandEmailAddress: "attacker@example.com",
  });
  assert.equal(result.senderName, "Matt McBride");
  assert.equal(result.signatureText, "Matt");
  assert.equal(Object.hasOwn(result, "commandEmailAddress"), false);
});
