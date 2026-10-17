'use strict';
const admin = require('firebase-admin');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { commandActorContext } = require('../../lib/command/commandReportingUtils');
const { isPlatformAdminUser } = require('../../lib/command/commandPersonUtils');
const { refreshNextAction } = require('../../lib/command/commandLeadWorkspace');
const { SNAPSHOTS } = require('../../lib/command/commandLeadFlowBoard');

async function repair(request, deps = {}) {
  const ctx = await (deps.context || commandActorContext)(request);
  if (!isPlatformAdminUser(ctx.actor.userData) || ctx.actor.userData.active === false)
    throw new HttpsError('permission-denied', 'Only active platform administrators can repair Lead summaries.');
  const after = ctx.input.afterId || '';
  if (typeof after !== 'string' || after.length > 1500 || after.includes('/')) throw new HttpsError('invalid-argument', 'Invalid continuation.');
  let q = ctx.db.collection('commandLeads').orderBy(admin.firestore.FieldPath.documentId()).limit(21);
  if (after) q = q.startAfter(after);
  const snap = await q.get(), docs = snap.docs.slice(0, 20), incomplete = [];
  for (const doc of docs) {
    await refreshNextAction(ctx.db, doc.ref);
    if ((await doc.ref.get()).data()?.nextActionResolutionIncomplete) incomplete.push(doc.ref.path);
  }
  return { ok: true, processed: docs.length, incompleteLeadPaths: incomplete, hasMore: snap.size > 20,
    afterId: snap.size > 20 ? docs[docs.length - 1].id : '', stageAgesBackfilled: false };
}
async function initialize(event, deps = {}) {
  if (!event.data?.ref) return;
  await refreshNextAction(deps.db || admin.firestore(), event.data.ref);
}
async function cleanup(_event, deps = {}) {
  const db = deps.db || admin.firestore();
  const snap = await db.collection(SNAPSHOTS).where('expiresAt', '<', admin.firestore.Timestamp.now()).limit(100).get();
  if (!snap.size) return;
  const batch = db.batch(); for (const doc of snap.docs) batch.delete(doc.ref); await batch.commit();
}
exports.repairCommandLeadFlowSummaries = onCall({ region: 'us-central1', timeoutSeconds: 120 }, repair);
exports.commandLeadFlowInitialize = onDocumentCreated({ region: 'us-central1', document: 'commandLeads/{leadId}', retry: true }, initialize);
exports.cleanupCommandLeadFlowSnapshots = onSchedule({ region: 'us-central1', schedule: 'every 15 minutes', timeoutSeconds: 120 }, cleanup);
exports._test = { repair, initialize, cleanup };
