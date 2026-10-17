'use strict';

const admin = require('firebase-admin');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { requireAuth, requireCommandAccess, isPlatformAdminUser } = require('../../lib/command/commandPersonUtils');

const REGION = 'us-central1';
const clean = value => typeof value === 'string' ? value.trim() : '';
const displayName = data => clean(data?.fullName) ||
  [clean(data?.firstName), clean(data?.lastName)].filter(Boolean).join(' ') ||
  clean(data?.displayName) || clean(data?.name) || clean(data?.email);

function needsRepair(data) {
  const name = clean(data?.createdByName);
  return !name || name === 'Experience Command';
}

async function userActor(db, data) {
  const ref = data.createdByRef?.path
    ? data.createdByRef
    : clean(data.createdByUid)
      ? db.collection('users').doc(clean(data.createdByUid))
      : null;
  if (!ref) return null;
  const snap = await ref.get();
  if (!snap.exists) return null;
  const name = displayName(snap.data() || {});
  if (!name) return null;
  return { createdByRef: ref, createdByUid: ref.id, createdByName: name };
}

async function inboundEmailActor(data) {
  if (clean(data.type).toLowerCase() !== 'email_in') return null;
  const threadRef = data.threadRef?.path ? data.threadRef : null;
  const at = data.createdAt;
  if (!threadRef || !at?.toMillis) return null;

  const snap = await threadRef.collection('emailMessages')
    .where('createdAt', '<=', at)
    .orderBy('createdAt', 'desc')
    .limit(8)
    .get();
  const message = snap.docs.find(doc => clean(doc.data()?.direction).toLowerCase() === 'in');
  if (!message) return null;
  const row = message.data() || {};
  const name = clean(row.fromName) || clean(row.senderName) || clean(row.fromAddress) || clean(row.senderEmail);
  return name ? { createdByName: name } : null;
}

async function resolvedActor(db, data) {
  return await userActor(db, data) || await inboundEmailActor(data);
}

async function repairOne(db, ref, data) {
  if (!needsRepair(data)) return false;
  const actor = await resolvedActor(db, data);
  if (!actor?.createdByName) return false;
  await ref.set({ ...actor, actorRepairedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  return true;
}

const repairCommandConnectionActors = onCall(
  { region: REGION, cors: true, timeoutSeconds: 540, memory: '512MiB' },
  async request => {
    const db = admin.firestore();
    const uid = requireAuth(request);
    const actor = await requireCommandAccess(db, uid);
    if (!isPlatformAdminUser(actor.userData)) {
      throw new HttpsError('permission-denied', 'Platform Admin access is required.');
    }

    const pageToken = clean(request.data?.pageToken);
    let scanned = 0;
    let repaired = 0;
    let unresolved = 0;
    let last = null;
    let hasMore = false;

    do {
      let query = db.collection('commandConnections')
        .orderBy(admin.firestore.FieldPath.documentId())
        .limit(250);
      if (last) query = query.startAfter(last);
      else if (pageToken) query = query.startAfter(pageToken);

      const snap = await query.get();
      if (snap.empty) break;

      for (let i = 0; i < snap.docs.length; i += 25) {
        const group = snap.docs.slice(i, i + 25);
        const results = await Promise.all(group.map(async doc => {
          const data = doc.data() || {};
          if (!needsRepair(data)) return 'clean';
          return await repairOne(db, doc.ref, data) ? 'repaired' : 'unresolved';
        }));
        for (const result of results) {
          scanned += 1;
          if (result === 'repaired') repaired += 1;
          if (result === 'unresolved') unresolved += 1;
        }
      }

      last = snap.docs[snap.docs.length - 1];
      if (snap.size < 250) break;
      if (scanned >= 5000) {
        hasMore = true;
        break;
      }
    } while (true);

    return {
      ok: true,
      result: 'success',
      scanned,
      repaired,
      unresolved,
      hasMore,
      nextPageToken: hasMore && last ? last.id : '',
    };
  }
);

module.exports = {
  repairCommandConnectionActors,
  _test: { displayName, needsRepair },
};
