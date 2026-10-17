"use strict";

const admin = require("firebase-admin");
const { resolveEmailLead } = require("./commandEmailLeadLink");
const { HttpsError } = require("firebase-functions/v2/https");
const {
  THREADS_COLLECTION,
  CONNECTIONS_COLLECTION,
  requireEmailActor,
  resolveViewerUids,
  resolveEmailRelationship,
  unique,
} = require("./emailAccess");
const { resolveCommandMailbox, appendSignature } = require("./commandEmailSettings");
const {
  createMessageId,
  routingRef,
} = require("./emailRouting");
const {
  validateSubject,
  normalizeContent,
  normalizeClientRequestId,
} = require("./emailContent");
const { sendWithSendGrid } = require("./sendgridClient");
const {
  parseOutgoingAttachments,
  storeAttachments,
  sendGridAttachments,
} = require("./emailAttachments");
const {
  uniqueAddresses,
  validateCcAddresses,
} = require("./emailRecipients");

function createSendCommandEmailService({ SENDGRID_API_KEY, logger }) {
  return async function sendCommandEmailService(request) {
    const db = admin.firestore();
    const actor = await requireEmailActor(db, request);
    const raw = request.data || {};
    const outgoingFiles = parseOutgoingAttachments(raw.attachments);
    const subject = validateSubject(raw.subject);
    const meetingCard = raw.meetingCard && typeof raw.meetingCard === "object" ? raw.meetingCard : null;
    const contentInput = meetingCard ? {
      ...raw,
      bodyText: `${typeof raw.bodyText === "string" ? raw.bodyText : ""}\n\n${typeof meetingCard.plainText === "string" ? meetingCard.plainText : ""}`.trim(),
      bodyHtml: `${typeof raw.bodyHtml === "string" ? raw.bodyHtml : ""}${typeof meetingCard.html === "string" ? meetingCard.html : ""}`,
    } : raw;
    const normalizedContent = normalizeContent(contentInput);
    const clientRequestId = normalizeClientRequestId(raw.clientRequestId);
    const relationship = await resolveEmailRelationship(db, actor, raw);
    const leadRef = await resolveEmailLead(db, actor, raw, relationship);
    const actorViewerUids = await resolveViewerUids(db, actor);
    const viewerUids = unique([
      ...actorViewerUids,
      ...(relationship.viewerUids || []),
    ]);
    const threadTeamRepIds = unique([
      ...actor.teamRepIds,
      ...(relationship.teamRepIds || []),
    ]);
    const mailbox = await resolveCommandMailbox(db, admin, actor);
    const senderAddress = mailbox.address;
    const toAddresses = [relationship.toAddress];
    const ccAddresses = validateCcAddresses(raw.ccAddresses || raw.ccAddress, {
      toAddresses,
      excludeAddresses: [senderAddress],
    });
    const participantAddresses = uniqueAddresses([
      ...toAddresses,
      ...ccAddresses,
    ]);
    const content = appendSignature(normalizedContent, mailbox, "new");

    const idempotencyRef = db
      .collection("commandEmailSendRequests")
      .doc(`${actor.uid}_${clientRequestId}`);
    const existingRequest = await idempotencyRef.get();
    if (existingRequest.exists) {
      const existing = existingRequest.data() || {};
      if (existing.status === "sent") {
        return {
          ok: true,
          duplicate: true,
          threadId: existing.threadId,
          messageId: existing.messageId,
        };
      }
      throw new HttpsError(
        "already-exists",
        "This email request is already being processed."
      );
    }

    const threadRef = db.collection(THREADS_COLLECTION).doc();
    const messageRef = threadRef.collection("emailMessages").doc();
    const replyAddress = senderAddress;
    const providerMessageId = createMessageId(messageRef);
    const messageRoutingRef = routingRef(db, providerMessageId);
    const now = admin.firestore.FieldValue.serverTimestamp();
    const storedAttachments = await storeAttachments({
      admin,
      files: outgoingFiles,
      threadId: threadRef.id,
      messageId: messageRef.id,
      direction: "email_out",
    });
    const attachmentMetadata = storedAttachments.accepted;
    const providerAttachments = sendGridAttachments(outgoingFiles, attachmentMetadata);

    await db.runTransaction(async (transaction) => {
      const requestSnap = await transaction.get(idempotencyRef);
      if (requestSnap.exists) {
        throw new HttpsError(
          "already-exists",
          "This email request is already being processed."
        );
      }

      transaction.create(idempotencyRef, {
        uid: actor.uid,
        clientRequestId,
        threadId: threadRef.id,
        messageId: messageRef.id,
        status: "processing",
        createdAt: now,
        updatedAt: now,
      });
      transaction.create(messageRoutingRef, {
        messageId: providerMessageId,
        threadRef,
        messageRef,
        threadId: threadRef.id,
        direction: "out",
        status: "processing",
        createdAt: now,
        updatedAt: now,
      });
      transaction.create(threadRef, {
        ...(leadRef ? { leadRef } : {}),
        subject,
        personRef: relationship.personRef,
        personName: relationship.personName,
        organizationRef: relationship.organizationRef,
        organizationName: relationship.organizationName,
        toAddress: relationship.toAddress,
        participantAddresses,
        ownerUid: actor.uid,
        ownerRef: actor.userRef,
        ownerName: actor.name,
        senderAddress,
        replyAddress,
        rootMessageId: providerMessageId,
        lastOutboundMessageId: providerMessageId,
        viewerUids,
        teamRepIds: threadTeamRepIds,
        unreadBy: [],
        status: "active",
        lastMessageAt: now,
        lastMessagePreview: content.preview,
        lastMessageStatus: "processing",
        createdAt: now,
        updatedAt: now,
      });
      transaction.create(messageRef, {
        ...(leadRef ? { leadRef } : {}),
        direction: "out",
        fromName: mailbox.senderName,
        fromAddress: senderAddress,
        toAddress: relationship.toAddress,
        toAddresses,
        ccAddresses,
        replyToAddress: replyAddress,
        providerMessageId,
        subject,
        bodyHtml: content.bodyHtml,
        bodyText: content.bodyText,
        signatureApplied: content.signatureApplied,
        signatureHtml: content.signatureHtml,
        signatureText: content.signatureText,
        attachments: attachmentMetadata,
        attachmentCount: attachmentMetadata.length,
        hasAttachments: attachmentMetadata.length > 0,
        rejectedAttachments: [],
        status: "processing",
        clientRequestId,
        createdAt: now,
        createdByUid: actor.uid,
        createdByRef: actor.userRef,
        createdByName: actor.name,
        commandFollowUp: raw.createFollowUp === true ? {
          title: typeof raw.followUpTitle === "string" ? raw.followUpTitle.trim() : "",
          description: typeof raw.followUpDescription === "string" ? raw.followUpDescription.trim() : "",
          type: typeof raw.followUpType === "string" ? raw.followUpType.trim() : "Follow-up",
          priority: typeof raw.followUpPriority === "string" ? raw.followUpPriority.trim() : "Medium",
          dueAt: raw.followUpDueAt || null,
          assignedToRefPath: typeof raw.followUpAssignedToRefPath === "string" ? raw.followUpAssignedToRefPath.trim() : "",
        } : null,
        meetingCard: raw.meetingCard && typeof raw.meetingCard === "object" ? raw.meetingCard : null,
      });
    });

    try {
      const result = await sendWithSendGrid({
        apiKeySecret: SENDGRID_API_KEY,
        message: {
          to: relationship.toAddress,
          ...(ccAddresses.length ? { cc: ccAddresses } : {}),
          from: { email: senderAddress, name: mailbox.senderName },
          replyTo: { email: replyAddress, name: mailbox.senderName },
          subject,
          headers: {
            "Message-ID": providerMessageId,
          },
          text: content.bodyText,
          html: content.bodyHtml,
          ...(providerAttachments.length ? { attachments: providerAttachments } : {}),
          customArgs: {
            commandThreadId: threadRef.id,
            commandMessageId: messageRef.id,
          },
          trackingSettings: {
            clickTracking: { enable: true, enableText: true },
            openTracking: { enable: true },
          },
        },
      });

      const sentAt = admin.firestore.FieldValue.serverTimestamp();
      const connectionRef = db.collection(CONNECTIONS_COLLECTION).doc();
      const batch = db.batch();
      batch.update(messageRoutingRef, {
        status: "sent",
        sendgridMessageId: result.messageId || null,
        updatedAt: sentAt,
      });
      batch.update(messageRef, {
        status: "sent",
        sendgridMessageId: result.messageId || null,
        sendgridStatusCode: result.statusCode,
        sentAt,
      });
      batch.update(threadRef, {
        lastMessageStatus: "sent",
        updatedAt: sentAt,
      });
      batch.update(idempotencyRef, {
        status: "sent",
        sendgridMessageId: result.messageId || null,
        updatedAt: sentAt,
      });
      batch.set(connectionRef, {
        ...(leadRef ? { leadRef } : {}),
        type: "email_out",
        summary: `Email sent: ${subject}`,
        body: content.preview,
        personRef: relationship.personRef,
        personName: relationship.personName,
        organizationRef: relationship.organizationRef,
        organizationName: relationship.organizationName,
        recordType: relationship.personRef ? "person" : (relationship.organizationRef ? "organization" : "general"),
        recordName: relationship.personName || relationship.organizationName || subject,
        threadRef,
        ownerRef: actor.userRef,
        ownerUid: actor.uid,
        ownerName: actor.name,
        createdByRef: actor.userRef,
        createdByUid: actor.uid,
        createdByName: actor.name,
        viewerUids,
        teamRepIds: threadTeamRepIds,
        createdAt: sentAt,
      });
      await batch.commit();

      logger.info("COMMAND_EMAIL_SENT", {
        threadId: threadRef.id,
        messageId: messageRef.id,
        ownerUid: actor.uid,
      });

      return {
        ok: true,
        duplicate: false,
        threadId: threadRef.id,
        threadPath: threadRef.path,
        messageId: messageRef.id,
        senderAddress,
        toAddresses,
        ccAddresses,
      };
    } catch (error) {
      const failedAt = admin.firestore.FieldValue.serverTimestamp();
      await Promise.all([
        messageRef.set(
          {
            status: "failed",
            failedAt,
            failureMessage: String(error.message || "SendGrid send failed").slice(0, 500),
          },
          { merge: true }
        ),
        idempotencyRef.set(
          {
            status: "failed",
            updatedAt: failedAt,
          },
          { merge: true }
        ),
        messageRoutingRef.set(
          {
            status: "failed",
            updatedAt: failedAt,
          },
          { merge: true }
        ),
        threadRef.set(
          {
            lastMessageStatus: "failed",
            updatedAt: failedAt,
          },
          { merge: true }
        ),
      ]);

      logger.error("COMMAND_EMAIL_SEND_ERROR", {
        threadId: threadRef.id,
        messageId: messageRef.id,
        ownerUid: actor.uid,
        message: error.message,
      });

      throw new HttpsError(
        "internal",
        "The email could not be sent. The failed attempt was recorded."
      );
    }
  };
}

module.exports = {
  createSendCommandEmailService,
};

