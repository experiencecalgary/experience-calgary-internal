"use strict";

const { HttpsError } = require("firebase-functions/v2/https");

const MAX_SUBJECT_LENGTH = 200;
const MAX_BODY_LENGTH = 200000;

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function textToHtml(value) {
  return escapeHtml(value).replace(/\r?\n/g, "<br>");
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeHtml(value) {
  return String(value || "")
    .replace(/<(script|iframe|object|embed|form)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<(script|iframe|object|embed|form)\b[^>]*\/?>/gi, "")
    .replace(/\son[a-z]+\s*=\s*(["']).*?\1/gi, "")
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "")
    .replace(/\s(href|src)\s*=\s*(["'])\s*javascript:[\s\S]*?\2/gi, "");
}

function validateSubject(value, required = true) {
  const subject = clean(value);
  if (required && !subject) {
    throw new HttpsError("invalid-argument", "Subject is required.");
  }
  if (subject.length > MAX_SUBJECT_LENGTH) {
    throw new HttpsError(
      "invalid-argument",
      `Subject must be ${MAX_SUBJECT_LENGTH} characters or fewer.`
    );
  }
  return subject;
}

function normalizeContent(raw = {}) {
  const bodyText = clean(raw.bodyText);
  const suppliedHtml = clean(raw.bodyHtml);
  const bodyHtml = suppliedHtml ? sanitizeHtml(suppliedHtml) : textToHtml(bodyText);
  const normalizedText = bodyText || stripHtml(bodyHtml);

  if (!normalizedText) {
    throw new HttpsError("invalid-argument", "Email body is required.");
  }
  if (
    normalizedText.length > MAX_BODY_LENGTH ||
    bodyHtml.length > MAX_BODY_LENGTH
  ) {
    throw new HttpsError(
      "invalid-argument",
      "Email body is too long."
    );
  }

  return {
    bodyText: normalizedText,
    bodyHtml,
    preview: normalizedText.slice(0, 240),
  };
}

function normalizeClientRequestId(value) {
  const requestId = clean(value);
  if (!requestId || requestId.length > 120 || !/^[A-Za-z0-9._:-]+$/.test(requestId)) {
    throw new HttpsError(
      "invalid-argument",
      "clientRequestId is required and must contain only letters, numbers, dots, underscores, colons, or hyphens."
    );
  }
  return requestId;
}

module.exports = {
  validateSubject,
  normalizeContent,
  normalizeClientRequestId,
};
