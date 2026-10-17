"use strict";

const crypto = require("crypto");
const { HttpsError } = require("firebase-functions/v2/https");

const MAX_ATTACHMENTS = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const ALLOWED = new Map([
  [".pdf", ["application/pdf"]],
  [".doc", ["application/msword"]],
  [".docx", ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"]],
  [".xls", ["application/vnd.ms-excel"]],
  [".xlsx", ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]],
  [".csv", ["text/csv", "application/csv", "text/plain"]],
  [".txt", ["text/plain"]],
  [".jpg", ["image/jpeg"]],
  [".jpeg", ["image/jpeg"]],
  [".png", ["image/png"]],
  [".webp", ["image/webp"]],
]);

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function safeFileName(value) {
  const original = clean(value).split(/[\\/]/).pop() || "attachment";
  const safe = original
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^a-zA-Z0-9._() -]/g, "_")
    .replace(/\.{2,}/g, ".")
    .slice(0, 180);
  return safe && safe !== "." ? safe : "attachment";
}

function extensionOf(fileName) {
  const match = safeFileName(fileName).toLowerCase().match(/\.[a-z0-9]+$/);
  return match ? match[0] : "";
}

function validateAttachment({ fileName, contentType, bytes }) {
  const safeName = safeFileName(fileName);
  const type = clean(contentType).toLowerCase().split(";")[0];
  const extension = extensionOf(safeName);
  const allowedTypes = ALLOWED.get(extension);
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    return { ok: false, fileName: safeName, reason: "empty_file" };
  }
  if (bytes.length > MAX_FILE_BYTES) {
    return { ok: false, fileName: safeName, reason: "file_too_large" };
  }
  if (!allowedTypes || !allowedTypes.includes(type)) {
    return { ok: false, fileName: safeName, reason: "unsupported_file_type" };
  }
  return { ok: true, fileName: safeName, contentType: type, sizeBytes: bytes.length };
}

function parseOutgoingAttachments(rawAttachments) {
  if (rawAttachments == null) return [];
  if (!Array.isArray(rawAttachments)) {
    throw new HttpsError("invalid-argument", "attachments must be a list.");
  }
  if (rawAttachments.length > MAX_ATTACHMENTS) {
    throw new HttpsError("invalid-argument", "A maximum of 10 attachments is allowed.");
  }

  let totalBytes = 0;
  return rawAttachments.map((raw, index) => {
    const encoded = clean(raw?.base64);
    let bytes;
    try {
      bytes = Buffer.from(encoded, "base64");
    } catch (_error) {
      bytes = Buffer.alloc(0);
    }
    if (!encoded || bytes.length === 0) {
      throw new HttpsError("invalid-argument", `Attachment ${index + 1} is empty or invalid.`);
    }
    const validated = validateAttachment({
      fileName: raw?.fileName,
      contentType: raw?.contentType,
      bytes,
    });
    if (!validated.ok) {
      throw new HttpsError(
        "invalid-argument",
        `Attachment "${validated.fileName}" was rejected: ${validated.reason}.`
      );
    }
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new HttpsError("invalid-argument", "Attachments exceed the 20 MB combined limit.");
    }
    return { ...validated, bytes };
  });
}

async function storeAttachments({
  admin,
  files,
  threadId,
  messageId,
  direction,
  unmatchedReceiptId = "",
}) {
  const bucket = admin.storage().bucket();
  const accepted = [];
  const rejected = [];
  let acceptedBytes = 0;

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (index >= MAX_ATTACHMENTS) {
      rejected.push({ fileName: safeFileName(file.fileName), reason: "too_many_attachments" });
      continue;
    }
    const validated = validateAttachment(file);
    if (!validated.ok) {
      rejected.push({ fileName: validated.fileName, reason: validated.reason });
      continue;
    }
    if (acceptedBytes + validated.sizeBytes > MAX_TOTAL_BYTES) {
      rejected.push({ fileName: validated.fileName, reason: "combined_size_limit" });
      continue;
    }

    const id = crypto.randomUUID();
    const root = unmatchedReceiptId
      ? `commandEmailAttachments/unmatched/${unmatchedReceiptId}`
      : `commandEmailAttachments/${threadId}/${messageId}`;
    const storagePath = `${root}/${id}/${validated.fileName}`;
    await bucket.file(storagePath).save(file.bytes, {
      resumable: false,
      validation: "crc32c",
      metadata: {
        contentType: validated.contentType,
        cacheControl: "private, max-age=0, no-store",
        metadata: { attachmentId: id, threadId, messageId, direction },
      },
    });
    acceptedBytes += validated.sizeBytes;
    accepted.push({
      id,
      fileName: validated.fileName,
      contentType: validated.contentType,
      sizeBytes: validated.sizeBytes,
      disposition: clean(file.disposition) || "attachment",
      contentId: clean(file.contentId) || null,
      source: direction,
      storagePath,
    });
  }

  return { accepted, rejected };
}

function sendGridAttachments(files, stored) {
  return stored.map((metadata, index) => ({
    content: files[index].bytes.toString("base64"),
    filename: metadata.fileName,
    type: metadata.contentType,
    disposition: metadata.disposition || "attachment",
    ...(metadata.contentId ? { content_id: metadata.contentId } : {}),
  }));
}

module.exports = {
  MAX_ATTACHMENTS,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  safeFileName,
  validateAttachment,
  parseOutgoingAttachments,
  storeAttachments,
  sendGridAttachments,
};
