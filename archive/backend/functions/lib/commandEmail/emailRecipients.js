"use strict";

const { HttpsError } = require("firebase-functions/v2/https");

const EMAIL_DOMAIN = "connect.experiencecalgary.ca";
const MAX_CC_RECIPIENTS = 10;
const EMAIL_PATTERN = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/gi;

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeEmail(value) {
  return clean(value).toLowerCase();
}

function uniqueAddresses(values) {
  return [...new Set((values || []).map(normalizeEmail).filter(Boolean))];
}

function parseAddressList(value) {
  const values = Array.isArray(value) ? value : [value];
  const addresses = [];
  for (const item of values) {
    const text = clean(item);
    if (!text) continue;
    const matches = text.match(EMAIL_PATTERN) || [];
    addresses.push(...matches);
  }
  return uniqueAddresses(addresses);
}

function parseEnvelopeRecipients(value) {
  let envelope = value;
  if (typeof envelope === "string") {
    try {
      envelope = JSON.parse(envelope);
    } catch (_error) {
      return [];
    }
  }
  if (!envelope || typeof envelope !== "object") return [];
  return parseAddressList([
    ...(Array.isArray(envelope.to) ? envelope.to : [envelope.to]),
    ...(Array.isArray(envelope.rcpt_to) ? envelope.rcpt_to : [envelope.rcpt_to]),
  ]);
}

function inboundRecipientCandidates(toAddresses, ccAddresses, envelopeRecipients) {
  return uniqueAddresses([
    ...(toAddresses || []),
    ...(ccAddresses || []),
    ...(envelopeRecipients || []),
  ]);
}

function routedReceivingAddress(thread = {}, candidates = []) {
  const replyAddress = normalizeEmail(thread.replyAddress);
  return inboundRecipientCandidates(candidates, [], []).find(
    (address) => address === replyAddress
  ) || "";
}

function isInternalAddress(value) {
  const normalized = normalizeEmail(value);
  return normalized.endsWith(`@${EMAIL_DOMAIN}`);
}

function validateCcAddresses(value, options = {}) {
  const supplied = Array.isArray(value)
    ? value
    : clean(value)
      ? parseAddressList(value)
      : [];
  const nonEmptySupplied = supplied.map(clean).filter(Boolean);
  for (const recipient of nonEmptySupplied) {
    if (parseAddressList(recipient).length !== 1) {
      throw new HttpsError(
        "invalid-argument",
        "Every CC recipient must be a valid email address."
      );
    }
  }
  const parsed = parseAddressList(nonEmptySupplied);

  const excluded = new Set(uniqueAddresses([
    ...(options.toAddresses || []),
    ...(options.excludeAddresses || []),
  ]));
  const ccAddresses = parsed.filter((address) => !excluded.has(address));
  const max = Number.isInteger(options.max) ? options.max : MAX_CC_RECIPIENTS;
  if (ccAddresses.length > max) {
    throw new HttpsError(
      "invalid-argument",
      `A maximum of ${max} CC recipients is allowed.`
    );
  }
  return ccAddresses;
}

function threadParticipantAddresses(thread = {}) {
  return uniqueAddresses([
    ...(Array.isArray(thread.participantAddresses)
      ? thread.participantAddresses
      : []),
    thread.toAddress,
    thread.senderEmail,
  ]).filter((address) => !isInternalAddress(address));
}

function resolveReplyRecipients(thread = {}, options = {}) {
  const senderAddress = normalizeEmail(options.senderAddress);
  const toAddress = normalizeEmail(thread.senderEmail || thread.toAddress);
  if (!toAddress || isInternalAddress(toAddress)) {
    throw new HttpsError(
      "failed-precondition",
      "This thread is missing a valid external recipient."
    );
  }

  const ccAddresses = options.replyAll === true
    ? threadParticipantAddresses(thread).filter(
        (address) => address !== toAddress && address !== senderAddress
      )
    : [];

  return { toAddress, ccAddresses };
}

module.exports = {
  EMAIL_DOMAIN,
  MAX_CC_RECIPIENTS,
  normalizeEmail,
  uniqueAddresses,
  parseAddressList,
  parseEnvelopeRecipients,
  inboundRecipientCandidates,
  routedReceivingAddress,
  isInternalAddress,
  validateCcAddresses,
  threadParticipantAddresses,
  resolveReplyRecipients,
};
