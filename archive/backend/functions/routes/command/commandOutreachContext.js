'use strict';

const admin = require('firebase-admin');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { commandActorContext } = require('../../lib/command/commandReportingUtils');
const { clean, refPath, iso, visible, readLead, readContacts, contactFields, restricted } = require('../../lib/command/commandOutreachSupport');
const callable = handler => onCall({ region: 'us-central1', cors: true, timeoutSeconds: 60 }, handler);
function serialize(doc, fields) {
  const data = doc.data();
  const result = { refPath: doc.ref.path, updatedAt: iso(data.updatedAt) };
  for (const field of fields) result[field] = clean(data[field]);
  return result;
}
async function contextService(request, deps = {}) {
  const ctx = await (deps.context || commandActorContext)(request);
  const lead = await readLead(ctx, ctx.input.leadRefPath, false);
  const contacts = await readContacts(ctx, lead.data);
  const [history, actions, slot] = await Promise.all([
    ctx.db.collection('commandConnections').where('leadRef', '==', lead.ref).orderBy('createdAt', 'desc').limit(30).get(),
    ctx.db.collection('commandActions').where('leadRef', '==', lead.ref).where('status', '==', 'open').limit(101).get(),
    ctx.db.doc(`commandActivityRequests/${ctx.uid}_active_call_${lead.ref.id}`).get(),
  ]);
  let pending = null;
  if (slot.exists && slot.data().callRef) {
    const doc = await slot.data().callRef.get();
    if (doc.exists && doc.data().createdByUid === ctx.uid && doc.data().status === 'in_progress') pending = {
      callRefPath: doc.ref.path, contactRefPath: refPath(doc.data().contactRef), dialedPhone: clean(doc.data().dialedPhone),
      startedAt: iso(doc.data().callStartedAt), endedAt: iso(doc.data().callEndedAt),
    };
  }
  const organization = contacts.find(d => d.ref.path === refPath(lead.data.subjectOrganizationRef));
  const personRestricted = contacts.blockBusinessFallback;
  return { ok: true, lead: { refPath: lead.ref.path, updatedAt: iso(lead.data.updatedAt), name: clean(lead.data.displayName),
      leadType: clean(lead.data.leadType), assignedToName: clean(lead.data.assignedToName), assignedToRefPath: refPath(lead.data.assignedToRef), organizationRefPath: refPath(lead.data.subjectOrganizationRef), stage: clean(lead.data.stage), status: clean(lead.data.status), source: clean(lead.data.source), leadListId: clean(lead.data.leadListId), leadListName: clean(lead.data.leadListName),
      notes: clean(lead.data.notes), opportunityDetails: clean(lead.data.opportunityDetails), primaryContactRefPath: refPath(lead.data.primaryContactRef),
      lastCallAt: iso(lead.data.lastCallAt), lastCallOutcome: clean(lead.data.lastCallOutcome), callAttemptCount: Number(lead.data.callAttemptCount) || 0,
      doNotCall: restricted(lead.data), nextActionRefPath: refPath(lead.data.nextActionRef) },
    organization: organization ? serialize(organization, ['organization', 'website', 'phone', 'email', 'industry', 'address', 'city', 'province', 'postalCode', 'notes']) : null,
    contacts: contacts.map(doc => ({ ...contactFields(doc, lead.data),
      ...(doc.ref.path.startsWith('commandOrganizations/') && personRestricted ? { canCall: false } : {}),
      ...serialize(doc, ['firstName', 'lastName', 'notes']) })),
    history: history.docs.filter(d => visible(ctx.uid, ctx.actor.userData, d.data())).map(doc => ({ refPath: doc.ref.path,
      type: clean(doc.data().eventType || doc.data().type), summary: clean(doc.data().summary), notes: clean(doc.data().body || doc.data().details?.notes),
      outcome: clean(doc.data().outcome || doc.data().details?.outcome), createdAt: iso(doc.data().createdAt), repName: clean(doc.data().createdByName),
      contactName: clean(doc.data().contactName || doc.data().personName), dialedPhone: clean(doc.data().dialedPhone) })),
    openActions: actions.docs.filter(d => visible(ctx.uid, ctx.actor.userData, d.data())).slice(0, 100).map(doc => ({ refPath: doc.ref.path,
      title: clean(doc.data().title), description: clean(doc.data().description), type: clean(doc.data().actionType), dueAt: iso(doc.data().dueAt),
      startAt: iso(doc.data().startAt), meetingStatus: clean(doc.data().meetingStatus) })),
    moreActionsAvailable: actions.size > 100, pendingCall: pending,
    editEndpoints: { person: 'updateCommandPerson', organization: 'updateCommandOrganization', lead: 'updateCommandLead' },
  };
}
async function progressService(request, deps = {}) {
  const ctx = await (deps.context || commandActorContext)(request);
  const id = clean(ctx.input.queueId);
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new HttpsError('invalid-argument', 'Invalid queue ID.');
  const ref = ctx.db.doc(`commandOutreachQueues/${id}`);
  return ctx.db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data().uid !== ctx.uid) throw new HttpsError('permission-denied', 'Queue not found for your account.');
    const queue = snap.data();
    if (queue.expiresAt.toMillis() <= Date.now()) throw new HttpsError('failed-precondition', 'This queue expired.');
    const revision = Number(queue.revision) || 0;
    if (ctx.input.readOnly === true) return { ok: true, revision, filterOptions: queue.filterOptions || {}, progress: queue.progress || {}, currentLeadRefPath: queue.currentLeadRefPath || '' };
    if (ctx.input.expectedRevision !== revision) throw new HttpsError('aborted', 'Queue progress changed. Reload it before saving.');
    const current = clean(ctx.input.currentLeadRefPath);
    if (current && !queue.paths.includes(current)) throw new HttpsError('invalid-argument', 'Lead is not in this queue.');
    const progress = { ...(queue.progress || {}) };
    const path = clean(ctx.input.leadRefPath), state = clean(ctx.input.state);
    if (path) {
      if (!queue.paths.includes(path) || !['worked', 'skipped', 'pending'].includes(state)) throw new HttpsError('invalid-argument', 'Choose a queue Lead and valid progress state.');
      progress[path] = state;
    }
    tx.update(ref, { progress, currentLeadRefPath: current, revision: revision + 1 });
    return { ok: true, revision: revision + 1, progress, currentLeadRefPath: current };
  });
}
exports.getCommandOutreachContext = callable(contextService);
exports.saveCommandOutreachProgress = callable(progressService);
// Server-only, short-lived queues. No client Firestore rules or permanent PII cache needed.
exports.cleanupCommandOutreachQueues = onSchedule({ schedule: 'every 24 hours', region: 'us-central1' }, async () => {
  const db = admin.firestore();
  for (let page = 0; page < 20; page++) {
    const snap = await db.collection('commandOutreachQueues').where('expiresAt', '<', admin.firestore.Timestamp.now()).limit(400).get();
    if (snap.empty) return;
    const batch = db.batch(); for (const doc of snap.docs) batch.delete(doc.ref); await batch.commit();
    if (snap.size < 400) return;
  }
});
exports._test = { contextService, progressService };
