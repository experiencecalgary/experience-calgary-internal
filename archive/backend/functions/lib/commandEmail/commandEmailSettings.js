"use strict";

const { HttpsError } = require("firebase-functions/v2/https");
const { EMAIL_DOMAIN, allocateSenderAddress } = require("./emailAddress");

const MAX_SENDER_NAME_LENGTH = 120;
const MAX_SIGNATURE_LENGTH = 50000;

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ").trim();
}

function sanitizeSignatureHtml(value) {
  const html = clean(value);
  if (html.length > MAX_SIGNATURE_LENGTH) {
    throw new HttpsError("invalid-argument", "Email signature is too long.");
  }
  return html
    .replace(/<(script|iframe|object|embed|form|input|button|textarea|select|meta|link|base)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<(script|iframe|object|embed|form|input|button|textarea|select|meta|link|base)\b[^>]*\/?>/gi, "")
    .replace(/\son[a-z]+\s*=\s*(["']).*?\1/gi, "")
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "")
    .replace(/\s(href|src)\s*=\s*(["'])\s*(javascript:|data:)[\s\S]*?\2/gi, "");
}

function normalizeSettings(userData = {}) {
  const senderName = clean(userData.commandEmailSenderName);
  const signatureHtml = sanitizeSignatureHtml(userData.commandEmailSignatureHtml);
  const suppliedText = clean(userData.commandEmailSignatureText);
  const signatureText = (suppliedText || stripHtml(signatureHtml)).slice(0, MAX_SIGNATURE_LENGTH);
  return {
    senderName,
    signatureHtml,
    signatureText,
    includeSignatureNew: userData.commandEmailIncludeSignatureNew !== false,
    includeSignatureReplies: userData.commandEmailIncludeSignatureReplies !== false,
  };
}

async function resolveCommandMailbox(db, admin, actor, options = {}) {
  let userSnap = await actor.userRef.get();
  if (!userSnap.exists) {
    throw new HttpsError("failed-precondition", "The ExMail user profile no longer exists.");
  }
  let userData = userSnap.data() || {};
  let commandEmailAddress = clean(userData.commandEmailAddress).toLowerCase();

  if (options.allocateIfMissing !== false) {
    commandEmailAddress = await allocateSenderAddress(
      db,
      admin,
      { ...actor, userData }
    );
    userSnap = await actor.userRef.get();
    userData = userSnap.data() || {};
  }

  const parts = commandEmailAddress.split("@");
  if (parts.length !== 2 || !parts[0] || parts[1] !== EMAIL_DOMAIN) {
    throw new HttpsError("failed-precondition", "Your Command email address is missing or invalid.");
  }

  const [addressSnap, aliasSnap] = await Promise.all([
    db.collection("commandEmailAddresses").doc(actor.uid).get(),
    db.collection("commandEmailAliases").doc(parts[0]).get(),
  ]);
  const addressData = addressSnap.data() || {};
  const aliasData = aliasSnap.data() || {};
  const registeredAddress = clean(addressData.address).toLowerCase();
  const aliasAddress = clean(aliasData.address).toLowerCase();

  if (
    !addressSnap.exists || addressData.active === false ||
    registeredAddress !== commandEmailAddress ||
    clean(addressData.uid) !== actor.uid ||
    addressData.userRef?.path !== actor.userRef.path ||
    !aliasSnap.exists ||
    aliasAddress !== commandEmailAddress ||
    clean(aliasData.uid) !== actor.uid ||
    aliasData.userRef?.path !== actor.userRef.path
  ) {
    throw new HttpsError(
      "failed-precondition",
      "Your ExMail address configuration is out of sync. Contact an administrator before sending email."
    );
  }

  const settings = normalizeSettings(userData);
  return {
    address: commandEmailAddress,
    userData,
    senderName: settings.senderName || actor.name,
    ...settings,
  };
}

function appendSignature(content, mailbox, mode) {
  const enabled = mode === "reply"
    ? mailbox.includeSignatureReplies
    : mailbox.includeSignatureNew;
  const hasSignature = Boolean(mailbox.signatureHtml || mailbox.signatureText);
  if (!enabled || !hasSignature) {
    return { ...content, signatureApplied: false, signatureHtml: "", signatureText: "" };
  }

  const signatureText = mailbox.signatureText || stripHtml(mailbox.signatureHtml);
  const signatureHtml = mailbox.signatureHtml ||
    escapeHtml(signatureText).replace(/\r?\n/g, "<br>");
  const bodyText = `${content.bodyText}\n\n${signatureText}`;
  const bodyHtml = `${content.bodyHtml}<br><br>${signatureHtml}`;
  if (bodyText.length > 200000 || bodyHtml.length > 200000) {
    throw new HttpsError(
      "invalid-argument",
      "The email body and signature are too long."
    );
  }
  return {
    ...content,
    bodyText,
    bodyHtml,
    signatureApplied: true,
    signatureHtml,
    signatureText,
  };
}

function validateSettingsInput(raw = {}) {
  const senderName = clean(raw.senderName);
  if (!senderName || senderName.length > MAX_SENDER_NAME_LENGTH) {
    throw new HttpsError(
      "invalid-argument",
      `Sender name is required and must be ${MAX_SENDER_NAME_LENGTH} characters or fewer.`
    );
  }
  const signatureHtml = sanitizeSignatureHtml(raw.signatureHtml);
  const suppliedText = clean(raw.signatureText);
  if (suppliedText.length > MAX_SIGNATURE_LENGTH) {
    throw new HttpsError("invalid-argument", "Email signature is too long.");
  }
  return {
    senderName,
    signatureHtml,
    signatureText: suppliedText || stripHtml(signatureHtml),
    includeSignatureNew: raw.includeSignatureNew !== false,
    includeSignatureReplies: raw.includeSignatureReplies !== false,
  };
}

module.exports = {
  resolveCommandMailbox,
  appendSignature,
  validateSettingsInput,
  sanitizeSignatureHtml,
  stripHtml,
};
