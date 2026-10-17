'use strict';

const admin = require('firebase-admin');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { requireAuth, requireCommandAccess, isPlatformAdminUser } = require('../../lib/command/commandPersonUtils');
const { buildCommandAccessMetadata } = require('../../lib/command/commandAccessMetadata');

const ACTIVE_STAGES = ['New', 'Opened', 'Engaged', 'Closing'];
const LEADS_COLLECTION = 'commandLeads';
const FINAL_STAGES = ['Won', 'Lost'];
const DEFINITIONS = {
  person: { collection: 'commandPeople', relation: 'personRef', name: d => clean(d.fullName) || [clean(d.firstName), clean(d.lastName)].filter(Boolean).join(' ') },
  organization: { collection: 'commandOrganizations', relation: 'organizationRef', name: d => clean(d.organization) || clean(d.name) },
};
const clean = value => typeof value === 'string' ? value.trim() : '';
const unique = values => [...new Set((values || []).filter(Boolean))];
const serialize = value => value?.toDate ? value.toDate().toISOString() : (value?.path || value || null);
const actorName = actor => clean(actor?.userData?.fullName) ||
  [clean(actor?.userData?.firstName), clean(actor?.userData?.lastName)].filter(Boolean).join(' ') ||
  clean(actor?.userData?.displayName) || clean(actor?.userData?.name) ||
  clean(actor?.userData?.email) || 'Experience Command';
const ACTIVITY_GROUPS = {
  emails: new Set(['email_in', 'email_out']),
  calls: new Set(['call']),
  actions: new Set(['action_created', 'action_updated', 'action_completed', 'action_cancelled']),
  meetings: new Set(['meeting_scheduled', 'meeting_rescheduled', 'meeting_cancelled', 'meeting_held', 'meeting_no_show']),
  flow: new Set(['stage_change', 'flow_won', 'flow_lost', 'flow_reopened']),
  notes: new Set(['note']),
};
function parseOptionalDate(value, field) {
  if (value === undefined || value === null || value === '') return null;
  try { return toTimestamp(value, field); }
  catch (_) { throw new HttpsError('invalid-argument', `${field} must be a valid date and time.`); }
}
function encodeConnectionCursor(doc) {
  const createdAt = doc.data()?.createdAt;
  if (!createdAt?.toMillis) return '';
  return Buffer.from(JSON.stringify({ createdAt: createdAt.toMillis(), id: doc.id })).toString('base64url');
}
function decodeConnectionCursor(value) {
  const raw = clean(value);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!Number.isFinite(parsed.createdAt) || !clean(parsed.id)) throw new Error('invalid');
    return { createdAt: admin.firestore.Timestamp.fromMillis(parsed.createdAt), id: clean(parsed.id) };
  } catch (_) {
    throw new HttpsError('invalid-argument', 'pageToken is invalid.');
  }
}
const callable = handler => onCall({ region: 'us-central1', cors: true, timeoutSeconds: 120, memory: '512MiB' }, handler);

function normalizeType(value) {
  const aliases = {
    person: 'person',
    people: 'person',
    organization: 'organization',
    organizations: 'organization',
  };
  const type = aliases[clean(value).toLowerCase()];
  if (!type) throw new HttpsError('invalid-argument', 'recordType must be person or organization.');
  return type;
}

function refPath(value, collection, name) {
  const parts = clean(value).split('/').filter(Boolean);
  if (parts.length !== 2 || parts[0] !== collection) throw new HttpsError('invalid-argument', `${name} must use ${collection}/{documentId}.`);
  return parts.join('/');
}

function toTimestamp(value, name) {
  if (value instanceof admin.firestore.Timestamp) return value;
  if (value && Number.isFinite(value.seconds)) return new admin.firestore.Timestamp(value.seconds, Number(value.nanoseconds) || 0);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new HttpsError('invalid-argument', `${name} must be a valid date and time.`);
  return admin.firestore.Timestamp.fromDate(date);
}

function dateKey(value) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Edmonton', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value.toDate()).filter(part => part.type !== 'literal');
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

async function context(request) {
  const db = admin.firestore();
  const uid = requireAuth(request);
  const actor = await requireCommandAccess(db, uid);
  return { db, uid, actor, input: request.data || {} };
}

function visible(ctx, data) {
  if (isPlatformAdminUser(ctx.actor.userData)) return true;
  const repId = clean(ctx.actor.userData.repId);
  return data.ownerUid === ctx.uid || data.assignedToUid === ctx.uid ||
    (Array.isArray(data.viewerUids) && data.viewerUids.includes(ctx.uid)) ||
    (repId && Array.isArray(data.teamRepIds) && data.teamRepIds.map(String).includes(repId));
}

async function record(ctx, requireOpen = false) {
  const type = normalizeType(ctx.input.recordType);
  const definition = DEFINITIONS[type];
  const path = refPath(ctx.input.recordRefPath, definition.collection, 'recordRefPath');
  const ref = ctx.db.doc(path); const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Command record not found.');
  const data = snap.data() || {};
  if (!visible(ctx, data)) throw new HttpsError('permission-denied', 'You do not have access to this record.');
  if (requireOpen && FINAL_STAGES.includes(clean(data.stage))) throw new HttpsError('failed-precondition', 'Closed records must be reopened before they can change active stage.');
  return { type, definition, ref, data };
}

async function readLead(ctx, target) {
  const rawPath = clean(ctx.input.leadRefPath);
  if (!rawPath) return null;
  const path = refPath(rawPath, LEADS_COLLECTION, 'leadRefPath');
  const ref = ctx.db.doc(path); const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Lead not found.');
  const data = snap.data() || {};
  if (!visible(ctx, data)) throw new HttpsError('permission-denied', 'You do not have access to this Lead.');
  if (data.archived === true || clean(data.status) !== 'active') throw new HttpsError('failed-precondition', 'Calls can be logged only against an active Lead.');
  if (target.type === 'person') {
    const people = [data.subjectPersonRef, data.primaryContactRef, ...(data.connectedPersonRefs || [])];
    if (!people.some(candidate => candidate?.path === target.ref.path)) throw new HttpsError('failed-precondition', 'The selected Person is not connected to this Lead.');
  } else if (data.subjectOrganizationRef?.path !== target.ref.path) {
    throw new HttpsError('failed-precondition', 'The selected Organization does not match this Lead.');
  }
  return { ref, data };
}

function connectionPayload(ctx, target, type, summary, details, key, lead = null) {
  const accessData = lead?.data || target.data;
  const personName = target.type === 'person'
    ? target.definition.name(target.data)
    : clean(target.data.personName);
  const organizationName = target.type === 'organization'
    ? target.definition.name(target.data)
    : clean(target.data.organizationName);
  return {
    type, summary, body: clean(details?.notes || details?.details), details: details || {},
    deduplicationKey: key,
    ...(lead?.ref ? { leadRef: lead.ref } : (target.data.leadRef ? { leadRef: target.data.leadRef } : {})),
    [target.definition.relation]: target.ref,
    personRef: target.type === 'person' ? target.ref : null,
    personName,
    organizationRef: target.type === 'organization' ? target.ref : (target.data.organizationRef || null),
    organizationName,
    recordType: target.type,
    recordName: target.definition.name(target.data),
    ownerRef: accessData.ownerRef || ctx.actor.userRef, ownerUid: accessData.ownerUid || ctx.uid,
    ownerName: accessData.ownerName || '', teamRepIds: accessData.teamRepIds || [],
    viewerUids: unique([...(accessData.viewerUids || []), ctx.uid]),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    createdByRef: ctx.actor.userRef, createdByUid: ctx.uid, createdByName: actorName(ctx.actor),
  };
}

async function createFollowUp(ctx, target, sourceField, sourceRef, batch = null, lead = null) {
  if (!ctx.input.createFollowUp) return '';
  const dueAt = toTimestamp(ctx.input.followUpDueAt, 'followUpDueAt');
  const accessData = lead?.data || target.data;
  const assignedRef = ctx.input.followUpAssignedToRefPath ? ctx.db.doc(refPath(ctx.input.followUpAssignedToRefPath, 'users', 'followUpAssignedToRefPath')) : (accessData.assignedToRef || ctx.actor.userRef);
  const access = await buildCommandAccessMetadata(ctx.db, { actorRef: ctx.actor.userRef, ownerRef: accessData.ownerRef || ctx.actor.userRef, assignedToRef: assignedRef });
  const ref = ctx.db.collection('commandActions').doc(); const now = admin.firestore.FieldValue.serverTimestamp();
  const payload = {
    title: clean(ctx.input.followUpTitle) || `Follow up with ${target.definition.name(target.data)}`,
    description: clean(ctx.input.followUpDescription), actionType: clean(ctx.input.followUpType) || 'Follow-up', priority: clean(ctx.input.followUpPriority) || 'Medium', status: 'open',
    dueAt, dueDateKey: dateKey(dueAt), relatedType: target.type === 'person' ? 'Person' : 'Organization',
    personRef: target.type === 'person' ? target.ref : null, personName: target.type === 'person' ? target.definition.name(target.data) : '',
    organizationRef: target.type === 'organization' ? target.ref : (target.data.organizationRef || null), organizationName: target.type === 'organization' ? target.definition.name(target.data) : clean(target.data.organizationName),
    ...(lead?.ref ? { leadRef: lead.ref } : (target.data.leadRef ? { leadRef: target.data.leadRef } : {})),
    ...access, createdAt: now, updatedAt: now, createdByRef: ctx.actor.userRef, createdByUid: ctx.uid, createdByName: actorName(ctx.actor), updatedByRef: ctx.actor.userRef, [sourceField]: sourceRef || null,
  };
  if (batch) batch.create(ref, payload);
  else await ref.create(payload);
  return ref.path;
}

async function logCommandCallOutcomeService(request) {
  const ctx = await context(request); const target = await record(ctx, false); const lead = await readLead(ctx, target);
  if (!lead && FINAL_STAGES.includes(clean(target.data.stage))) throw new HttpsError('failed-precondition', 'Closed records must be reopened before a Call can be logged.');
  const outcome = clean(ctx.input.outcome).toLowerCase(); const notes = clean(ctx.input.notes);
  const allowed = ['connected', 'voicemail', 'no_answer', 'wrong_number', 'not_interested'];
  if (!allowed.includes(outcome)) throw new HttpsError('invalid-argument', `outcome must be one of: ${allowed.join(', ')}.`);
  if (!notes) throw new HttpsError('invalid-argument', 'Call notes are required.');
  const requestId = clean(ctx.input.clientRequestId);
  if (!requestId) throw new HttpsError('invalid-argument', 'clientRequestId is required.');
  const dedupeRef = ctx.db.collection('commandActivityRequests').doc(`${ctx.uid}_call_${requestId}`);
  const existing = await dedupeRef.get();
  if (existing.exists) return { ok: true, result: 'success', duplicate: true, ...(existing.data()?.result || {}) };
  const callRef = ctx.db.collection('commandCalls').doc();
  const batch = ctx.db.batch();
  const followUpRefPath = await createFollowUp(ctx, target, 'sourceCallRef', callRef, batch, lead);
  const genuine = ['connected', 'voicemail'].includes(outcome); const now = admin.firestore.FieldValue.serverTimestamp();
  const stageTarget = lead || target;
  const stageAdvanced = genuine && clean(stageTarget.data.stage) === 'New';
  const appliedStage = stageAdvanced ? 'Opened' : clean(stageTarget.data.stage);
  const result = { callRefPath: callRef.path, connectionRefPath: `commandConnections/call_${callRef.id}`, followUpRefPath, leadRefPath: lead?.ref.path || '', stageAdvanced, appliedStage, queueMembershipMustRefresh: true, updatedRecord: { refPath: stageTarget.ref.path, stage: appliedStage } };
  const accessData = lead?.data || target.data;
  batch.create(callRef, { outcome, notes, durationSeconds: Math.max(0, Number(ctx.input.durationSeconds) || 0), ...(lead ? { leadRef: lead.ref } : {}), personRef: target.type === 'person' ? target.ref : null, organizationRef: target.type === 'organization' ? target.ref : (target.data.organizationRef || null), ownerRef: ctx.actor.userRef, ownerUid: ctx.uid, teamRepIds: accessData.teamRepIds || [], viewerUids: unique([...(accessData.viewerUids || []), ctx.uid]), createdAt: now, createdByRef: ctx.actor.userRef, createdByUid: ctx.uid, createdByName: actorName(ctx.actor) });
  const connectionRef = ctx.db.collection('commandConnections').doc(`call_${callRef.id}`);
  batch.create(connectionRef, connectionPayload(ctx, target, 'call', `Call ${outcome.replace('_', ' ')}: ${target.definition.name(target.data)}`, { outcome, notes, durationSeconds: Math.max(0, Number(ctx.input.durationSeconds) || 0), callRefPath: callRef.path, followUpRefPath }, `call:${callRef.id}`, lead));
  if (lead) {
    const leadUpdates = { updatedAt: now, updatedByRef: ctx.actor.userRef };
    if (followUpRefPath) Object.assign(leadUpdates, {
      nextActionRef: ctx.db.doc(followUpRefPath),
      nextActionTitle: clean(ctx.input.followUpTitle) || `Follow up with ${target.definition.name(target.data)}`,
      nextActionType: clean(ctx.input.followUpType) || 'Follow-up',
      nextActionAt: toTimestamp(ctx.input.followUpDueAt, 'followUpDueAt'),
    });
    if (stageAdvanced) Object.assign(leadUpdates, { stage: 'Opened', openedAt: now, stageEnteredAt: now });
    batch.update(lead.ref, leadUpdates);
  } else if (stageAdvanced) {
    batch.update(target.ref, { stage: 'Opened', openedAt: now, updatedAt: now, updatedByRef: ctx.actor.userRef });
  }
  batch.create(dedupeRef, { result, createdAt: now }); await batch.commit();
  return { ok: true, result: 'success', duplicate: false, ...result };
}

async function listCommandCallQueueService(request) {
  const ctx = await context(request); const scope = clean(ctx.input.scope).toLowerCase() || 'mine';
  if (!['mine', 'team'].includes(scope)) throw new HttpsError('invalid-argument', 'scope must be mine or team.');
  const type = normalizeType(ctx.input.recordType || 'person'); const def = DEFINITIONS[type];
  const repId = clean(ctx.actor.userData.repId);
  const snap = await ctx.db.collection(def.collection).where('archived', '==', false).get(); const now = Date.now();
  const rows = snap.docs.map(doc => ({ doc, data: doc.data() || {} })).filter(({ data }) => {
    const mine = data.ownerUid === ctx.uid || data.assignedToUid === ctx.uid;
    const team = (data.viewerUids || []).includes(ctx.uid) || (repId && (data.teamRepIds || []).map(String).includes(repId));
    return scope === 'mine' ? mine : team && !mine;
  }).filter(({ data }) => ACTIVE_STAGES.includes(clean(data.stage))).map(({ doc, data }) => {
    const due = data.flowNextActionAt?.toMillis?.() || null; const noAction = Number(data.flowOpenActionCount || 0) === 0;
    const untouched = clean(data.stage) === 'New' && !data.lastGenuineOutreachAt;
    const rank = due && due < now ? 0 : untouched ? 1 : noAction ? 2 : 3;
    return { doc, data, due, noAction, untouched, rank };
  }).sort((a, b) => a.rank - b.rank || (a.due || Number.MAX_SAFE_INTEGER) - (b.due || Number.MAX_SAFE_INTEGER) || a.doc.id.localeCompare(b.doc.id));
  const size = Math.min(Math.max(Number(ctx.input.pageSize) || 25, 1), 100); const offset = Math.max(Number(ctx.input.pageToken) || 0, 0); const page = rows.slice(offset, offset + size);
  return { ok: true, result: 'success', records: page.map(({ doc, data, due, noAction, untouched, rank }) => ({ refPath: doc.ref.path, recordType: type, name: def.name(data), stage: clean(data.stage), phone: clean(data.phone), assignedToName: clean(data.assignedToName), nextActionAt: due ? new Date(due).toISOString() : null, noFutureAction: noAction, untouchedNew: untouched, priorityRank: rank })), total: rows.length, hasMore: offset + page.length < rows.length, nextPageToken: offset + page.length < rows.length ? String(offset + page.length) : '' };
}

async function changeCommandFlowStageService(request) {
  const ctx = await context(request); const target = await record(ctx, true); const stage = clean(ctx.input.stage);
  if (!ACTIVE_STAGES.includes(stage)) throw new HttpsError('invalid-argument', `stage must be one of: ${ACTIVE_STAGES.join(', ')}.`);
  const from = clean(target.data.stage) || 'New'; if (from === stage) return { ok: true, result: 'success', unchanged: true, stage };
  const allowed = { New: ['Opened'], Opened: ['New', 'Engaged'], Engaged: ['Opened', 'Closing'], Closing: ['Engaged'] };
  if (!(allowed[from] || []).includes(stage) && ctx.actor.userData.role !== 'platform_admin') throw new HttpsError('failed-precondition', `Stage cannot move directly from ${from} to ${stage}.`);
  const reason = clean(ctx.input.reason); if (!reason) throw new HttpsError('invalid-argument', 'A stage-change reason is required.');
  const now = admin.firestore.FieldValue.serverTimestamp(); const connectionRef = ctx.db.collection('commandConnections').doc(); const batch = ctx.db.batch();
  batch.update(target.ref, { stage, updatedAt: now, updatedByRef: ctx.actor.userRef });
  batch.create(connectionRef, connectionPayload(ctx, target, 'stage_change', `Stage changed: ${from} → ${stage}`, { fromStage: from, toStage: stage, reason }, `stage:${connectionRef.id}`)); await batch.commit();
  return { ok: true, result: 'success', recordRefPath: target.ref.path, previousStage: from, stage };
}

async function closeCommandFlowRecordService(request) {
  const ctx = await context(request); const target = await record(ctx, true); const outcome = clean(ctx.input.outcome);
  if (!FINAL_STAGES.includes(outcome)) throw new HttpsError('invalid-argument', 'outcome must be Won or Lost.');
  const reason = clean(ctx.input.reason); const details = clean(ctx.input.details);
  if (!reason || !details) throw new HttpsError('invalid-argument', 'Close reason and details are required.');
  const openActions = await ctx.db.collection('commandActions').where(target.definition.relation, '==', target.ref).where('status', '==', 'open').get();
  const policy = clean(ctx.input.openActionPolicy).toLowerCase();
  if (openActions.size && !['cancel', 'keep'].includes(policy)) throw new HttpsError('failed-precondition', 'Choose openActionPolicy cancel or keep for outstanding Actions.');
  const now = admin.firestore.FieldValue.serverTimestamp(); const batch = ctx.db.batch();
  batch.update(target.ref, { stage: outcome, closedAt: now, closedByRef: ctx.actor.userRef, closeReason: reason, closeDetails: details, previousActiveStage: clean(target.data.stage), updatedAt: now, updatedByRef: ctx.actor.userRef });
  if (policy === 'cancel') openActions.docs.forEach(doc => batch.update(doc.ref, { status: 'cancelled', cancellationReason: `Record closed as ${outcome}: ${reason}`, cancelledAt: now, cancelledByRef: ctx.actor.userRef, updatedAt: now, updatedByRef: ctx.actor.userRef }));
  const connectionRef = ctx.db.collection('commandConnections').doc(); batch.create(connectionRef, connectionPayload(ctx, target, outcome === 'Won' ? 'flow_won' : 'flow_lost', `Closed as ${outcome}: ${target.definition.name(target.data)}`, { previousStage: clean(target.data.stage), outcome, reason, details, openActionPolicy: policy, affectedActionCount: policy === 'cancel' ? openActions.size : 0 }, `close:${connectionRef.id}`)); await batch.commit();
  return { ok: true, result: 'success', outcome, affectedActionCount: policy === 'cancel' ? openActions.size : 0 };
}

async function reopenCommandFlowRecordService(request) {
  const ctx = await context(request); const target = await record(ctx, false);
  if (!FINAL_STAGES.includes(clean(target.data.stage))) throw new HttpsError('failed-precondition', 'Only Won or Lost records can be reopened.');
  const reason = clean(ctx.input.reason); if (!reason) throw new HttpsError('invalid-argument', 'A reopen reason is required.');
  let stage = clean(ctx.input.stage) || clean(target.data.previousActiveStage) || 'Opened'; if (!ACTIVE_STAGES.includes(stage)) stage = 'Opened';
  const now = admin.firestore.FieldValue.serverTimestamp(); const connectionRef = ctx.db.collection('commandConnections').doc(); const batch = ctx.db.batch();
  batch.update(target.ref, { stage, reopenedAt: now, reopenedByRef: ctx.actor.userRef, reopenReason: reason, updatedAt: now, updatedByRef: ctx.actor.userRef, closedAt: null });
  batch.create(connectionRef, connectionPayload(ctx, target, 'flow_reopened', `Reopened to ${stage}: ${target.definition.name(target.data)}`, { previousOutcome: clean(target.data.stage), stage, reason }, `reopen:${connectionRef.id}`)); await batch.commit();
  return { ok: true, result: 'success', stage, previousOutcome: clean(target.data.stage) };
}

async function listCommandConnectionsPageService(request) {
  const ctx = await context(request);
  const input = ctx.input;
  const scope = clean(input.scope).toLowerCase() || 'mine';
  if (!['mine', 'team'].includes(scope)) {
    throw new HttpsError('invalid-argument', 'scope must be mine or team.');
  }

  const activityGroup = clean(input.activityGroup).toLowerCase() || 'all';
  if (activityGroup !== 'all' && !ACTIVITY_GROUPS[activityGroup]) {
    throw new HttpsError('invalid-argument', 'activityGroup must be all, emails, calls, actions, meetings, flow, or notes.');
  }
  const exactType = clean(input.type).toLowerCase();
  const search = clean(input.searchQuery || input.searchText).toLowerCase();
  const dateFrom = parseOptionalDate(input.dateFrom, 'dateFrom');
  const dateTo = parseOptionalDate(input.dateTo, 'dateTo');
  if (dateFrom && dateTo && dateFrom.toMillis() > dateTo.toMillis()) {
    throw new HttpsError('invalid-argument', 'dateFrom must be before dateTo.');
  }

  const contactScoped = Boolean(input.leadRefPath || input.personRefPath || input.organizationRefPath);
  let query = ctx.db.collection('commandConnections');
  if (input.leadRefPath) {
    query = query.where('leadRef', '==', ctx.db.doc(refPath(input.leadRefPath, LEADS_COLLECTION, 'leadRefPath')));
  } else if (input.personRefPath) {
    query = query.where('personRef', '==', ctx.db.doc(refPath(input.personRefPath, 'commandPeople', 'personRefPath')));
  } else if (input.organizationRefPath) {
    query = query.where('organizationRef', '==', ctx.db.doc(refPath(input.organizationRefPath, 'commandOrganizations', 'organizationRefPath')));
  } else if (scope === 'team') {
    if (!isPlatformAdminUser(ctx.actor.userData)) {
      const repId = clean(ctx.actor.userData.repId);
      if (!repId) throw new HttpsError('failed-precondition', 'Your representative profile does not have a rep ID.');
      query = query.where('teamRepIds', 'array-contains', repId);
    }
  } else {
    query = query.where('viewerUids', 'array-contains', ctx.uid);
  }

  if (dateFrom) query = query.where('createdAt', '>=', dateFrom);
  if (dateTo) query = query.where('createdAt', '<=', dateTo);
  query = query.orderBy('createdAt', 'desc')
    .orderBy(admin.firestore.FieldPath.documentId(), 'desc');

  const cursor = decodeConnectionCursor(input.pageToken);
  if (cursor) query = query.startAfter(cursor.createdAt, cursor.id);

  const size = Math.min(Math.max(Number(input.pageSize) || 30, 1), 50);
  const wantedTypes = ACTIVITY_GROUPS[activityGroup] || null;
  const matches = ({ data }) => {
    const mine = data.ownerUid === ctx.uid || data.assignedToUid === ctx.uid;
    if (!visible(ctx, data)) return false;
    if (!contactScoped && (scope === 'mine' ? !mine : mine)) return false;
    const type = clean(data.type).toLowerCase();
    if (exactType && exactType !== 'all' && type !== exactType) return false;
    if (wantedTypes && !wantedTypes.has(type)) return false;
    if (!search) return true;
    return [
      data.summary, data.body, data.personName, data.organizationName,
      data.createdByName, data.ownerName, data.recordName,
    ].some(value => clean(value).toLowerCase().includes(search));
  };

  const records = [];
  let lastReturned = null;
  let scanQuery = query;
  let exhausted = false;
  while (records.length <= size && !exhausted) {
    const snapshot = await scanQuery.limit(Math.max(size * 3, 50)).get();
    if (snapshot.empty) break;
    for (const doc of snapshot.docs) {
      const row = { doc, data: doc.data() || {} };
      if (matches(row)) {
        records.push(row);
        lastReturned = doc;
        if (records.length > size) break;
      }
    }
    exhausted = snapshot.size < Math.max(size * 3, 50);
    if (records.length <= size && !exhausted) {
      const lastScanned = snapshot.docs[snapshot.docs.length - 1];
      scanQuery = query.startAfter(lastScanned.data().createdAt, lastScanned.id);
    }
  }

  const page = records.slice(0, size);
  const hasMore = records.length > size || !exhausted;
  const tokenDoc = page.length ? page[page.length - 1].doc : lastReturned;
  return {
    ok: true,
    result: 'success',
    records: page.map(({ doc, data }) => {
      const personName = clean(data.personName);
      const organizationName = clean(data.organizationName);
      const recordType = clean(data.recordType) ||
        (data.personRef ? 'person' : (data.organizationRef ? 'organization' : 'general'));
      const recordName = clean(data.recordName) ||
        (recordType === 'person' ? personName : organizationName) ||
        clean(data.summary);
      return {
        refPath: doc.ref.path,
        type: clean(data.type),
        summary: clean(data.summary),
        body: clean(data.body),
        details: data.details || {},
        recordType,
        recordName,
        leadRefPath: serialize(data.leadRef) || '',
        personRefPath: serialize(data.personRef) || '',
        personName,
        organizationRefPath: serialize(data.organizationRef) || '',
        organizationName,
        actionRefPath: serialize(data.actionRef) || '',
        threadRefPath: serialize(data.threadRef) || '',
        sourceRefPath: serialize(data.sourceRef) || '',
        performedByRefPath: serialize(data.createdByRef) || '',
        performedByName: clean(data.createdByName) || 'Experience Command',
        ownerName: clean(data.ownerName),
        createdAt: serialize(data.createdAt),
        deduplicationKey: clean(data.deduplicationKey),
      };
    }),
    hasMore,
    nextPageToken: hasMore && tokenDoc ? encodeConnectionCursor(tokenDoc) : '',
  };
}

async function loadEmailThread(snap, dbOverride) {
  const threadRef = snap.ref.parent.parent;
  if (!threadRef) return null;
  const db = dbOverride || admin.firestore();
  const threadSnap = await threadRef.get();
  if (!threadSnap.exists) return null;
  return { db, threadRef, thread: threadSnap.data() || {} };
}

// Keep the deployed export and trigger type stable, but retire the legacy
// duplicate inbound notification writer. PR 72's inboundEmailNotification
// thread trigger is the single authoritative Incoming ExMail notification path.
async function inboundEmailEngagementHandler() {
  return null;
}

async function outboundEmailSentEngagementHandler(event, deps = {}) {
  const before = event.data?.before;
  const after = event.data?.after;
  if (!before?.exists || !after?.exists) return;
  const previous = before.data() || {};
  const message = after.data() || {};
  if (clean(message.direction).toLowerCase() !== 'out') return;
  if (clean(message.status).toLowerCase() !== 'sent' || clean(previous.status).toLowerCase() === 'sent') return;

  const context = await loadEmailThread(after, deps.db);
  if (!context) return;
  const { db, threadRef, thread } = context;
  const now = admin.firestore.FieldValue.serverTimestamp();
  const batch = db.batch();

  for (const ref of [thread.personRef, thread.organizationRef]) {
    if (!ref?.path) continue;
    const recordSnap = await ref.get();
    if (recordSnap.exists && clean(recordSnap.data()?.stage) === 'New') {
      batch.update(ref, {
        stage: 'Opened',
        openedAt: now,
        lastGenuineOutreachAt: now,
        updatedAt: now,
      });
    }
  }

  const followUp = message.commandFollowUp;
  if (followUp && followUp.dueAt) {
    const dueAt = toTimestamp(followUp.dueAt, 'followUpDueAt');
    let assignedToRef = thread.ownerRef || null;
    if (clean(followUp.assignedToRefPath)) {
      const parts = clean(followUp.assignedToRefPath).split('/').filter(Boolean);
      if (parts.length === 2 && parts[0] === 'users') assignedToRef = db.doc(parts.join('/'));
    }
    const access = await buildCommandAccessMetadata(db, {
      actorRef: message.createdByRef || thread.ownerRef || assignedToRef,
      ownerRef: thread.ownerRef || assignedToRef,
      assignedToRef,
    });
    const actionRef = db.collection('commandActions').doc(`email_followup_${after.id}`);
    const actionData = {
      title: clean(followUp.title) || `Follow up: ${clean(thread.subject) || 'ExMail'}`,
      description: clean(followUp.description),
      actionType: clean(followUp.type) || 'Follow-up',
      priority: clean(followUp.priority) || 'Medium',
      status: 'open',
      dueAt,
      dueDateKey: dateKey(dueAt),
      relatedType: thread.personRef ? 'Person' : (thread.organizationRef ? 'Organization' : 'General'),
      ...(thread.leadRef ? { leadRef: thread.leadRef } : {}),
      personRef: thread.personRef || null,
      personName: clean(thread.personName),
      organizationRef: thread.organizationRef || null,
      organizationName: clean(thread.organizationName),
      ...access,
      sourceEmailMessageRef: after.ref,
      sourceEmailThreadRef: threadRef,
      createdAt: now,
      updatedAt: now,
      createdByRef: message.createdByRef || thread.ownerRef || null,
      createdByUid: clean(message.createdByUid || thread.ownerUid),
      createdByName: clean(message.createdByName || thread.ownerName) || 'Experience Command',
      updatedByRef: message.createdByRef || thread.ownerRef || null,
    };
    // Eventarc can redeliver a sent event after a rep completed its follow-up.
    // Preserve the existing action (including completion and manual edits).
    await db.runTransaction(async transaction => {
      const existing = await transaction.get(actionRef);
      if (!existing.exists) transaction.create(actionRef, actionData);
    });
  }

  await batch.commit();
}

exports.logCommandCallOutcomeService = logCommandCallOutcomeService;
exports.listCommandCallQueueService = listCommandCallQueueService;
exports.changeCommandFlowStageService = changeCommandFlowStageService;
exports.closeCommandFlowRecordService = closeCommandFlowRecordService;
exports.reopenCommandFlowRecordService = reopenCommandFlowRecordService;
exports.listCommandConnectionsPageService = listCommandConnectionsPageService;
exports.logCommandCallOutcome = callable(logCommandCallOutcomeService);
exports.listCommandCallQueue = callable(listCommandCallQueueService);
exports.changeCommandFlowStage = callable(changeCommandFlowStageService);
exports.closeCommandFlowRecord = callable(closeCommandFlowRecordService);
exports.reopenCommandFlowRecord = callable(reopenCommandFlowRecordService);
exports.listCommandConnectionsPage = callable(listCommandConnectionsPageService);
exports.commandEmailEngagement = onDocumentCreated({ region: 'us-central1', document: 'commandEmailThreads/{threadId}/emailMessages/{messageId}', timeoutSeconds: 120, memory: '256MiB' }, inboundEmailEngagementHandler);
exports.commandEmailSentEngagement = onDocumentUpdated({ region: 'us-central1', document: 'commandEmailThreads/{threadId}/emailMessages/{messageId}', timeoutSeconds: 120, memory: '256MiB' }, outboundEmailSentEngagementHandler);
exports._test = { normalizeType, dateKey, encodeConnectionCursor, decodeConnectionCursor, ACTIVITY_GROUPS, visible, outboundEmailSentEngagementHandler };

