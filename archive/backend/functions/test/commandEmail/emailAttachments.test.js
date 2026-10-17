"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_ATTACHMENTS,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  safeFileName,
  validateAttachment,
  parseOutgoingAttachments,
} = require("../../lib/commandEmail/emailAttachments");

test("attachment policy is fixed at the approved limits", () => {
  assert.equal(MAX_ATTACHMENTS, 10);
  assert.equal(MAX_FILE_BYTES, 10 * 1024 * 1024);
  assert.equal(MAX_TOTAL_BYTES, 20 * 1024 * 1024);
});

test("accepts approved PDF data", () => {
  const result = validateAttachment({
    fileName: "proposal.pdf",
    contentType: "application/pdf",
    bytes: Buffer.from("%PDF-test"),
  });
  assert.equal(result.ok, true);
  assert.equal(result.fileName, "proposal.pdf");
});

test("rejects mismatched or unsafe formats", () => {
  assert.equal(validateAttachment({
    fileName: "payload.exe",
    contentType: "application/octet-stream",
    bytes: Buffer.from("x"),
  }).reason, "unsupported_file_type");
  assert.equal(validateAttachment({
    fileName: "fake.pdf",
    contentType: "text/html",
    bytes: Buffer.from("<html>"),
  }).reason, "unsupported_file_type");
});

test("sanitizes paths from sender-provided filenames", () => {
  assert.equal(safeFileName("../../signed/agreement.pdf"), "agreement.pdf");
});

test("outgoing attachments decode base64 and enforce policy", () => {
  const parsed = parseOutgoingAttachments([{
    fileName: "notes.txt",
    contentType: "text/plain",
    base64: Buffer.from("hello").toString("base64"),
  }]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].bytes.toString(), "hello");
});

test("rejects more than ten outgoing attachments", () => {
  assert.throws(
    () => parseOutgoingAttachments(Array.from({ length: 11 }, () => ({}))),
    /maximum of 10/i
  );
});
