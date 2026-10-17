'use strict';

const admin = require('firebase-admin');
const crypto = require('crypto');
const { localDayBounds } = require('../../lib/command/commandReportingUtils');
const { visible, callablePhone, iso, restricted } = require('../../lib/command/commandOutreachSupport');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const {
  clean, commandActorContext, resolveAllowedRepresentatives, requireAllowedRepresentative,
} = require('../../lib/command/commandReportingUtils');
const { isPlatformAdminUser } = require('../../lib/command/commandPersonUtils');

const ACTIVE_STAGES = ['New', 'Opened', 'Engaged', 'Closing'];
const RECONNECT_AFTER_MS = 30 * 86400000;
const COOLING_AFTER_MS = 14 * 86400000;
const refPath = value => clean(value?.path || value);
const serialize = value => value?.toDate ? value.toDate().toISOString() : (value?.path || value || null);
const millis = value => typeof value?.toMillis === 'function' ? value.toMillis() : null;

function normalizeType(value) {
  const raw = clean(value).toLowerCase();
  const type = ({ people: 'person', organizations: 'organization', lead: 'all', leads: 'all' })[raw] || raw || 'all';
  if (!['all', 'person', 'organization'].includes(type)) {
    throw new HttpsError('invalid-argument', 'leadType must be all, person, or organization.');
  }
  return type;
}
function normalizeMode(value) {
  const raw = clean(value).toLowerCase().replace(/[\s-]+/g, '_');
  const mode = ({ priority: 'priority_calls', new: 'new_leads', follow_ups: 'follow_ups_due', stage: 'stage_campaign', custom: 'custom_queue' })[raw] || raw || 'priority_calls';
  if (!['priority_calls', 'new_leads', 'follow_ups_due', 'reconnect', 'stage_campaign', 'custom_queue', 'today_retry', 'selected'].includes(mode)) {
    throw new HttpsError('invalid-argument', 'queueMode is invalid.');
  }
  return mode;
}
function validPhone(value) { return clean(value).replace(/\D/g, '').length >= 10; }
function personName(data = {}) {
  return clean(data.fullName) || [clean(data.firstName), clean(data.lastName)].filter(Boolean).join(' ') ||
    clean(data.displayName) || clean(data.email) || 'Unnamed contact';
}
function isMine(uid, data = {}) { return clean(data.ownerUid) === uid || clean(data.assignedToUid) === uid; }
function canSee(uid, actorData, data = {}) {
  if (isPlatformAdminUser(actorData)) return true;
  const repId = clean(String(actorData?.repId ?? ''));
  return isMine(uid, data) || (data.viewerUids || []).includes(uid) ||
    (repId && (data.teamRepIds || []).map(String).includes(repId));
}
function nextAction(data = {}) {
  return {
    ref: data.nextActionRef || data.flowNextActionRef || null,
    title: clean(data.nextActionTitle || data.flowNextActionTitle),
    type: clean(data.nextActionType || data.flowNextActionType),
    at: data.nextActionAt || data.flowNextActionAt || null,
  };
}
function sameCalgaryDay(value, now = Date.now()) {
  if (!value) return false;
  const format = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Edmonton' });
  return format.format(new Date(value)) === format.format(new Date(now));
}
function matchesQueueMode(row, mode, now) {
  if (mode === 'new_leads') return row.data.stage === 'New' && row.untouched;
  if (mode === 'follow_ups_due') return Boolean(row.nextAt && row.nextAt <= now);
  if (mode === 'reconnect') {
    return Boolean(row.lastMeaningful) && row.lastMeaningful <= now - RECONNECT_AFTER_MS && !row.hasOpenAction;
  }
  return true;
}
function recommendation(row, now) {
  const reasons = [];
  let score = 0;
  if (row.nextAt && row.nextAt < now) {
    const days = Math.max(1, Math.ceil((now - row.nextAt) / 86400000));
    reasons.push(`${row.nextAction.title || 'Follow-up'} is ${days} day${days === 1 ? '' : 's'} overdue`);
    score += 100000 + Math.min(days, 30) * 1000;
  } else if (row.nextAt && sameCalgaryDay(row.nextAt, now)) {
    reasons.push(`${row.nextAction.title || 'Follow-up'} is due today`);
    score += 90000;
  }
  if (row.noOpenAction) {
    reasons.push(`${row.data.stage || 'Active'} Lead has no next step`);
    score += ({ Closing: 80000, Engaged: 70000, Opened: 60000, New: 50000 })[row.data.stage] || 40000;
  }
  if (row.untouched) {
    reasons.push('New Lead has not been contacted yet');
    score += 55000;
  }
  if (row.lastActivityAt && row.lastActivityAt <= now - COOLING_AFTER_MS) {
    const days = Math.floor((now - row.lastActivityAt) / 86400000);
    reasons.push(`No recorded activity for ${days} days`);
    score += 35000 + Math.min(days, 60) * 100;
  }
  if (!reasons.length) {
    reasons.push(row.nextAt ? 'Upcoming follow-up is ready to work' : 'Active Lead is ready for outreach');
    score += 10000;
  }
  if (row.calledToday) score -= 50000;
  return { score, reasons, reason: reasons[0] };
}
function chooseBestContact(lead, people, organizations = new Map()) {
  const candidates = [];
  const add = (ref, relationship) => {
    const path = refPath(ref);
    if (path && !candidates.some(item => item.path === path)) candidates.push({ path, relationship });
  };
  add(lead.primaryContactRef, 'Primary contact');
  add(lead.subjectPersonRef, clean(lead.leadType) === 'person' ? 'Person Lead' : 'Lead contact');
  for (const ref of lead.connectedPersonRefs || []) add(ref, 'Connected person');
  const resolved = candidates.map(candidate => {
    const data = people.get(candidate.path);
    if (!data) return null;
    const phone = clean(data.phone);
    const email = clean(data.email);
    const doNotCall = data.doNotCall === true || clean(data.phoneStatus).toLowerCase() === 'do_not_call';
    return {
      refPath: candidate.path, name: personName(data), position: clean(data.position || data.jobTitle),
      phone, email, canCall: !doNotCall && callablePhone(data), canEmail: Boolean(email && email.includes('@')),
      doNotCall, relationship: candidate.relationship, recordType: 'person',
    };
  }).filter(Boolean);
  const organizationPath = refPath(lead.subjectOrganizationRef);
  const organization = organizations.get(organizationPath);
  // Do not bypass a contact/Lead opt-out by offering the business number instead.
  if (organization) {
    const doNotCall = lead.doNotCall === true || clean(lead.phoneStatus).toLowerCase() === 'do_not_call' ||
      resolved.some(item => item.doNotCall) || organization.doNotCall === true || clean(organization.phoneStatus).toLowerCase() === 'do_not_call';
    const phone = clean(organization.phone);
    const email = clean(organization.email);
    resolved.push({ refPath: organizationPath, recordType: 'organization',
      name: clean(organization.organization || organization.name), position: '',
      phone, email, canCall: !doNotCall && callablePhone(organization),
      canEmail: Boolean(email && email.includes('@')), doNotCall, relationship: 'Business contact' });
  }
  if (lead.doNotCall === true || clean(lead.phoneStatus).toLowerCase() === 'do_not_call') {
    for (const item of resolved) { item.canCall = false; item.doNotCall = true; }
  }
  return resolved.find(item => item.canCall) || resolved.find(item => item.canEmail) || resolved[0] || null;
}

async function listCommandCallQueueService(request, deps = {}) {
  const ctx = await (deps.context || commandActorContext)(request);
  const input = ctx.input;
  const scope = clean(input.scope).toLowerCase() || 'mine';
  if (!['mine', 'team'].includes(scope)) throw new HttpsError('invalid-argument', 'scope must be mine or team.');
  const leadType = normalizeType(input.leadType || input.recordType);
  const mode = normalizeMode(input.queueMode);
  const allowedReps = await resolveAllowedRepresentatives(ctx, { includeAllForPlatformAdmin: true });
  const selectedRep = clean(input.assignedToUid) ? requireAllowedRepresentative(allowedReps, input.assignedToUid, ctx.uid) : null;
  const requestedStages = Array.isArray(input.stages) ? input.stages.map(clean).filter(stage => ACTIVE_STAGES.includes(stage)) : [];
  if (mode === 'stage_campaign' && requestedStages.length !== 1) {
    throw new HttpsError('invalid-argument', 'Stage Campaign requires exactly one active stage.');
  }
  const stages = requestedStages.length ? requestedStages : ACTIVE_STAGES;
  const search = clean(input.search).toLowerCase();
  if (search.length > 200) throw new HttpsError('invalid-argument', 'Search must be 200 characters or fewer.');
  const now = Date.now();
  const size = Math.min(Math.max(Number(input.pageSize) || 25, 1), 100);
  const filterHash = crypto.createHash('sha256').update(JSON.stringify({ scope, leadType, mode, stages, rep: selectedRep?.uid || '', search,
    sort: clean(input.sort), exclude: input.excludeCalledToday === true, include: input.includeNoFutureAction !== false, includeMissing: input.includeMissingNextStep !== false,
    list: clean(input.leadListId), source: clean(input.source), retryAll: input.retryAll === true, selected: input.selectedLeadRefPaths || [] })).digest('hex');
  const cursor = decodeCursor(input.pageToken);
  const queueId = cursor?.queueId || clean(input.resumeQueueId);
  let snapshot = null;
  if (queueId) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(queueId)) throw new HttpsError('invalid-argument', 'Invalid queue ID.');
    const saved = await ctx.db.doc(`commandOutreachQueues/${queueId}`).get();
    snapshot = saved.exists ? saved.data() : null;
    if (!snapshot || snapshot.uid !== ctx.uid || snapshot.filterHash !== filterHash) throw new HttpsError('permission-denied', 'This queue does not match your account and filters.');
    if (snapshot.expiresAt.toMillis() <= now) throw new HttpsError('failed-precondition', 'This queue expired. Start a fresh queue.');
  }
  let offset = cursor?.offset || 0;
  if (snapshot && !cursor) {
    const currentIndex = snapshot.paths.indexOf(snapshot.currentLeadRefPath);
    offset = Math.max(0, currentIndex);
    while (offset < snapshot.paths.length && ['worked', 'skipped'].includes(snapshot.progress?.[snapshot.paths[offset]])) offset++;
  }
  let retryCalls = new Map();
  let leadDocs;
  if (snapshot) {
    const paths = snapshot.paths.slice(offset, offset + size);
    leadDocs = paths.length ? (await ctx.db.getAll(...paths.map(path => ctx.db.doc(path)))).filter(d => d.exists) : [];
    if (mode === 'today_retry') retryCalls = await todaysCalls(ctx, now);
  } else if (mode === 'today_retry') {
    retryCalls = await todaysCalls(ctx, now);
    const paths = [...retryCalls.keys()];
    leadDocs = await getDocuments(ctx.db, paths);
  } else if (mode === 'selected') {
    const paths = input.selectedLeadRefPaths;
    if (!Array.isArray(paths) || !paths.length || paths.length > 500 || paths.some(p => typeof p !== 'string' || !/^commandLeads\/[^/]+$/.test(p))) throw new HttpsError('invalid-argument', 'Select between 1 and 500 Lead paths.');
    leadDocs = await getDocuments(ctx.db, [...new Set(paths)]);
    if (leadDocs.length !== new Set(paths).size || leadDocs.some(d => !canSee(ctx.uid, ctx.actor.userData, d.data()))) throw new HttpsError('permission-denied', 'One or more selected Leads are unavailable.');
  } else {
    leadDocs = await scopedLeads(ctx, scope, stages);
  }
  // Only fetch actions belonging to these candidate Leads; never scan all open actions.
  const actionDocs = [];
  for (let i = 0; i < leadDocs.length; i += 30) {
    const chunk = leadDocs.slice(i, i + 30);
    const snap = await ctx.db.collection('commandActions').where('leadRef', 'in', chunk.map(d => d.ref)).where('status', '==', 'open').limit(2001).get();
    if (snap.size > 2000) throw new HttpsError('resource-exhausted', 'Too many open actions in this queue. Narrow your filters.');
    actionDocs.push(...snap.docs);
  }
  const leadSnap = { docs: leadDocs }, actionSnap = { docs: actionDocs };
  const leads = leadSnap.docs.filter(doc => {
    const data = doc.data() || {};
    if (data.archived === true || clean(data.status) !== 'active' || !canSee(ctx.uid, ctx.actor.userData, data)) return false;
    const mine = isMine(ctx.uid, data);
    if (!['today_retry', 'selected'].includes(mode) && (scope === 'mine' ? !mine : mine)) return false;
    if (selectedRep && ![data.assignedToUid, data.ownerUid].map(clean).includes(selectedRep.uid)) return false;
    if (leadType !== 'all' && clean(data.leadType) !== leadType) return false;
    if (!stages.includes(clean(data.stage))) return false;
    if (search && !clean(data.searchTextNormalized).includes(search) &&
        ![data.displayName, data.subjectPersonName, data.subjectOrganizationName, data.primaryContactName, data.leadListName, data.source]
          .some(value => clean(value).toLowerCase().includes(search))) return false;
    return true;
  });
  const refs = new Map();
  for (const doc of leads) {
    const data = doc.data() || {};
    for (const ref of [data.primaryContactRef, data.subjectPersonRef, ...(data.connectedPersonRefs || [])]) {
      if (ref?.path) refs.set(ref.path, ref);
    }
  }
  const personDocs = await getDocuments(ctx.db, [...refs.keys()]);
  const people = new Map(personDocs.filter(doc => doc.exists && doc.data()?.archived !== true && (visible(ctx.uid, ctx.actor.userData, doc.data()) || restricted(doc.data()))).map(doc => [doc.ref.path, visible(ctx.uid, ctx.actor.userData, doc.data()) ? doc.data() : { doNotCall: true }]));
  const organizationRefs = new Map();
  for (const doc of leads) {
    const data = doc.data() || {};
    if (chooseBestContact(data, people)?.canCall) continue;
    const ref = data.subjectOrganizationRef;
    if (ref?.path?.startsWith('commandOrganizations/')) organizationRefs.set(ref.path, ref);
  }
  const organizationDocs = await getDocuments(ctx.db, [...organizationRefs.keys()]);
  const organizations = new Map(organizationDocs.filter(doc => doc.exists && doc.data()?.archived !== true &&
    canSee(ctx.uid, ctx.actor.userData, doc.data())).map(doc => [doc.ref.path, doc.data() || {}]));
  const actionsByLead = new Map();
  for (const doc of actionSnap.docs) {
    const data = doc.data() || {}; const path = refPath(data.leadRef); if (!path || !visible(ctx.uid, ctx.actor.userData, data)) continue;
    const list = actionsByLead.get(path) || []; list.push({ refPath: doc.ref.path, ...data }); actionsByLead.set(path, list);
  }
  let uncontactableCount = 0;
  let rows = leads.map(doc => {
    const data = doc.data() || {}; const path = doc.ref.path;
    const actions = (actionsByLead.get(path) || []).sort((a, b) => (millis(a.startAt || a.dueAt) || Infinity) - (millis(b.startAt || b.dueAt) || Infinity));
    const actionNext = actions[0] || null;
    const next = { ref: actionNext?.refPath || null, title: clean(actionNext?.title), type: clean(actionNext?.actionType), at: actionNext?.startAt || actionNext?.dueAt || null };
    const row = {
      doc, data, actions, contact: chooseBestContact(data, people, organizations), nextAction: next,
      nextAt: millis(next.at),
      lastCalledAt: millis(data.lastCallAt),
      lastMeaningful: millis(data.lastMeaningfulConnectionAt),
      lastActivityAt: millis(data.lastActivityAt || data.updatedAt || data.createdAt),
      untouched: !data.firstAttemptAt,
      hasOpenAction: actions.length > 0,
      noFutureAction: !(millis(next.at) && millis(next.at) > now) && !actions.some(action => (millis(action.dueAt) || 0) > now),
    };
    row.noOpenAction = !row.hasOpenAction;
    row.calledToday = sameCalgaryDay(row.lastCalledAt, now);
    Object.assign(row, recommendation(row, now));
    return row;
  }).filter(row => {
    if (!row.contact || (!row.contact.canCall && !row.contact.canEmail)) { uncontactableCount += 1; return false; }
    if (!['today_retry', 'selected'].includes(mode) && input.excludeCalledToday === true && row.calledToday) return false;
    if (mode === 'today_retry' && (!retryCalls.has(row.doc.ref.path) || (input.retryAll !== true && !['no_answer', 'voicemail'].includes(retryCalls.get(row.doc.ref.path).lastOutcome)))) return false;
    if (input.includeMissingNextStep === false && row.noOpenAction) return false;
    if (input.includeNoFutureAction === false && row.noFutureAction) return false;
    if (clean(input.leadListId) && clean(row.data.leadListId) !== clean(input.leadListId)) return false;
    if (clean(input.source) && clean(row.data.source).toLowerCase() !== clean(input.source).toLowerCase()) return false;
    return matchesQueueMode(row, mode, now);
  });
  if (mode === 'new_leads') rows.sort((a, b) => (millis(a.data.createdAt) || 0) - (millis(b.data.createdAt) || 0));
  else if (mode === 'follow_ups_due') rows.sort((a, b) => (a.nextAt || Infinity) - (b.nextAt || Infinity));
  else if (mode === 'reconnect') rows.sort((a, b) => (a.lastMeaningful || 0) - (b.lastMeaningful || 0));
  else if (clean(input.sort) === 'oldest_created') rows.sort((a, b) => (millis(a.data.createdAt) || 0) - (millis(b.data.createdAt) || 0));
  else if (clean(input.sort) === 'oldest_activity') rows.sort((a, b) => (a.lastActivityAt || 0) - (b.lastActivityAt || 0));
  else rows.sort((a, b) => b.score - a.score || (a.nextAt || Infinity) - (b.nextAt || Infinity) || a.doc.id.localeCompare(b.doc.id));
  if (mode === 'selected') {
    const order = new Map([...new Set(input.selectedLeadRefPaths || [])].map((path, index) => [path, index]));
    rows.sort((a, b) => order.get(a.doc.ref.path) - order.get(b.doc.ref.path));
  }
  if (mode === 'today_retry') rows.sort((a, b) => retryCalls.get(a.doc.ref.path).lastAt - retryCalls.get(b.doc.ref.path).lastAt);
  let savedRef;
  if (!snapshot) {
    savedRef = ctx.db.collection('commandOutreachQueues').doc();
    snapshot = { uid: ctx.uid, filterHash, filterOptions: { scope, leadType, queueMode: mode, stages, assignedToUid: selectedRep?.uid || '', search, sort: clean(input.sort), excludeCalledToday: input.excludeCalledToday === true, includeNoFutureAction: input.includeNoFutureAction !== false, includeMissingNextStep: input.includeMissingNextStep !== false, leadListId: clean(input.leadListId), source: clean(input.source), retryAll: input.retryAll === true, selectedLeadRefPaths: input.selectedLeadRefPaths || [] }, paths: rows.map(r => r.doc.ref.path), uncontactableCount,
      createdAt: admin.firestore.Timestamp.now(), expiresAt: admin.firestore.Timestamp.fromMillis(now + 8 * 3600000) };
    await savedRef.create(snapshot);
  }
  const pagePaths = snapshot.paths.slice(offset, offset + size);
  const rowMap = new Map(rows.map(row => [row.doc.ref.path, row]));
  const page = pagePaths.map(path => rowMap.get(path)).filter(Boolean);
  const nextOffset = offset + pagePaths.length;
  const activeQueueId = queueId || savedRef.id;
  const nextPageToken = nextOffset < snapshot.paths.length ? Buffer.from(JSON.stringify({ queueId: activeQueueId, offset: nextOffset })).toString('base64url') : '';
  return {
    ok: true, result: 'success', queueMode: mode, leadType, sessionId: clean(input.sessionId), allowedReps,
    records: page.map(row => ({
      id: row.doc.id, refPath: row.doc.ref.path, leadRefPath: row.doc.ref.path, recordType: 'lead',
      leadType: clean(row.data.leadType), name: clean(row.data.displayName) || 'Unnamed Lead',
      stage: clean(row.data.stage), status: clean(row.data.status),
      contactRefPath: row.contact.refPath, contactRecordType: row.contact.recordType,
      personRefPath: row.contact.recordType === 'person' ? row.contact.refPath : '', personName: row.contact.name, personPosition: row.contact.position,
      phone: row.contact.phone, email: row.contact.email, canCall: row.contact.canCall, canEmail: row.contact.canEmail,
      contactReason: row.contact.relationship, organizationRefPath: refPath(row.data.subjectOrganizationRef),
      organizationName: clean(row.data.subjectOrganizationName), assignedToRefPath: refPath(row.data.assignedToRef),
      assignedToUid: clean(row.data.assignedToUid), assignedToName: clean(row.data.assignedToName),
      leadListId: clean(row.data.leadListId), leadListName: clean(row.data.leadListName), source: clean(row.data.source),
      lastActivityAt: row.lastActivityAt ? new Date(row.lastActivityAt).toISOString() : null,
      lastCalledAt: row.lastCalledAt ? new Date(row.lastCalledAt).toISOString() : null,
      lastMeaningfulContactAt: row.lastMeaningful ? new Date(row.lastMeaningful).toISOString() : null,
      lastCallOutcome: clean(row.data.lastCallOutcome), callAttemptCount: Number(row.data.callAttemptCount) || 0, calledToday: row.calledToday,
      nextActionRefPath: refPath(row.nextAction.ref), nextActionAt: serialize(row.nextAction.at),
      nextActionTitle: row.nextAction.title, nextActionType: row.nextAction.type,
      hasFutureAction: !row.noFutureAction, noFutureAction: row.noFutureAction, untouchedNew: row.untouched,
      queueReason: row.reason, recommendationReason: row.reason, recommendationReasons: row.reasons,
      priorityScore: row.score,
      todayAttemptCount: retryCalls.get(row.doc.ref.path)?.count || 0,
      todayLastCallOutcome: retryCalls.get(row.doc.ref.path)?.lastOutcome || '',
      todayLastCallAt: retryCalls.has(row.doc.ref.path) ? new Date(retryCalls.get(row.doc.ref.path).lastAt).toISOString() : null,
    })),
    total: snapshot.paths.length, uncontactableCount: snapshot.uncontactableCount, hasMore: Boolean(nextPageToken),
    queueId: activeQueueId, queueExpiresAt: iso(snapshot.expiresAt), nextPageToken,
  };
}


function decodeCursor(raw) {
  if (!raw) return null;
  try {
    const value = JSON.parse(Buffer.from(String(raw), 'base64url').toString());
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(value.queueId) || !Number.isSafeInteger(value.offset) || value.offset < 0) throw Error();
    return value;
  } catch (_) { throw new HttpsError('invalid-argument', 'This queue cursor is invalid. Refresh the queue.'); }
}
async function getDocuments(db, paths) {
  const docs = [];
  for (let i = 0; i < paths.length; i += 100) docs.push(...await db.getAll(...paths.slice(i, i + 100).map(p => db.doc(p))));
  return docs.filter(d => d.exists);
}
async function scopedLeads(ctx, scope, stages) {
  const col = ctx.db.collection('commandLeads').where('status', '==', 'active').where('archived', '==', false);
  const repId = clean(String(ctx.actor.userData.repId ?? ''));
  let queries = scope === 'mine' ? [col.where('ownerUid', '==', ctx.uid), col.where('assignedToUid', '==', ctx.uid)] :
    isPlatformAdminUser(ctx.actor.userData) ? [col] :
    [col.where('viewerUids', 'array-contains', ctx.uid), ...(repId ? [col.where('teamRepIds', 'array-contains', repId)] : [])];
  queries = queries.map(query => {
    if (stages.length === 1) query = query.where('stage', '==', stages[0]);
    if (clean(ctx.input.leadListId)) query = query.where('leadListId', '==', clean(ctx.input.leadListId));
    return query.limit(2001);
  });
  const results = await Promise.all(queries.map(q => q.get()));
  if (results.some(s => s.size > 2000)) throw new HttpsError('resource-exhausted', 'Choose a Lead list or stage to narrow this queue (maximum 2,000 candidates per scope).');
  return [...new Map(results.flatMap(s => s.docs).map(d => [d.id, d])).values()];
}
async function todaysCalls(ctx, now) {
  const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Edmonton', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  const { start, end } = localDayBounds(localDate);
  const snap = await ctx.db.collection('commandCalls').where('createdByUid', '==', ctx.uid).where('callFinishedAt', '>=', start).where('callFinishedAt', '<', end).orderBy('callFinishedAt').limit(2001).get();
  if (snap.size > 2000) throw new HttpsError('resource-exhausted', 'Today’s call history exceeds the supported queue size.');
  return groupRetryCalls(snap.docs);
}
function groupRetryCalls(docs) {
  const rows = new Map();
  for (const doc of docs) {
    const data = doc.data(); const path = refPath(data.leadRef);
    if (data.status !== 'completed' || !path || !millis(data.callFinishedAt)) continue;
    const row = rows.get(path) || { count: 0, lastAt: 0, lastOutcome: '' };
    row.count++;
    if (millis(data.callFinishedAt) >= row.lastAt) { row.lastAt = millis(data.callFinishedAt); row.lastOutcome = clean(data.outcome); }
    rows.set(path, row);
  }
  return rows;
}

exports.listCommandCallQueueService = listCommandCallQueueService;
exports.listCommandCallQueue = onCall(
  { region: 'us-central1', cors: true, timeoutSeconds: 120, memory: '1GiB' },
  listCommandCallQueueService
);
exports._test = {
  normalizeType, normalizeMode, validPhone, matchesQueueMode, recommendation,
  chooseBestContact, sameCalgaryDay, RECONNECT_AFTER_MS, decodeCursor, groupRetryCalls,
};



