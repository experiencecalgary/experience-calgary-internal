"use strict";

const admin = require("firebase-admin");
const { HttpsError } = require("firebase-functions/v2/https");
const {
  THREADS_COLLECTION,
  clean,
  unique,
  requireEmailActor,
  assertThreadAccess,
} = require("./emailAccess");

function createMarkCommandEmailThreadUnreadService() {
  return async function markCommandEmailThreadUnreadService(request) {
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

      const thread = snapshot.data() || {};
      assertThreadAccess(actor, thread);

      const viewerUids = unique([
        ...(Array.isArray(thread.viewerUids) ? thread.viewerUids : []),
        thread.ownerUid,
      ]);

      if (viewerUids.length === 0) {
        throw new HttpsError(
          "failed-precondition",
          "The email thread has no authorized viewers."
        );
      }

      transaction.update(threadRef, {
        // Unread status is shared by the authorized team, so restoring it must
        // include every viewer rather than only the person who clicked.
        unreadBy: viewerUids,
        readAt: admin.firestore.FieldValue.delete(),
        readByUid: admin.firestore.FieldValue.delete(),
        markedUnreadAt: admin.firestore.FieldValue.serverTimestamp(),
        markedUnreadByUid: actor.uid,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    return { ok: true, threadId };
  };
}

module.exports = {
  createMarkCommandEmailThreadUnreadService,
};
