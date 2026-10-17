"use strict";

const admin = require("firebase-admin");
const { HttpsError } = require("firebase-functions/v2/https");
const {
  THREADS_COLLECTION,
  CONNECTIONS_COLLECTION,
  clean,
  requireEmailActor,
  assertThreadAccess,
} = require("./emailAccess");
const {
  normalizeContent,
  normalizeClientRequestId,
} = require("./emailContent");
const { sendWithSendGrid } = require("./sendgridClient");
const {
  parseOutgoingAttachments,
  storeAttachments,
  sendGridAttachments,
} = require("./emailAttachments");
const { resolveCommandMailbox, appendSignature } = require("./commandEmailSettings");
const {
  normalizeMessageId,
  createMessageId,
  routingRef,
} = require("./emailRouting");
const {
  uniqueAddresses,
  validateCcAddresses,
  threadParticipantAddresses,
  resolveReplyRecipients,
} = require("./emailRecipients");

function createReplyCommandEmailService({ SENDGRID_API_KEY, logger }) {
  return async function replyCommandEmailService(request) {
    const db = admin.firestore();
    const actor = await requireEmailActor(db, request);
    const raw = request.data || {};
    const outgoingFiles = parseOutgoingAttachments(raw.attachments);
    const threadId = clean(raw.threadId);
    if (!threadId || threadId.includes("/")) {
      throw new HttpsError("invalid-argument", "A valid threadId is required.");
    }

    const meetingCard = raw.meetingCard && typeof raw.meetingCard === "object" ? raw.meetingCard : null;
    const contentInput = meetingCard ? {
      ...raw,
      bodyText: `${typeof raw.bodyText === "string" ? raw.bodyText : ""}\n\n${typeof meetingCard.plainText === "string" ? meetingCard.plainText : ""}`.trim(),
      bodyHtml: `${typeof raw.bodyHtml === "string" ? raw.bodyHtml : ""}${typeof meetingCard.html === "string" ? meetingCard.html : ""}`,
    } : raw;
    const normalizedContent = normalizeContent(contentInput);
    const clientRequestId = normalizeClientRequestId(raw.clientRequestId);
    const threadRef = db.collection(THREADS_COLLECTION).doc(threadId);
    const threadSnap = await threadRef.get();
    if (!threadSnap.exists) {
      throw new HttpsError("not-found", "The email thread does not exist.");
    }

    const thread = threadSnap.data() || {};
    assertThreadAccess(actor, thread);
    if (thread.status !== "active") {
      throw new HttpsError(
        "failed-precondition",
        "This email thread is not active."
      );
    }

    const legacyToAddress = clean(thread.toAddress).toLowerCase();
    const senderAddress = clean(thread.senderAddress).toLowerCase();
    const replyAddress = clean(thread.replyAddress).toLowerCase();
    const subject = clean(thread.subject);
    if (!legacyToAddress || !senderAddress || !replyAddress || !subject) {
      throw new HttpsError(
        "failed-precondition",
        "This thread is missing required email routing information."
      );
    }

    const ownerRef = thread.ownerRef || actor.userRef;
    const ownerSnap = await ownerRef.get();
    if (!ownerSnap.exists) {
      throw new HttpsError("failed-precondition", "The thread owner profile is missing.");
    }
    const ownerData = ownerSnap.data() || {};
    const mailboxOwner = {
      uid: thread.ownerUid || ownerRef.id,
      userRef: ownerRef,
      userData: ownerData,
      name: thread.ownerName || actor.name,
      repId: clean(ownerData.repId),
      teamRepIds: [],
    };
    const mailbox = await resolveCommandMailbox(db, admin, mailboxOwner, {
      allocateIfMissing: false,
    });
    if (senderAddress !== mailbox.address || replyAddress !== mailbox.address) {
      throw new HttpsError(
        "failed-precondition",
        "This thread mailbox no longer matches its owner’s Command email address."
      );
    }
    const content = appendSignature(normalizedContent, mailbox, "reply");
    const replyRecipients = resolveReplyRecipients(thread, {
      replyAll: raw.replyAll === true,
      senderAddress,
    });
    const toAddress = replyRecipients.toAddress;
    const requestedCc = Array.isArray(raw.ccAddresses)
      ? raw.ccAddresses
      : raw.ccAddress
        ? [raw.ccAddress]
        : [];
    const ccAddresses = validateCcAddresses([
      ...replyRecipients.ccAddresses,
      ...requestedCc,
    ], {
      toAddresses: [toAddress],
      excludeAddresses: [senderAddress],
    });
    const participantAddresses = uniqueAddresses([
      ...threadParticipantAddresses(thread),
      toAddress,
      ...ccAddresses,
    ]);

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
          threadId,
          messageId: existing.messageId,
        };
      }
      throw new HttpsError(
        "already-exists",
        "This reply request is already being processed."
      );
    }

    const messageRef = threadRef.collection("emailMessages").doc();
    const providerMessageId = createMessageId(messageRef);
    const messageRoutingRef = routingRef(db, providerMessageId);
    const replyParentMessageId = normalizeMessageId(
      thread.lastInboundMessageId || thread.lastOutboundMessageId || thread.rootMessageId
    );
    const referenceIds = [
      normalizeMessageId(thread.rootMessageId),
      replyParentMessageId,
    ].filter((value, index, values) => value && values.indexOf(value) === index);
    const now = admin.firestore.FieldValue.serverTimestamp();
    const storedAttachments = await storeAttachments({
      admin,
      files: outgoingFiles,
      threadId,
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
          "This reply request is already being processed."
        );
      }

      transaction.create(idempotencyRef, {
        uid: actor.uid,
        clientRequestId,
        threadId,
        messageId: messageRef.id,
        status: "processing",
        createdAt: now,
        updatedAt: now,
      });
      transaction.create(messageRoutingRef, {
        messageId: providerMessageId,
        threadRef,
        messageRef,
        threadId,
        direction: "out",
        status: "processing",
        createdAt: now,
        updatedAt: now,
      });
      transaction.create(messageRef, {
        direction: "out",
        fromName: mailbox.senderName,
        fromAddress: senderAddress,
        toAddress,
        toAddresses: [toAddress],
        ccAddresses,
        replyToAddress: replyAddress,
        providerMessageId,
        inReplyTo: replyParentMessageId || null,
        references: referenceIds,
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
          to: toAddress,
          ...(ccAddresses.length ? { cc: ccAddresses } : {}),
          from: {
            email: senderAddress,
            name: mailbox.senderName,
          },
          replyTo: {
            email: replyAddress,
            name: mailbox.senderName,
          },
          subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
          headers: {
            "Message-ID": providerMessageId,
            ...(replyParentMessageId
              ? { "In-Reply-To": replyParentMessageId }
              : {}),
            ...(referenceIds.length
              ? { References: referenceIds.join(" ") }
              : {}),
          },
          text: content.bodyText,
          html: content.bodyHtml,
          ...(providerAttachments.length ? { attachments: providerAttachments } : {}),
          customArgs: {
            commandThreadId: threadId,
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
        participantAddresses,
        lastMessageAt: sentAt,
        lastMessagePreview: content.preview,
        lastMessageStatus: "sent",
        lastOutboundMessageId: providerMessageId,
        updatedAt: sentAt,
      });
      batch.update(idempotencyRef, {
        status: "sent",
        sendgridMessageId: result.messageId || null,
        updatedAt: sentAt,
      });
      batch.set(connectionRef, {
        type: "email_out",
        ...(thread.leadRef ? { leadRef: thread.leadRef } : {}),
        summary: `Email reply sent: ${subject}`,
        body: content.preview,
        personRef: thread.personRef || null,
        personName: clean(thread.personName),
        organizationRef: thread.organizationRef || null,
        organizationName: clean(thread.organizationName),
        recordType: thread.personRef ? "person" : (thread.organizationRef ? "organization" : "general"),
        recordName: clean(thread.personName) || clean(thread.organizationName) || subject,
        threadRef,
        ownerRef: thread.ownerRef || actor.userRef,
        ownerUid: thread.ownerUid || actor.uid,
        ownerName: thread.ownerName || actor.name,
        createdByRef: actor.userRef,
        createdByUid: actor.uid,
        createdByName: actor.name,
        viewerUids: Array.isArray(thread.viewerUids) ? thread.viewerUids : [actor.uid],
        teamRepIds: Array.isArray(thread.teamRepIds)
          ? thread.teamRepIds
          : actor.teamRepIds,
        createdAt: sentAt,
      });
      await batch.commit();

      logger.info("COMMAND_EMAIL_REPLY_SENT", {
        threadId,
        messageId: messageRef.id,
        actorUid: actor.uid,
      });

      return {
        ok: true,
        duplicate: false,
        threadId,
        messageId: messageRef.id,
        toAddresses: [toAddress],
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

      logger.error("COMMAND_EMAIL_REPLY_ERROR", {
        threadId,
        messageId: messageRef.id,
        actorUid: actor.uid,
        message: error.message,
      });

      throw new HttpsError(
        "internal",
        "The reply could not be sent. The failed attempt was recorded."
      );
    }
  };
}

module.exports = {
  createReplyCommandEmailService,
};

