"use strict";

const admin = require("firebase-admin");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const {
  requireEmailActor,
  assertThreadAccess,
  displayName,
} = require("./emailAccess");
const { recordEmails } = require("../command/commandEmailIdentity");

const PEOPLE = "commandPeople";
const THREADS = "commandEmailThreads";
const CONNECTIONS = "commandConnections";
const PAGE_SIZE = 200;

function sameRef(left, right) {
  return Boolean(left && right && left.path === right.path);
}

function organizationFields(person = {}) {
  return {
    organizationRef: person.organizationRef || null,
    organizationName: person.organizationName || "",
  };
}

async function updateConnectionsForThread(db, threadRef, fields) {
  const snapshot = await db.collection(CONNECTIONS)
    .where("threadRef", "==", threadRef)
    .limit(450)
    .get();
  if (snapshot.empty) return 0;
  const batch = db.batch();
  snapshot.docs.forEach((doc) => batch.update(doc.ref, fields));
  await batch.commit();
  return snapshot.size;
}

async function reconcilePersonThreads(db, personRef, person, options = {}) {
  if (!person || person.archived === true) return { linked: 0, synchronized: 0 };

  const emails = recordEmails(person);
  const matched = new Map();
  for (const email of emails) {
    const [inbound, outbound] = await Promise.all([
      db.collection(THREADS).where("senderEmail", "==", email).limit(450).get(),
      db.collection(THREADS).where("toAddress", "==", email).limit(450).get(),
    ]);
    [...inbound.docs, ...outbound.docs]
      .forEach((doc) => matched.set(doc.ref.path, doc));
  }

  const alreadyLinked = await db.collection(THREADS)
    .where("personRef", "==", personRef)
    .limit(450)
    .get();
  alreadyLinked.docs.forEach((doc) => matched.set(doc.ref.path, doc));

  let linked = 0;
  let synchronized = 0;
  const now = admin.firestore.FieldValue.serverTimestamp();
  const inherited = organizationFields(person);

  for (const doc of matched.values()) {
    const thread = doc.data() || {};
    const isLinkedPerson = sameRef(thread.personRef, personRef);
    const mayAutoLink = !thread.personRef &&
      thread.autoLinkSuppressed !== true &&
      emails.includes(String(thread.senderEmail || thread.toAddress || "").trim().toLowerCase());

    if (!isLinkedPerson && !mayAutoLink) continue;

    const update = {
      personRef,
      personName: displayName(person),
      ...inherited,
      organizationLinkSource: inherited.organizationRef ? "person" : null,
      updatedAt: now,
    };
    if (mayAutoLink) {
      update.linkSource = "automatic";
      update.linkedAt = now;
      update.linkedByRef = null;
      update.autoLinkSuppressed = false;
      linked += 1;
    } else {
      synchronized += 1;
    }
    await doc.ref.update(update);
    await updateConnectionsForThread(db, doc.ref, {
      personRef,
      ...inherited,
    });
  }

  return { linked, synchronized };
}

const commandPersonEmailRelationshipSync = onDocumentWritten(
  {
    document: "commandPeople/{personId}",
    region: "us-central1",
    timeoutSeconds: 540,
    memory: "512MiB",
  },
  async (event) => {
    const after = event.data?.after;
    if (!after?.exists) return;
    const person = after.data() || {};
    await reconcilePersonThreads(admin.firestore(), after.ref, person);
  }
);

const backfillCommandEmailRelationships = onCall(
  {
    region: "us-central1",
    cors: true,
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async (request) => {
    const db = admin.firestore();
    const actor = await requireEmailActor(db, request);
    if (actor.userData.role !== "platform_admin") {
      throw new HttpsError("permission-denied", "Platform administrator access is required.");
    }

    const cursor = typeof request.data?.cursor === "string"
      ? request.data.cursor.trim()
      : "";
    let query = db.collection(PEOPLE)
      .where("archived", "==", false)
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);

    const snapshot = await query.get();
    let linked = 0;
    let synchronized = 0;
    for (const personDoc of snapshot.docs) {
      const result = await reconcilePersonThreads(db, personDoc.ref, personDoc.data() || {});
      linked += result.linked;
      synchronized += result.synchronized;
    }

    return {
      ok: true,
      processed: snapshot.size,
      linked,
      synchronized,
      nextCursor: snapshot.size === PAGE_SIZE
        ? snapshot.docs[snapshot.docs.length - 1].id
        : null,
      done: snapshot.size < PAGE_SIZE,
    };
  }
);

const backfillCommandEmailRelationshipsScheduled = onSchedule(
  {
    region: "us-central1",
    schedule: "every 30 minutes",
    timeZone: "America/Edmonton",
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async () => {
    const db = admin.firestore();
    const stateRef = db.collection("commandMaintenance")
      .doc("exmailPersonRelationshipBackfillV1");
    const stateSnap = await stateRef.get();
    const state = stateSnap.exists ? stateSnap.data() || {} : {};
    if (state.completed === true) return;

    let query = db.collection(PEOPLE)
      .where("archived", "==", false)
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(PAGE_SIZE);
    if (state.cursor) query = query.startAfter(String(state.cursor));

    const snapshot = await query.get();
    let linked = 0;
    let synchronized = 0;
    for (const personDoc of snapshot.docs) {
      const result = await reconcilePersonThreads(db, personDoc.ref, personDoc.data() || {});
      linked += result.linked;
      synchronized += result.synchronized;
    }

    const done = snapshot.size < PAGE_SIZE;
    await stateRef.set({
      cursor: done || snapshot.empty
        ? null
        : snapshot.docs[snapshot.docs.length - 1].id,
      completed: done,
      lastProcessed: snapshot.size,
      totalLinked: Number(state.totalLinked || 0) + linked,
      totalSynchronized: Number(state.totalSynchronized || 0) + synchronized,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      completedAt: done ? admin.firestore.FieldValue.serverTimestamp() : null,
    }, { merge: true });
  }
);

const unlinkCommandEmailThreadFromPerson = onCall(
  {
    region: "us-central1",
    cors: true,
    timeoutSeconds: 120,
    memory: "256MiB",
  },
  async (request) => {
    const db = admin.firestore();
    const actor = await requireEmailActor(db, request);
    const threadId = typeof request.data?.threadId === "string"
      ? request.data.threadId.trim()
      : "";
    if (!threadId || threadId.includes("/")) {
      throw new HttpsError("invalid-argument", "A valid threadId is required.");
    }

    const threadRef = db.collection(THREADS).doc(threadId);
    const snapshot = await threadRef.get();
    if (!snapshot.exists) throw new HttpsError("not-found", "The email thread does not exist.");
    const thread = snapshot.data() || {};
    assertThreadAccess(actor, thread);

    const now = admin.firestore.FieldValue.serverTimestamp();
    await threadRef.update({
      personRef: null,
      personName: "",
      organizationRef: null,
      organizationName: "",
      organizationLinkSource: null,
      linkSource: "manual_unlink",
      linkedAt: null,
      linkedByRef: actor.userRef,
      autoLinkSuppressed: true,
      autoLinkSuppressedAt: now,
      autoLinkSuppressedByRef: actor.userRef,
      updatedAt: now,
    });
    await updateConnectionsForThread(db, threadRef, {
      personRef: null,
      organizationRef: null,
    });

    return { ok: true, threadId, unlinked: true };
  }
);

module.exports = {
  reconcilePersonThreads,
  commandPersonEmailRelationshipSync,
  backfillCommandEmailRelationships,
  backfillCommandEmailRelationshipsScheduled,
  unlinkCommandEmailThreadFromPerson,
};
