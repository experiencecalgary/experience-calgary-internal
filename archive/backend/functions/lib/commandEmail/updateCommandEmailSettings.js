"use strict";

const admin = require("firebase-admin");
const { requireEmailActor } = require("./emailAccess");
const {
  resolveCommandMailbox,
  validateSettingsInput,
} = require("./commandEmailSettings");

function createUpdateCommandEmailSettingsService({ logger = console } = {}) {
  return async function updateCommandEmailSettingsService(request) {
    const db = admin.firestore();
    const actor = await requireEmailActor(db, request);
    const mailbox = await resolveCommandMailbox(db, admin, actor);
    const settings = validateSettingsInput(request.data || {});
    const now = admin.firestore.FieldValue.serverTimestamp();

    await actor.userRef.set({
      commandEmailSenderName: settings.senderName,
      commandEmailSignatureHtml: settings.signatureHtml,
      commandEmailSignatureText: settings.signatureText,
      commandEmailIncludeSignatureNew: settings.includeSignatureNew,
      commandEmailIncludeSignatureReplies: settings.includeSignatureReplies,
      commandEmailSettingsUpdatedAt: now,
      commandEmailSettingsUpdatedBy: actor.userRef,
    }, { merge: true });

    logger.info("COMMAND_EMAIL_SETTINGS_UPDATED", {
      uid: actor.uid,
      commandEmailAddress: mailbox.address,
    });

    return {
      ok: true,
      result: "updated",
      commandEmailAddress: mailbox.address,
      senderName: settings.senderName,
      includeSignatureNew: settings.includeSignatureNew,
      includeSignatureReplies: settings.includeSignatureReplies,
    };
  };
}

module.exports = { createUpdateCommandEmailSettingsService };
