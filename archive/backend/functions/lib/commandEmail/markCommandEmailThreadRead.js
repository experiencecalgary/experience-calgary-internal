"use strict";

const admin = require("firebase-admin");
const { HttpsError } = require("firebase-functions/v2/https");
const {
  THREADS_COLLECTION,
  clean,
  requireEmailActor,
  assertThreadAccess,
} = require("./emailAccess");

function createMarkCommandEmailThreadReadService() {
  return async function markCommandEmailThreadReadService(request) {
    const db = admin.firestore();
    const actor = await requireEmailActor(db, request);
    const threadId = clean(request.data?.threadId);

    if (!threadId || threadId.includes("/")) {
      throw new HttpsError("invalid-argument", "A valid threadId is required.");
    }

    const threadRef = db.collection(THREADS_COLLECTION).doc(threadId);
    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(threadRef);
      if (!snapshot.exists) {
        throw new HttpsError("not-found", "The email thread does not exist.");
      }

      assertThreadAccess(actor, snapshot.data() || {});
      transaction.update(threadRef, {
        // Read status is shared by the authorized team. Once any viewer reviews
        // the thread, it is no longer unread for anyone.
        unreadBy: [],
        readAt: admin.firestore.FieldValue.serverTimestamp(),
        readByUid: actor.uid,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    return { ok: true, threadId };
  };
}

module.exports = {
  createMarkCommandEmailThreadReadService,
};
