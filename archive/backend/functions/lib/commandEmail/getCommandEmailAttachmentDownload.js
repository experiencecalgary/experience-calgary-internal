"use strict";

const admin = require("firebase-admin");
const { HttpsError } = require("firebase-functions/v2/https");
const {
  THREADS_COLLECTION,
  clean,
  requireEmailActor,
  assertThreadReadAccess,
} = require("./emailAccess");

function createGetCommandEmailAttachmentDownloadService() {
  return async function getCommandEmailAttachmentDownloadService(request) {
    const db = admin.firestore();
    const actor = await requireEmailActor(db, request);
    const raw = request.data || {};
    const threadId = clean(raw.threadId);
    const messageId = clean(raw.messageId);
    const attachmentId = clean(raw.attachmentId);
    if (
      !threadId || threadId.includes("/") ||
      !messageId || messageId.includes("/") ||
      !attachmentId || attachmentId.includes("/")
    ) {
      throw new HttpsError(
        "invalid-argument",
        "Valid threadId, messageId, and attachmentId values are required."
      );
    }

    const threadRef = db.collection(THREADS_COLLECTION).doc(threadId);
    const [threadSnap, messageSnap] = await Promise.all([
      threadRef.get(),
      threadRef.collection("emailMessages").doc(messageId).get(),
    ]);
    if (!threadSnap.exists || !messageSnap.exists) {
      throw new HttpsError("not-found", "The email attachment does not exist.");
    }
    assertThreadReadAccess(actor, threadSnap.data() || {});

    const attachments = Array.isArray(messageSnap.data()?.attachments)
      ? messageSnap.data().attachments
      : [];
    const attachment = attachments.find((item) => clean(item?.id) === attachmentId);
    if (!attachment || !clean(attachment.storagePath)) {
      throw new HttpsError("not-found", "The email attachment does not exist.");
    }

    const expires = Date.now() + 15 * 60 * 1000;
    const [downloadUrl] = await admin.storage().bucket()
      .file(attachment.storagePath)
      .getSignedUrl({
        action: "read",
        expires,
        responseDisposition: `attachment; filename="${String(attachment.fileName || "attachment").replace(/["\\]/g, "_")}"`,
        responseType: attachment.contentType || "application/octet-stream",
      });

    return {
      ok: true,
      downloadUrl,
      expiresAt: new Date(expires).toISOString(),
      fileName: attachment.fileName || "attachment",
      contentType: attachment.contentType || "application/octet-stream",
      sizeBytes: Number(attachment.sizeBytes || 0),
    };
  };
}

module.exports = { createGetCommandEmailAttachmentDownloadService };
