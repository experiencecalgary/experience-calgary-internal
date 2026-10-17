'use strict';

const admin = require('firebase-admin');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onCall } = require('firebase-functions/v2/https');
const { requireAuth, requireCommandAccess } = require('../../lib/command/commandPersonUtils');
const {
  buildCommandAccessMetadata,
  accessMetadataNeedsUpdate,
  accessUpdatePayload,
} = require('../../lib/command/commandAccessMetadata');

const COLLECTIONS = [
  'commandPeople',
  'commandOrganizations',
  'commandLeads',
  'commandActions',
  'commandConnections',
];

async function syncSnapshot(snapshot) {
  if (!snapshot?.exists) return;
  const data = snapshot.data() || {};
  const db = admin.firestore();
  const access = await buildCommandAccessMetadata(db, {
    actorRef: data.createdByRef || data.updatedByRef || null,
    ownerRef: data.ownerRef || data.createdByRef || null,
    assignedToRef: data.assignedToRef || null,
  });
  if (!accessMetadataNeedsUpdate(data, access)) return;
  await snapshot.ref.update(accessUpdatePayload(access));
}

function triggerFor(collection) {
  return onDocumentWritten(
    { region: 'us-central1', document: `${collection}/{recordId}` },
    async event => syncSnapshot(event.data?.after)
  );
}

exports.commandPersonAccessSync = triggerFor('commandPeople');
exports.commandOrganizationAccessSync = triggerFor('commandOrganizations');
// Both delayed events and manual repair must reconcile the current Lead.
async function syncCurrentLeadAccess(db, ref) {
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const data = snap.data();
    const access = await buildCommandAccessMetadata(db, {
      actorRef: data.createdByRef || data.updatedByRef || null,
      ownerRef: data.ownerRef || data.createdByRef || null,
      assignedToRef: data.assignedToRef || null,
    });
    if (!accessMetadataNeedsUpdate(data, access)) return false;
    tx.update(ref, accessUpdatePayload(access));
    return true;
  });
}
exports.commandLeadAccessSync = onDocumentWritten(
  { region: 'us-central1', document: 'commandLeads/{recordId}', retry: true },
  async event => {
    const ref = event.data?.after?.ref;
    if (ref) await syncCurrentLeadAccess(admin.firestore(), ref);
  }
);
exports.commandActionAccessSync = triggerFor('commandActions');
exports.commandConnectionAccessSync = triggerFor('commandConnections');

exports.repairCommandRecordAccess = onCall(
  { region: 'us-central1', cors: true },
  async request => {
    const db = admin.firestore();
    const uid = requireAuth(request);
    await requireCommandAccess(db, uid);
    let repaired = 0;
    const counts = {};
    for (const collection of COLLECTIONS) {
      const snap = await db.collection(collection).limit(1000).get();
      let count = 0;
      for (const doc of snap.docs) {
        if (collection === 'commandLeads') {
          if (await syncCurrentLeadAccess(db, doc.ref)) { count += 1; repaired += 1; }
          continue;
        }
        const before = doc.data() || {};
        const access = await buildCommandAccessMetadata(db, {
          actorRef: before.createdByRef || before.updatedByRef || null,
          ownerRef: before.ownerRef || before.createdByRef || null,
          assignedToRef: before.assignedToRef || null,
        });
        if (!accessMetadataNeedsUpdate(before, access)) continue;
        await doc.ref.update(accessUpdatePayload(access));
        count += 1;
        repaired += 1;
      }
      counts[collection] = count;
    }
    return { ok: true, repaired, counts };
  }
);



exports._test = { syncCurrentLeadAccess };
