"use strict";

const Busboy = require("busboy");
const crypto = require("crypto");
const admin = require("firebase-admin");
const {
  THREADS_COLLECTION,
  CONNECTIONS_COLLECTION,
  PEOPLE_COLLECTION,
  normalizeEmail,
} = require("./emailAccess");
const {
  normalizeMessageId,
  findRoutingRecord,
} = require("./emailRouting");
const { cleanInboundReply } = require("./replyBodyCleaner");
const { storeAttachments } = require("./emailAttachments");
const {
  uniqueAddresses,
  parseAddressList,
  parseEnvelopeRecipients,
  inboundRecipientCandidates,
  routedReceivingAddress,
  isInternalAddress,
  threadParticipantAddresses,
} = require("./emailRecipients");
const {
  resolveEmailIdentity,
} = require("../command/commandEmailIdentity");

const INBOUND_COLLECTION = "commandEmailInboundReceipts";
const UNMATCHED_COLLECTION = "commandEmailInboundUnmatched";
const EMAIL_DOMAIN = "connect.experiencecalgary.ca";

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function stripHtml(value) {
  return clean(value)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function parseHeaders(value) {
  const headers = {};
  let current = "";
  for (const line of clean(value).split(/\r?\n/)) {
    if (/^\s/.test(line) && current) {
      headers[current] += ` ${line.trim()}`;
      continue;
    }
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    current = line.slice(0, separator).trim().toLowerCase();
    headers[current] = line.slice(separator + 1).trim();
  }
  return headers;
}

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const fields = {};
    const files = [];
    let busboy;
    try {
      busboy = Busboy({
        headers: req.headers,
        limits: {
          fields: 100,
          fieldSize: 5 * 1024 * 1024,
          files: 25,
          fileSize: 10 * 1024 * 1024 + 1,
        },
      });
    } catch (error) {
      reject(error);
      return;
    }

    busboy.on("field", (name, value) => {
      fields[name] = value;
    });
    busboy.on("file", (fieldName, stream, info = {}) => {
      const chunks = [];
      let truncated = false;
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("limit", () => { truncated = true; });
      stream.on("end", () => {
        files.push({
          fieldName,
          fileName: info.filename || fieldName,
          contentType: info.mimeType || "application/octet-stream",
          disposition: "attachment",
          contentId: "",
          bytes: Buffer.concat(chunks),
          truncated,
        });
      });
    });
    busboy.on("error", reject);
    busboy.on("finish", () => resolve({ ...fields, files, attachmentCount: files.length }));
    busboy.end(req.rawBody);
  });
}

async function readPayload(req) {
  if (/multipart\/form-data/i.test(clean(req.headers["content-type"]))) {
    if (!Buffer.isBuffer(req.rawBody)) {
      throw new Error("The multipart request body is unavailable.");
    }
    return parseMultipart(req);
  }
  return req.body && typeof req.body === "object" ? req.body : {};
}

function receiptId(messageId, from, to, subject) {
  const identity = normalizeMessageId(messageId) ||
    `${normalizeEmail(from)}|${normalizeEmail(to)}|${clean(subject)}|${Date.now()}`;
  return crypto.createHash("sha256").update(identity).digest("hex");
}

async function resolveRecipientOwner(db, toAddress) {
  const normalizedTo = normalizeEmail(toAddress);
  const [localPart, domain] = normalizedTo.split("@");
  if (!localPart || domain !== EMAIL_DOMAIN) return null;

  const aliasSnap = await db.collection("commandEmailAliases").doc(localPart).get();
  if (!aliasSnap.exists) return null;
  const alias = aliasSnap.data() || {};
  if (!alias.uid || !alias.userRef) return null;

  const [addressSnap, userSnap] = await Promise.all([
    db.collection("commandEmailAddresses").doc(alias.uid).get(),
    alias.userRef.get(),
  ]);
  if (!addressSnap.exists || !userSnap.exists) return null;

  const address = addressSnap.data() || {};
  const user = userSnap.data() || {};
  const registeredAddress = normalizeEmail(address.address);
  const aliasAddress = normalizeEmail(alias.address);
  const userAddress = normalizeEmail(user.commandEmailAddress);

  if (
    address.active === false ||
    registeredAddress !== normalizedTo ||
    aliasAddress !== normalizedTo ||
    userAddress !== normalizedTo ||
    address.uid !== alias.uid ||
    address.userRef?.path !== alias.userRef.path
  ) {
    return null;
  }

  return { ...alias, address: normalizedTo };
}

async function resolveRecipientOwners(db, addresses) {
  const owners = [];
  const seenUids = new Set();
  for (const address of uniqueAddresses(addresses)) {
    const owner = await resolveRecipientOwner(db, address);
    if (!owner || seenUids.has(owner.uid)) continue;
    seenUids.add(owner.uid);
    owners.push(owner);
  }
  return owners;
}

function externalParticipants(fromAddress, toAddresses, ccAddresses) {
  return uniqueAddresses([fromAddress, ...toAddresses, ...ccAddresses])
    .filter((address) => !isInternalAddress(address));
}

async function resolveSenderIdentity(db, fromAddress) {
  const normalized = normalizeEmail(fromAddress);
  const identity = await resolveEmailIdentity(db, normalized);
  let personSnap = identity.personRef ? await identity.personRef.get() : null;
  let organizationSnap = identity.organizationRef
    ? await identity.organizationRef.get()
    : null;

  // Safe compatibility fallback while legacy records are being backfilled.
  if (!personSnap?.exists) {
    const [primary, additional] = await Promise.all([
      db.collection(PEOPLE_COLLECTION)
        .where("emailNormalized", "==", normalized)
        .limit(2)
        .get(),
      db.collection(PEOPLE_COLLECTION)
        .where("additionalEmailsNormalized", "array-contains", normalized)
        .limit(2)
        .get(),
    ]);
    const people = new Map(
      [...primary.docs, ...additional.docs].map((doc) => [doc.ref.path, doc])
    );
    personSnap = people.size === 1 ? [...people.values()][0] : null;
  }

  if (!organizationSnap?.exists) {
    const [primary, additional] = await Promise.all([
      db.collection("commandOrganizations")
        .where("emailNormalized", "==", normalized)
        .limit(2)
        .get(),
      db.collection("commandOrganizations")
        .where("additionalEmailsNormalized", "array-contains", normalized)
        .limit(2)
        .get(),
    ]);
    const organizations = new Map(
      [...primary.docs, ...additional.docs].map((doc) => [doc.ref.path, doc])
    );
    organizationSnap = organizations.size === 1
      ? [...organizations.values()][0]
      : null;
  }

  return {
    personSnap: personSnap?.exists ? personSnap : null,
    organizationSnap: organizationSnap?.exists ? organizationSnap : null,
  };
}

async function resolveInboundViewerUids(db, ownerUid, ownerData = {}) {
  const viewerUids = new Set([ownerUid].filter(Boolean));
  const teamRepIds = [
    ownerData.repId,
    ownerData.programDirectorRepId,
    ownerData.directorRepId,
  ].filter(Boolean);

  for (const repId of teamRepIds) {
    const snap = await db
      .collection("users")
      .where("repId", "==", repId)
      .limit(2)
      .get();
    for (const doc of snap.docs) {
      const user = doc.data() || {};
      if (user.userType === "rep" && user.active !== false) viewerUids.add(doc.id);
    }
  }
  return { viewerUids: [...viewerUids], teamRepIds };
}

async function storeUnmatched(db, adminSdk, data) {
  const ref = db.collection(UNMATCHED_COLLECTION).doc(data.receiptId);
  const stored = await storeAttachments({
    admin: adminSdk,
    files: Array.isArray(data.files) ? data.files : [],
    threadId: "",
    messageId: "",
    direction: "email_in",
    unmatchedReceiptId: data.receiptId,
  });
  const { files: _files, ...record } = data;
  await ref.set({
    ...record,
    attachments: stored.accepted,
    rejectedAttachments: stored.rejected,
    attachmentCount: stored.accepted.length,
    hasAttachments: stored.accepted.length > 0,
    status: "unmatched",
    createdAt: adminSdk.firestore.FieldValue.serverTimestamp(),
  }, { merge: false });
}

function createReceiveCommandEmailService({ SENDGRID_INBOUND_TOKEN, logger }) {
  return async function receiveCommandEmailService(req, res) {
    if (req.method !== "POST") {
      res.set("Allow", "POST").status(405).send("Method Not Allowed");
      return;
    }

    const expectedToken = clean(SENDGRID_INBOUND_TOKEN.value());
    const suppliedToken = clean(req.query.token);
    const validToken = expectedToken && suppliedToken &&
      expectedToken.length === suppliedToken.length &&
      crypto.timingSafeEqual(Buffer.from(expectedToken), Buffer.from(suppliedToken));
    if (!validToken) {
      logger.warn("COMMAND_EMAIL_INBOUND_UNAUTHORIZED");
      res.status(401).send("Unauthorized");
      return;
    }

    try {
      const payload = await readPayload(req);
      const headers = parseHeaders(payload.headers);
      const fromAddress = parseAddressList(payload.from || headers.from)[0] || "";
      const inboundSenderName = clean(payload.from).replace(/<[^<>]+>/, "").trim() || fromAddress;
      const toAddresses = parseAddressList(payload.to || headers.to);
      const ccAddresses = parseAddressList(payload.cc || headers.cc);
      const envelopeRecipients = parseEnvelopeRecipients(payload.envelope);
      const recipientCandidates = inboundRecipientCandidates(
        toAddresses,
        ccAddresses,
        envelopeRecipients
      );
      const subject = clean(payload.subject || headers.subject).slice(0, 998);
      const rawBodyText = clean(payload.text) || stripHtml(payload.html);
      const rawBodyHtml = clean(payload.html) || null;
      const inboundMessageId = normalizeMessageId(
        headers["message-id"] || payload["message-id"]
      );
      const inReplyTo = clean(headers["in-reply-to"]);
      const references = clean(headers.references);
      const id = receiptId(
        inboundMessageId,
        fromAddress,
        recipientCandidates.join(","),
        subject
      );
      const receiptRef = admin.firestore().collection(INBOUND_COLLECTION).doc(id);

      if (!fromAddress || !recipientCandidates.length) {
        res.status(400).send("Missing sender or recipient");
        return;
      }

      const existing = await receiptRef.get();
      if (existing.exists) {
        res.status(200).send("OK");
        return;
      }

      const db = admin.firestore();
      const route = await findRoutingRecord(db, inReplyTo, references);
      const cleanedBody = cleanInboundReply({
        bodyText: rawBodyText,
        bodyHtml: rawBodyHtml,
        isReply: Boolean(route),
      });
      const {
        bodyText,
        bodyHtml,
        rawBodyText: preservedBodyText,
        rawBodyHtml: preservedBodyHtml,
        replyHistoryRemoved,
      } = cleanedBody;
      let threadRef = route?.data?.threadRef || null;
      let thread = null;
      let receivingAddress = "";
      let recipientOwners = [];
      const inboundParticipants = externalParticipants(
        fromAddress,
        toAddresses,
        ccAddresses
      );

      if (threadRef) {
        const threadSnap = await threadRef.get();
        if (threadSnap.exists) thread = threadSnap.data() || {};
        if (
          !thread ||
          !threadParticipantAddresses(thread).includes(normalizeEmail(fromAddress))
        ) {
          await storeUnmatched(db, admin, {
            receiptId: id,
            reason: thread ? "sender_mismatch" : "thread_missing",
            fromAddress,
            toAddress: recipientCandidates[0] || "",
            toAddresses,
            ccAddresses,
            subject,
            bodyText,
            bodyHtml,
            inboundMessageId: inboundMessageId || null,
            inReplyTo: inReplyTo || null,
            references: references || null,
            attachmentCount: Number(payload.attachmentCount || payload.attachments || 0),
            files: payload.files || [],
          });
          await receiptRef.create({ status: "unmatched", createdAt: admin.firestore.FieldValue.serverTimestamp() });
          res.status(200).send("OK");
          return;
        }
        receivingAddress = routedReceivingAddress(thread, recipientCandidates);
        if (!receivingAddress) {
          await storeUnmatched(db, admin, {
            receiptId: id,
            reason: "recipient_mismatch",
            fromAddress,
            toAddress: recipientCandidates[0] || "",
            toAddresses,
            ccAddresses,
            subject,
            bodyText,
            bodyHtml,
            inboundMessageId: inboundMessageId || null,
            inReplyTo: inReplyTo || null,
            references: references || null,
            attachmentCount: Number(payload.attachmentCount || payload.attachments || 0),
            files: payload.files || [],
          });
          await receiptRef.create({
            status: "unmatched",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          res.status(200).send("OK");
          return;
        }
      } else {
        recipientOwners = await resolveRecipientOwners(db, recipientCandidates);
        const owner = recipientOwners[0] || null;
        receivingAddress = owner?.address || "";
        if (!owner) {
          await storeUnmatched(db, admin, {
            receiptId: id,
            reason: "recipient_not_mapped",
            fromAddress,
            toAddress: recipientCandidates[0] || "",
            toAddresses,
            ccAddresses,
            subject,
            bodyText,
            bodyHtml,
            inboundMessageId: inboundMessageId || null,
            inReplyTo: inReplyTo || null,
            references: references || null,
            attachmentCount: Number(payload.attachmentCount || payload.attachments || 0),
            files: payload.files || [],
          });
          await receiptRef.create({
            status: "unmatched",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          res.status(200).send("OK");
          return;
        }

        const [ownerSnap, senderIdentity] = await Promise.all([
          owner.userRef.get(),
          resolveSenderIdentity(db, fromAddress),
        ]);
        const { personSnap, organizationSnap } = senderIdentity;
        const ownerData = ownerSnap.data() || {};
        const person = personSnap?.data() || {};
        const organization = organizationSnap?.data() || {};
        const linkedOrganizationRef =
          person.organizationRef || organizationSnap?.ref || null;
        const { viewerUids: teamViewerUids, teamRepIds } =
          await resolveInboundViewerUids(db, owner.uid, ownerData);
        const viewerUids = [...new Set([
          ...teamViewerUids,
          ...recipientOwners.map((recipientOwner) => recipientOwner.uid),
        ])];
        threadRef = db.collection(THREADS_COLLECTION).doc();
        thread = {
          subject: subject || "(No subject)",
          personRef: personSnap?.ref || null,
          personName: personSnap
            ? person.fullName || `${person.firstName || ""} ${person.lastName || ""}`.trim()
            : "",
          organizationRef: linkedOrganizationRef,
          organizationName: personSnap
            ? person.organizationName || ""
            : organization.organization || organization.name || "",
          organizationLinkSource: personSnap
            ? (linkedOrganizationRef ? "person" : null)
            : (organizationSnap ? "organization_only" : null),
          linkSource: personSnap ? "automatic" : null,
          autoLinkSuppressed: false,
          senderName: inboundSenderName,
          senderEmail: fromAddress,
          toAddress: fromAddress,
          participantAddresses: inboundParticipants,
          ownerUid: owner.uid,
          ownerRef: owner.userRef,
          ownerName: ownerData.fullName || ownerData.displayName || ownerData.email || "",
          senderAddress: receivingAddress,
          replyAddress: receivingAddress,
          viewerUids,
          teamRepIds,
          unreadBy: viewerUids,
          status: "active",
        };
      }

      const now = admin.firestore.FieldValue.serverTimestamp();
      const messageRef = threadRef.collection("emailMessages").doc();
      const storedAttachments = await storeAttachments({
        admin,
        files: Array.isArray(payload.files) ? payload.files : [],
        threadId: threadRef.id,
        messageId: messageRef.id,
        direction: "email_in",
      });
      const connectionRef = db.collection(CONNECTIONS_COLLECTION).doc();
      const batch = db.batch();

      if (route) {
        const unreadBy = Array.isArray(thread.viewerUids)
          ? thread.viewerUids
          : [thread.ownerUid].filter(Boolean);
        batch.update(threadRef, {
          participantAddresses: uniqueAddresses([
            ...threadParticipantAddresses(thread),
            ...inboundParticipants,
          ]),
          unreadBy,
          lastMessageAt: now,
          lastMessagePreview: bodyText.slice(0, 240),
          lastMessageDirection: "in",
          lastMessageStatus: "received",
          lastInboundMessageId: inboundMessageId || null,
          senderName: inboundSenderName,
          senderEmail: fromAddress,
          updatedAt: now,
        });
      } else {
        batch.create(threadRef, {
          ...thread,
          lastMessageAt: now,
          lastMessagePreview: bodyText.slice(0, 240),
          lastMessageDirection: "in",
          lastMessageStatus: "received",
          lastInboundMessageId: inboundMessageId || null,
          createdAt: now,
          updatedAt: now,
        });
      }

      batch.create(messageRef, {
        direction: "in",
        fromName: inboundSenderName,
        fromAddress,
        toAddress: receivingAddress,
        toAddresses,
        ccAddresses,
        subject: subject || thread.subject || "(No subject)",
        bodyText,
        bodyHtml,
        rawBodyText: preservedBodyText,
        rawBodyHtml: preservedBodyHtml,
        replyHistoryRemoved,
        attachments: storedAttachments.accepted,
        attachmentCount: storedAttachments.accepted.length,
        hasAttachments: storedAttachments.accepted.length > 0,
        rejectedAttachments: storedAttachments.rejected,
        rejectedAttachmentCount: storedAttachments.rejected.length,
        declaredAttachmentCount: Number(payload.attachmentCount || payload.attachments || 0),
        status: "received",
        providerMessageId: inboundMessageId || null,
        inReplyTo: inReplyTo || null,
        references: references || null,
        createdAt: now,
        receivedAt: now,
      });
      batch.create(receiptRef, {
        status: "stored",
        threadRef,
        messageRef,
        createdAt: now,
      });
      batch.create(connectionRef, {
        type: "email_in",
        ...(thread.leadRef ? { leadRef: thread.leadRef } : {}),
        summary: `Email received: ${subject || "(No subject)"}`,
        body: bodyText.slice(0, 240),
        personRef: thread.personRef || null,
        personName: clean(thread.personName),
        organizationRef: thread.organizationRef || null,
        organizationName: clean(thread.organizationName),
        recordType: thread.personRef ? "person" : (thread.organizationRef ? "organization" : "general"),
        recordName: clean(thread.personName) || clean(thread.organizationName) || inboundSenderName,
        threadRef,
        ownerRef: thread.ownerRef || null,
        ownerUid: thread.ownerUid || "",
        ownerName: thread.ownerName || "",
        createdByName: inboundSenderName,
        viewerUids: Array.isArray(thread.viewerUids) ? thread.viewerUids : [thread.ownerUid].filter(Boolean),
        teamRepIds: Array.isArray(thread.teamRepIds) ? thread.teamRepIds : [],
        createdAt: now,
      });
      await batch.commit();

      logger.info("COMMAND_EMAIL_INBOUND_STORED", {
        threadId: threadRef.id,
        messageId: messageRef.id,
        routedReply: Boolean(route),
        attachmentCount: storedAttachments.accepted.length,
        rejectedAttachmentCount: storedAttachments.rejected.length,
      });
      res.status(200).send("OK");
    } catch (error) {
      logger.error("COMMAND_EMAIL_INBOUND_ERROR", {
        message: String(error?.message || error),
      });
      res.status(500).send("Inbound email processing failed");
    }
  };
}

module.exports = {
  createReceiveCommandEmailService,
};

