"use strict";

const crypto = require("crypto");

const ROUTING_COLLECTION = "commandEmailRouting";

function normalizeMessageId(value) {
  const cleaned = String(value || "").trim();
  if (!cleaned) return "";
  const match = cleaned.match(/<[^<>]+>/);
  return (match ? match[0] : cleaned).toLowerCase();
}

function createMessageId(messageRef) {
  const nonce = crypto.randomBytes(12).toString("hex");
  return `<ec-${messageRef.id}-${nonce}@connect.experiencecalgary.ca>`;
}

function routingId(messageId) {
  return crypto
    .createHash("sha256")
    .update(normalizeMessageId(messageId))
    .digest("hex");
}

function routingRef(db, messageId) {
  return db.collection(ROUTING_COLLECTION).doc(routingId(messageId));
}

function extractMessageIds(value) {
  const input = String(value || "");
  const bracketed = input.match(/<[^<>]+>/g);
  if (bracketed?.length) {
    return [...new Set(bracketed.map(normalizeMessageId).filter(Boolean))];
  }
  return [...new Set(input.split(/\s+/).map(normalizeMessageId).filter(Boolean))];
}

async function findRoutingRecord(db, inReplyTo, references) {
  const candidates = [
    ...extractMessageIds(inReplyTo),
    ...extractMessageIds(references).reverse(),
  ];

  for (const messageId of [...new Set(candidates)]) {
    const snap = await routingRef(db, messageId).get();
    if (snap.exists) return { messageId, data: snap.data() || {} };
  }
  return null;
}

module.exports = {
  ROUTING_COLLECTION,
  normalizeMessageId,
  createMessageId,
  routingRef,
  extractMessageIds,
  findRoutingRecord,
};
