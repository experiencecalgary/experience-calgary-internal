"use strict";

const admin = require("firebase-admin");
const { HttpsError } = require("firebase-functions/v2/https");
const {
  THREADS_COLLECTION,
  PEOPLE_COLLECTION,
  CONNECTIONS_COLLECTION,
  clean,
  displayName,
  requireEmailActor,
  canAccessOwnedRecord,
  assertThreadAccess,
} = require("./emailAccess");
const {
  buildThreadPersonLinkUpdate,
  buildConnectionPersonLinkUpdate,
} = require("./commandEmailThreadPersonLink");

function validId(value, fieldName) {
  const id = clean(value);
  if (!id || id.includes("/")) {
    throw new HttpsError("invalid-argument", `A valid ${fieldName} is required.`);
  }
  return id;
}

function createLinkCommandEmailThreadToPersonService() {
  return async function linkCommandEmailThreadToPersonService(request) {
    const db = admin.firestore();
    const actor = await requireEmailActor(db, request);
    const threadId = validId(request.data?.threadId, "threadId");
    const personId = validId(request.data?.personId, "personId");
    const threadRef = db.collection(THREADS_COLLECTION).doc(threadId);
    const personRef = db.collection(PEOPLE_COLLECTION).doc(personId);

    const [threadSnap, personSnap] = await Promise.all([
      threadRef.get(),
      personRef.get(),
    ]);
    if (!threadSnap.exists) {
      throw new HttpsError("not-found", "The email thread does not exist.");
    }
    if (!personSnap.exists || personSnap.data()?.archived === true) {
      throw new HttpsError("not-found", "The selected contact does not exist.");
    }

    const initialThread = threadSnap.data() || {};
    const initialPerson = personSnap.data() || {};
    assertThreadAccess(actor, initialThread);
    if (!(await canAccessOwnedRecord(db, actor, initialPerson))) {
      throw new HttpsError(
        "permission-denied",
        "You do not have access to the selected contact."
      );
    }
    if (initialThread.personRef && initialThread.personRef.path !== personRef.path) {
      throw new HttpsError(
        "failed-precondition",
        "This email thread is already linked to a different contact."
      );
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    const result = await db.runTransaction(async (transaction) => {
      const [currentThreadSnap, currentPersonSnap] = await Promise.all([
        transaction.get(threadRef),
        transaction.get(personRef),
      ]);
      if (!currentThreadSnap.exists) {
        throw new HttpsError("not-found", "The email thread does not exist.");
      }
      if (!currentPersonSnap.exists || currentPersonSnap.data()?.archived === true) {
        throw new HttpsError("not-found", "The selected contact does not exist.");
      }

      const current = currentThreadSnap.data() || {};
      const person = currentPersonSnap.data() || {};
      assertThreadAccess(actor, current);
      if (current.personRef && current.personRef.path !== personRef.path) {
        throw new HttpsError(
          "aborted",
          "This thread was linked by another user. Refresh and try again."
        );
      }

      const personName = displayName(person);
      transaction.update(
        threadRef,
        buildThreadPersonLinkUpdate({
          personRef,
          personName,
          organizationRef: person.organizationRef || null,
          organizationName: person.organizationName || "",
          actorRef: actor.userRef,
          timestamp: now,
        })
      );

      return {
        personName,
        organizationRef: person.organizationRef || null,
        organizationName: person.organizationName || "",
        senderEmail: clean(current.senderEmail || current.toAddress).toLowerCase(),
      };
    });

    const connections = await db
      .collection(CONNECTIONS_COLLECTION)
      .where("threadRef", "==", threadRef)
      .limit(450)
      .get();
    if (!connections.empty) {
      const batch = db.batch();
      for (const doc of connections.docs) {
        batch.update(
          doc.ref,
          buildConnectionPersonLinkUpdate({
            personRef,
            organizationRef: result.organizationRef,
          })
        );
      }
      await batch.commit();
    }

    return {
      ok: true,
      threadId,
      personId,
      personName: result.personName,
      organizationId: result.organizationRef?.id || null,
      senderEmail: result.senderEmail,
      senderEmailAdded: false,
    };
  };
}

module.exports = {
  createLinkCommandEmailThreadToPersonService,
};
