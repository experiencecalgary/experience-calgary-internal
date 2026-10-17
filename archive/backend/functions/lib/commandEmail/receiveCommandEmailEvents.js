"use strict";

const crypto = require("crypto");
const admin = require("firebase-admin");

const EVENTS_COLLECTION = "commandEmailEventReceipts";
const THREADS_COLLECTION = "commandEmailThreads";
const ALLOWED_EVENTS = new Set([
  "processed", "delivered", "deferred", "bounce", "dropped",
  "open", "click", "spamreport", "unsubscribe",
]);
const STATUS_RANK = {
  queued: 0,
  sent: 0,
  processed: 1,
  deferred: 1,
  delivered: 2,
  opened: 3,
  clicked: 4,
};

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function verifySignature(publicKeyValue, timestamp, signature, rawBody) {
  const publicKey = clean(publicKeyValue);
  const ts = clean(timestamp);
  const sig = clean(signature);
  if (!publicKey || !ts || !sig || !Buffer.isBuffer(rawBody)) return false;

  try {
    const key = publicKey.includes("BEGIN PUBLIC KEY")
      ? publicKey
      : crypto.createPublicKey({
          key: Buffer.from(publicKey, "base64"),
          format: "der",
          type: "spki",
        });
    const verifier = crypto.createVerify("SHA256");
    verifier.update(ts);
    verifier.update(rawBody);
    verifier.end();
    return verifier.verify(key, Buffer.from(sig, "base64"));
  } catch (_error) {
    return false;
  }
}

function eventTime(event) {
  const seconds = Number(event.timestamp);
  return Number.isFinite(seconds) && seconds > 0
    ? admin.firestore.Timestamp.fromMillis(seconds * 1000)
    : admin.firestore.Timestamp.now();
}

function eventId(event) {
  const supplied = clean(event.sg_event_id);
  if (supplied) return crypto.createHash("sha256").update(supplied).digest("hex");
  return crypto.createHash("sha256").update(JSON.stringify(event)).digest("hex");
}

function timestampMillis(value) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return 0;
}

function progressiveStatus(currentStatus, proposedStatus) {
  const current = clean(currentStatus).toLowerCase();
  const proposed = clean(proposedStatus).toLowerCase();
  const terminal = new Set(["bounced", "dropped", "spam_reported"]);
  if (terminal.has(proposed)) return proposed;
  if (terminal.has(current)) return current;
  return (STATUS_RANK[proposed] || 0) >= (STATUS_RANK[current] || 0)
    ? proposed
    : current;
}

function eventUpdate(event, occurredAt, current = {}) {
  const type = clean(event.event).toLowerCase();
  const update = {};
  if (timestampMillis(occurredAt) >= timestampMillis(current.lastEventAt)) {
    update.lastEventAt = occurredAt;
    update.lastEventType = type;
  }

  if (type === "processed") Object.assign(update, { processedAt: occurredAt });
  if (type === "delivered") Object.assign(update, { deliveredAt: occurredAt });
  if (type === "deferred") Object.assign(update, {
    deferredAt: occurredAt,
    deferredReason: clean(event.response || event.reason).slice(0, 1000),
  });
  if (type === "bounce") Object.assign(update, {
    bouncedAt: occurredAt,
    bounceReason: clean(event.reason || event.response).slice(0, 1000),
  });
  if (type === "dropped") Object.assign(update, {
    droppedAt: occurredAt,
    droppedReason: clean(event.reason || event.response).slice(0, 1000),
  });
  if (type === "spamreport") update.spamReportedAt = occurredAt;
  if (type === "unsubscribe") update.unsubscribedAt = occurredAt;
  if (type === "open") Object.assign(update, {
    lastOpenedAt: occurredAt,
    openCount: admin.firestore.FieldValue.increment(1),
  });
  if (type === "click") Object.assign(update, {
    lastClickedAt: occurredAt,
    clickCount: admin.firestore.FieldValue.increment(1),
    lastClickedUrl: clean(event.url).slice(0, 2000),
  });

  const proposedStatus = {
    processed: "processed",
    delivered: "delivered",
    deferred: "deferred",
    bounce: "bounced",
    dropped: "dropped",
    spamreport: "spam_reported",
    open: "opened",
    click: "clicked",
  }[type];
  if (proposedStatus) {
    update.deliveryStatus = progressiveStatus(current.deliveryStatus, proposedStatus);
  }

  // Engagement proves the message reached the recipient environment even when
  // SendGrid's separate delivered event is late or missing.
  if ((type === "open" || type === "click") && !current.deliveredAt) {
    update.deliveredAt = occurredAt;
    update.deliveryInferredFromEngagement = true;
  }
  if (type === "open" && !current.firstOpenedAt) update.firstOpenedAt = occurredAt;
  if (type === "click" && !current.firstClickedAt) update.firstClickedAt = occurredAt;
  return update;
}

function correlationValues(event) {
  return {
    threadId: clean(event?.commandThreadId || event?.commandthreadid),
    messageId: clean(event?.commandMessageId || event?.commandmessageid),
  };
}

function receiptData(event, occurredAt, status, reason, refs = {}) {
  return {
    status,
    reason: reason || null,
    eventType: clean(event?.event).toLowerCase(),
    threadRef: refs.threadRef || null,
    messageRef: refs.messageRef || null,
    commandThreadId: refs.threadId || null,
    commandMessageId: refs.messageId || null,
    providerMessageId: clean(event?.sg_message_id) || null,
    clickedUrl: clean(event?.url).slice(0, 2000) || null,
    occurredAt,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

function createReceiveCommandEmailEventsService({
  SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY,
  logger,
}) {
  return async function receiveCommandEmailEventsService(req, res) {
    if (req.method !== "POST") {
      res.set("Allow", "POST").status(405).send("Method Not Allowed");
      return;
    }

    const timestamp = req.get("X-Twilio-Email-Event-Webhook-Timestamp");
    const signature = req.get("X-Twilio-Email-Event-Webhook-Signature");
    if (!verifySignature(
      SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY.value(),
      timestamp,
      signature,
      req.rawBody
    )) {
      logger.warn("COMMAND_EMAIL_EVENT_UNAUTHORIZED");
      res.status(401).send("Unauthorized");
      return;
    }

    let events;
    try {
      events = JSON.parse(req.rawBody.toString("utf8"));
    } catch (_error) {
      res.status(400).send("Invalid JSON");
      return;
    }
    if (!Array.isArray(events)) {
      res.status(400).send("Expected an event array");
      return;
    }

    const db = admin.firestore();
    let stored = 0;
    let duplicates = 0;
    let unmatched = 0;
    let ignored = 0;

    for (const event of events.slice(0, 1000)) {
      const type = clean(event?.event).toLowerCase();
      if (!ALLOWED_EVENTS.has(type)) {
        ignored += 1;
        continue;
      }

      const occurredAt = eventTime(event);
      const receiptRef = db.collection(EVENTS_COLLECTION).doc(eventId(event));
      const existingReceipt = await receiptRef.get();
      if (existingReceipt.exists) {
        duplicates += 1;
        continue;
      }

      const { threadId, messageId } = correlationValues(event);
      const invalidCorrelation = !threadId || !messageId ||
        threadId.includes("/") || messageId.includes("/");
      if (invalidCorrelation) {
        await receiptRef.create(receiptData(
          event,
          occurredAt,
          "unmatched",
          "missing_or_invalid_custom_args",
          { threadId, messageId }
        ));
        logger.warn("COMMAND_EMAIL_EVENT_UNMATCHED", {
          type,
          providerMessageId: clean(event?.sg_message_id) || null,
          reason: "missing_or_invalid_custom_args",
        });
        unmatched += 1;
        continue;
      }

      const threadRef = db.collection(THREADS_COLLECTION).doc(threadId);
      const messageRef = threadRef.collection("emailMessages").doc(messageId);
      const result = await db.runTransaction(async (transaction) => {
        const [receiptSnap, messageSnap] = await Promise.all([
          transaction.get(receiptRef),
          transaction.get(messageRef),
        ]);
        if (receiptSnap.exists) return "duplicate";
        if (!messageSnap.exists) {
          transaction.create(receiptRef, receiptData(
            event,
            occurredAt,
            "unmatched",
            "message_not_found",
            { threadId, messageId }
          ));
          return "unmatched";
        }

        const current = messageSnap.data() || {};
        transaction.create(receiptRef, receiptData(
          event,
          occurredAt,
          "stored",
          null,
          { threadRef, messageRef, threadId, messageId }
        ));
        transaction.update(messageRef, eventUpdate(event, occurredAt, current));
        return "stored";
      });

      if (result === "stored") stored += 1;
      else if (result === "duplicate") duplicates += 1;
      else {
        logger.warn("COMMAND_EMAIL_EVENT_UNMATCHED", {
          type,
          threadId,
          messageId,
          providerMessageId: clean(event?.sg_message_id) || null,
          reason: "message_not_found",
        });
        unmatched += 1;
      }
    }

    logger.info("COMMAND_EMAIL_EVENTS_PROCESSED", {
      received: events.length,
      stored,
      duplicates,
      unmatched,
      ignored,
    });
    res.status(200).json({ ok: true, stored, duplicates, unmatched, ignored });
  };
}

module.exports = {
  createReceiveCommandEmailEventsService,
  eventUpdate,
  progressiveStatus,
};
