'use strict';

const crypto = require('crypto');
const admin = require('firebase-admin');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated, onDocumentWritten } = require('firebase-functions/v2/firestore');
const { requireAuth, requireCommandAccess, isPlatformAdminUser } = require('../../lib/command/commandPersonUtils');

const VERSION = 1;
const LEADS = 'commandLeads';
const CONNECTIONS = 'commandConnections';
const ACTIONS = 'commandActions';
const AGREEMENTS = 'commandAgreements';
const TOKENS = 'commandAgreementSigningTokens';
const clean = value => typeof value === 'string' ? value.trim() : '';
const identifier = value => value === null || value === undefined ? '' : String(value).trim();
const refPath = value => clean(value?.path || value);
const unique = values => [...new Set((values || []).filter(Boolean))];
const serverTimestamp = () => admin.firestore.FieldValue.serverTimestamp();

const EVENT_TYPES = new Set([
  'lead_created', 'lead_imported', 'lead_assigned', 'first_attempt',
  'call_started', 'call_finished', 'email_sent', 'email_received',
  'first_meaningful_connection', 'action_created', 'action_completed',
  'meeting_booked', 'meeting_started', 'meeting_finished',
  'meeting_no_show', 'meeting_rescheduled', 'agreement_sent',
  'presentation_started', 'presentation_completed',
  'agreement_signed', 'agreement_declined', 'stage_changed',
  'lead_won', 'lead_lost',
]);

const TYPE_MAP = Object.freeze({
  lead_created: 'lead_created',
  lead_imported: 'lead_imported',
  lead_assigned: 'lead_assigned',
  lead_stage_changed: 'stage_changed',
  stage_change: 'stage_changed',
  lead_won: 'lead_won',
  flow_won: 'lead_won',
  lead_lost: 'lead_lost',
  flow_lost: 'lead_lost',
  call_started: 'call_started',
  call: 'call_finished',
  call_finished: 'call_finished',
  email_out: 'email_sent',
  email_in: 'email_received',
  action_created: 'action_created',
  action_completed: 'action_completed',
  meeting_scheduled: 'meeting_booked',
  meeting_created: 'meeting_booked',
  meeting_started: 'meeting_started',
  meeting_held: 'meeting_finished',
  meeting_finished: 'meeting_finished',
  meeting_no_show: 'meeting_no_show',
  meeting_rescheduled: 'meeting_rescheduled',
  agreement_sent: 'agreement_sent',
  agreement_signed: 'agreement_signed',
  agreement_declined: 'agreement_declined',
});

function canonicalEventType(type) {
  const normalized = clean(type).toLowerCase();
  return TYPE_MAP[normalized] || (EVENT_TYPES.has(normalized) ? normalized : '');
}

function path(value, collection, field, required = false) {
  const parts = refPath(value).split('/').filter(Boolean);
  if (!parts.length && !required) return '';
  if (parts.length !== 2 || parts[0] !== collection) {
    throw new HttpsError('invalid-argument', `${field} must use ${collection}/{documentId}.`);
  }
  return parts.join('/');
}

function milliseconds(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value?.toMillis) return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (value && Number.isFinite(value.seconds)) return value.seconds * 1000 + Math.floor(Number(value.nanoseconds || 0) / 1e6);
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function secondsBetween(start, finish) {
  const from = milliseconds(start); const to = milliseconds(finish);
  return from === null || to === null ? null : Math.max(0, Math.round((to - from) / 1000));
}

function actionTiming(source = {}) {
  const completedAt = source.completedAt || source.outcomeSetAt || null;
  const dueAt = source.dueAt || null;
  const completeMs = milliseconds(completedAt); const dueMs = milliseconds(dueAt);
  if (completeMs === null || dueMs === null) return { completedOnTime: null, completionTiming: '' };
  const onTime = completeMs <= dueMs;
  return { completedOnTime: onTime, completionTiming: onTime ? 'on_time' : 'late' };
}

function outcomeFor(eventType, data = {}, source = {}) {
  const details = data.details || {};
  const explicit = clean(data.outcome || details.outcome || source.outcome || source.meetingOutcome);
  if (explicit) return explicit.toLowerCase();
  if (eventType === 'lead_won') return 'won';
  if (eventType === 'lead_lost') return 'lost';
  if (eventType === 'agreement_signed') return 'signed';
  if (eventType === 'agreement_declined') return 'declined';
  if (eventType === 'email_sent') return 'sent';
  if (eventType === 'email_received') return 'received';
  if (eventType === 'meeting_no_show') return 'no_show';
  if (eventType === 'meeting_rescheduled') return 'rescheduled';
  return '';
}

function stageFields(data = {}) {
  const details = data.details || {};
  return {
    previousStage: clean(data.previousStage || details.previousStage || details.fromStage),
    nextStage: clean(data.nextStage || data.stage || details.nextStage || details.toStage || details.stage),
  };
}

function visible(uid, actorData, data = {}) {
  if (isPlatformAdminUser(actorData)) return true;
  const repId = clean(String(actorData?.repId ?? ''));
  return data.ownerUid === uid || data.assignedToUid === uid ||
    (Array.isArray(data.viewerUids) && data.viewerUids.includes(uid)) ||
    (repId && Array.isArray(data.teamRepIds) && data.teamRepIds.map(String).includes(repId));
}

async function uniqueLeadFromReferences(db, personRef, organizationRef) {
  const candidates = new Map();
  async function add(field, ref, operator = '==') {
    if (!ref) return;
    const snap = await db.collection(LEADS).where(field, operator, ref).limit(3).get();
    for (const doc of snap.docs) {
      const data = doc.data() || {};
      if (data.archived !== true) candidates.set(doc.ref.path, { ref: doc.ref, data });
    }
  }
  await Promise.all([
    add('subjectPersonRef', personRef),
    add('primaryContactRef', personRef),
    add('connectedPersonRefs', personRef, 'array-contains'),
    add('subjectOrganizationRef', organizationRef),
  ]);
  return candidates.size === 1 ? [...candidates.values()][0] : null;
}

async function resolveLead(db, data = {}, source = {}) {
  const explicit = data.leadRef || source.leadRef || null;
  if (explicit) {
    const ref = db.doc(path(explicit, LEADS, 'leadRef', true));
    const snap = await ref.get();
    return snap.exists ? { ref, data: snap.data() || {} } : null;
  }
  return uniqueLeadFromReferences(
    db,
    data.personRef || source.personRef || null,
    data.organizationRef || source.organizationRef || null
  );
}

async function sourceRecord(data = {}) {
  const ref = data.sourceRef || data.actionRef || data.callRef || data.threadRef || data.agreementRef || null;
  if (!ref?.get) return { ref, data: {} };
  const snap = await ref.get();
  return { ref, data: snap.exists ? (snap.data() || {}) : {} };
}

function normalizedPayload(data, source, lead, eventType) {
  const details = data.details || {};
  const eventAt = data.eventAt || data.createdAt || source.completedAt || source.sentAt || source.receivedAt || source.createdAt || serverTimestamp();
  let startedAt = data.startedAt || details.startedAt || source.callStartedAt || source.meetingStartedAt || null;
  let finishedAt = data.finishedAt || details.finishedAt || source.callFinishedAt || source.meetingFinishedAt || source.completedAt || null;
  if (!finishedAt && eventType === 'call_finished') finishedAt = eventAt;
  let durationSeconds = Number(data.durationSeconds ?? details.durationSeconds ?? source.durationSeconds);
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) durationSeconds = secondsBetween(startedAt, finishedAt);
  if (!startedAt && eventType === 'call_finished' && durationSeconds !== null) {
    const finishMs = milliseconds(finishedAt || eventAt);
    if (finishMs !== null) startedAt = admin.firestore.Timestamp.fromMillis(finishMs - durationSeconds * 1000);
  }
  const timing = eventType === 'action_completed' ? actionTiming(source) : { completedOnTime: null, completionTiming: '' };
  const stages = stageFields(data);
  if (!stages.nextStage && eventType === 'lead_won') stages.nextStage = 'Won';
  if (!stages.nextStage && eventType === 'lead_lost') stages.nextStage = 'Lost';
  const repRef = data.repRef || data.createdByRef || source.completedByRef || source.outcomeSetByRef || source.createdByRef || data.ownerRef || lead.data.assignedToRef || null;
  const repUid = clean(data.repUid || data.createdByUid || source.createdByUid || repRef?.id || data.ownerUid || lead.data.assignedToUid);
  const repName = clean(data.repName || data.createdByName || source.createdByName || source.outcomeSetByName || data.ownerName || lead.data.assignedToName);
  return {
    performanceVersion: VERSION,
    eventSchemaVersion: 2,
    performanceLinkStatus: 'linked',
    leadRef: lead.ref,
    leadName: clean(lead.data.displayName || lead.data.leadName || lead.data.name),
    eventType,
    eventAt,
    outcome: outcomeFor(eventType, data, source),
    repRef,
    repUid,
    repId: identifier(data.repId || source.repId),
    repName,
    personRef: data.contactRecordType ? (data.personRef || null) : (data.personRef || source.personRef || lead.data.subjectPersonRef || lead.data.primaryContactRef || null),
    personName: data.contactRecordType ? clean(data.personName) : clean(data.personName || source.personName || lead.data.subjectPersonName || lead.data.primaryContactName),
    organizationRef: data.organizationRef || source.organizationRef || lead.data.subjectOrganizationRef || null,
    organizationName: clean(data.organizationName || source.organizationName || lead.data.subjectOrganizationName),
    leadSource: clean(lead.data.source),
    leadListId: clean(lead.data.leadListId),
    leadListName: clean(lead.data.leadListName),
    industry: clean(data.industry || source.industry || lead.data.industry),
    meetingRef: data.meetingRef || (clean(source.actionType).toLowerCase() === 'meeting' ? (data.actionRef || data.sourceRef || null) : null),
    meetingType: clean(data.meetingType || details.meetingType || source.meetingType),
    presentationType: clean(data.presentationType || details.presentationType || source.presentationType),
    presentationRef: data.presentationRef || source.presentationRef || null,
    presentationTotalDurationSeconds: Number(data.totalDurationSeconds ?? details.totalDurationSeconds ?? source.totalDurationSeconds) || null,
    presentationPageDurationsSeconds: data.pageDurationsSeconds || details.pageDurationsSeconds || source.pageDurationsSeconds || null,
    presentationPageVisitCounts: data.pageVisitCounts || details.pageVisitCounts || source.pageVisitCounts || null,
    locationType: clean(data.locationType || details.locationType || source.locationType),
    mainBlocker: clean(data.mainBlocker || details.mainBlocker || source.mainBlocker),
    scheduledStartAt: data.scheduledStartAt || details.scheduledStartAt || source.startAt || null,
    scheduledEndAt: data.scheduledEndAt || details.scheduledEndAt || source.endAt || null,
    previousStage: stages.previousStage,
    nextStage: stages.nextStage,
    startedAt,
    finishedAt,
    durationSeconds,
    completedOnTime: timing.completedOnTime,
    completionTiming: timing.completionTiming,
    lostReason: clean(data.lostReason || details.lostReason || source.lostReason),
  };
}

async function enrichRepId(payload) {
  if (payload.repId || payload.repRef?.parent?.id !== 'users') return payload;
  const snap = await payload.repRef.get();
  return { ...payload, repId: identifier(snap.data()?.repId) };
}

function isAttempt(eventType) {
  return ['call_finished', 'email_sent'].includes(eventType);
}

function isMeaningful(eventType, outcome) {
  const value = clean(outcome).toLowerCase();
  return eventType === 'email_received' || eventType === 'meeting_finished' ||
    eventType === 'agreement_signed' ||
    (eventType === 'call_finished' && ['connected', 'answered', 'booked'].includes(value));
}

async function updateLeadMilestones(db, lead, payload, sourceRef) {
  const leadRef = lead.ref;
  await db.runTransaction(async transaction => {
    const snap = await transaction.get(leadRef);
    if (!snap.exists) return;
    const current = snap.data() || {};
    const update = {};
    const currentActivityMs = milliseconds(current.lastActivityAt);
    const eventMs = milliseconds(payload.eventAt);
    if (currentActivityMs === null || eventMs === null || eventMs >= currentActivityMs) {
      update.lastActivityAt = payload.eventAt;
      update.lastActivityType = payload.eventType;
      update.lastActivityOutcome = payload.outcome;
      update.updatedAt = serverTimestamp();
    }
    if (isAttempt(payload.eventType) && !current.firstAttemptAt) {
      const attemptAt = payload.eventType === 'call_finished' && payload.startedAt
        ? payload.startedAt
        : payload.eventAt;
      update.firstAttemptAt = attemptAt;
      update.firstAttemptType = payload.eventType;
      const ref = db.collection(CONNECTIONS).doc(`lead_first_attempt_${leadRef.id}`);
      transaction.set(ref, {
        ...payload,
        eventType: 'first_attempt', type: 'first_attempt',
        summary: `First attempt: ${clean(current.displayName)}`,
        sourceRef: sourceRef || leadRef,
        deduplicationKey: `first_attempt:${leadRef.id}`,
        performanceVersion: VERSION,
        eventAt: attemptAt,
        createdAt: attemptAt,
      }, { merge: true });
    }
    if (isMeaningful(payload.eventType, payload.outcome) && (milliseconds(current.lastMeaningfulConnectionAt) === null || eventMs >= milliseconds(current.lastMeaningfulConnectionAt))) {
      update.lastMeaningfulConnectionAt = payload.eventAt;
    }
    if (isMeaningful(payload.eventType, payload.outcome) && !current.firstMeaningfulConnectionAt) {
      update.firstMeaningfulConnectionAt = payload.eventAt;
      update.firstMeaningfulConnectionType = payload.eventType;
      const ref = db.collection(CONNECTIONS).doc(`lead_first_meaningful_connection_${leadRef.id}`);
      transaction.set(ref, {
        ...payload,
        eventType: 'first_meaningful_connection', type: 'first_meaningful_connection',
        summary: `First meaningful connection: ${clean(current.displayName)}`,
        sourceRef: sourceRef || leadRef,
        deduplicationKey: `first_meaningful_connection:${leadRef.id}`,
        performanceVersion: VERSION,
        createdAt: payload.eventAt,
      }, { merge: true });
    }
    if (Object.keys(update).length) transaction.update(leadRef, update);
  });
}

async function createDerivedCallStart(db, connectionRef, data, payload) {
  if (payload.eventType !== 'call_finished' || !payload.startedAt || data.details?.hasExplicitStart === true) return;
  const ref = db.collection(CONNECTIONS).doc(`performance_call_started_${connectionRef.id}`);
  await ref.set({
    ...data,
    ...payload,
    type: 'call_started',
    eventType: 'call_started',
    eventAt: payload.startedAt,
    outcome: '',
    finishedAt: null,
    durationSeconds: null,
    summary: `Call started: ${payload.leadName}`,
    sourceRef: data.sourceRef || data.callRef || connectionRef,
    deduplicationKey: `call_started:${connectionRef.id}`,
    performanceVersion: VERSION,
    createdAt: payload.startedAt,
  }, { merge: true });
}

async function normalizeConnection(snapshot) {
  if (!snapshot?.exists) return;
  const data = snapshot.data() || {};
  if (data.performanceVersion === VERSION) return;
  const eventType = canonicalEventType(data.eventType || data.type);
  if (!eventType) return;
  const db = admin.firestore();
  const source = await sourceRecord(data);
  const lead = await resolveLead(db, data, source.data);
  if (!lead) {
    if (data.performanceLinkStatus === 'unlinked') return;
    await snapshot.ref.set({ performanceLinkStatus: 'unlinked' }, { merge: true });
    return;
  }
  const payload = await enrichRepId(normalizedPayload(data, source.data, lead, eventType));
  await snapshot.ref.set(payload, { merge: true });
  await createDerivedCallStart(db, snapshot.ref, data, payload);
  await updateLeadMilestones(db, lead, payload, source.ref || snapshot.ref);
}

exports.commandConnectionLeadPerformance = onDocumentWritten(
  { region: 'us-central1', document: `${CONNECTIONS}/{connectionId}` },
  async event => normalizeConnection(event.data?.after)
);

async function trackActionCreated(event) {
  const snapshot = event.data;
  if (!snapshot?.exists) return;
  const data = snapshot.data() || {};
  // Meetings have their own booked lifecycle event and should not count twice as Actions.
  if (clean(data.actionType).toLowerCase() === 'meeting') return;
  const ref = admin.firestore().collection(CONNECTIONS).doc(`action_created_${snapshot.id}`);
  await ref.set({
    type: 'action_created',
    summary: `Action created: ${clean(data.title)}`,
    body: clean(data.description),
    details: { dueAt: data.dueAt || null, priority: clean(data.priority) },
    actionRef: snapshot.ref,
    sourceRef: snapshot.ref,
    ...(data.leadRef ? { leadRef: data.leadRef } : {}),
    personRef: data.personRef || null,
    personName: clean(data.personName),
    organizationRef: data.organizationRef || null,
    organizationName: clean(data.organizationName),
    ownerRef: data.ownerRef || null,
    ownerUid: clean(data.ownerUid),
    ownerName: clean(data.ownerName),
    assignedToRef: data.assignedToRef || null,
    assignedToUid: clean(data.assignedToUid),
    assignedToName: clean(data.assignedToName),
    teamRepIds: data.teamRepIds || [],
    viewerUids: data.viewerUids || [],
    createdAt: data.createdAt || serverTimestamp(),
    createdByRef: data.createdByRef || null,
    createdByUid: clean(data.createdByUid),
    createdByName: clean(data.createdByName),
    deduplicationKey: `action_created:${snapshot.id}`,
  }, { merge: true });
}

exports.commandActionCreatedPerformance = onDocumentCreated(
  { region: 'us-central1', document: `${ACTIONS}/{actionId}` },
  trackActionCreated
);

function agreementEventPayload(ref, data, lead, eventType, eventAt, outcome) {
  const declineReason = eventType === 'agreement_declined' ? clean(data.declineReason) : '';
  return {
    performanceVersion: VERSION,
    type: eventType,
    eventType,
    eventAt,
    outcome,
    summary: `${eventType.replaceAll('_', ' ')}: ${clean(lead.data.displayName)}`,
    body: declineReason,
    details: declineReason ? { declineReason } : {},
    sourceRef: ref,
    agreementRef: ref,
    meetingRef: data.meetingRef || null,
    leadRef: lead.ref,
    leadName: clean(lead.data.displayName),
    repRef: data.createdByRef || data.ownerRef || lead.data.assignedToRef || null,
    repUid: clean(data.createdByUid || data.ownerUid || lead.data.assignedToUid),
    repId: '',
    repName: clean(data.ownerName || lead.data.assignedToName),
    personRef: data.signerPersonRef || data.personRef || lead.data.subjectPersonRef || lead.data.primaryContactRef || null,
    primaryContactRef: data.primaryContactRef || lead.data.primaryContactRef || null,
    signerPersonRef: data.signerPersonRef || data.personRef || null,
    personName: clean(data.signerPersonName || data.contactName || lead.data.subjectPersonName || lead.data.primaryContactName),
    organizationRef: data.organizationRef || lead.data.subjectOrganizationRef || null,
    organizationName: clean(data.organizationName || lead.data.subjectOrganizationName),
    leadSource: clean(lead.data.source),
    leadListId: clean(lead.data.leadListId),
    leadListName: clean(lead.data.leadListName),
    previousStage: '', nextStage: '', startedAt: null, finishedAt: eventAt,
    durationSeconds: null, completedOnTime: null, completionTiming: '', lostReason: '',
    ownerRef: data.ownerRef || null, ownerUid: clean(data.ownerUid), ownerName: clean(data.ownerName),
    viewerUids: data.viewerUids || lead.data.viewerUids || [],
    teamRepIds: data.teamRepIds || lead.data.teamRepIds || [],
    createdAt: eventAt,
    createdByRef: data.createdByRef || data.ownerRef || null,
    createdByUid: clean(data.createdByUid || data.ownerUid),
    createdByName: clean(data.ownerName),
    deduplicationKey: `${eventType}:${ref.id}`,
  };
}

async function trackAgreementChange(event) {
  const after = event.data?.after;
  if (!after?.exists) return;
  const data = after.data() || {}; const before = event.data?.before?.data() || {};
  const db = admin.firestore(); const lead = await resolveLead(db, data, data);
  if (!lead) return;
  const events = [];
  if (!before.initialEmailSentAt && data.initialEmailSentAt) events.push(['agreement_sent', data.initialEmailSentAt, 'sent']);
  if (before.status !== data.status && data.status === 'signed') events.push(['agreement_signed', data.signedAt || data.updatedAt || serverTimestamp(), 'signed']);
  if (before.status !== data.status && data.status === 'declined') events.push(['agreement_declined', data.declinedAt || data.updatedAt || serverTimestamp(), 'declined']);
  for (const [type, at, outcome] of events) {
    const ref = db.collection(CONNECTIONS).doc(`${type}_${after.id}`);
    const payload = await enrichRepId(agreementEventPayload(after.ref, data, lead, type, at, outcome));
    await ref.set(payload, { merge: true });
    await updateLeadMilestones(db, lead, payload, after.ref);
  }
}

exports.commandAgreementLeadPerformance = onDocumentWritten(
  { region: 'us-central1', document: `${AGREEMENTS}/{agreementId}` },
  trackAgreementChange
);

async function commandContext(request) {
  const db = admin.firestore(); const uid = requireAuth(request);
  const actor = await requireCommandAccess(db, uid);
  return { db, uid, actor, input: request.data || {} };
}

function meetingLifecycleStatus(data = {}) {
  const actionStatus = clean(data.status).toLowerCase();
  const outcome = clean(data.meetingOutcome).toLowerCase();
  if (actionStatus === 'cancelled' || outcome === 'cancelled') return 'cancelled';
  if (actionStatus === 'completed') return outcome === 'no_show' ? 'no_show' : 'completed';
  const explicit = clean(data.meetingStatus).toLowerCase();
  if (['scheduled', 'in_progress', 'completed', 'no_show', 'cancelled'].includes(explicit)) return explicit;
  if (data.meetingStartedAt) return 'in_progress';
  return 'scheduled';
}

async function startCommandMeetingService(request) {
  const ctx = await commandContext(request);
  const ref = ctx.db.doc(path(ctx.input.meetingRefPath || ctx.input.actionRefPath, ACTIONS, 'meetingRefPath', true));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Meeting not found.');
  const data = snap.data() || {};
  if (!visible(ctx.uid, ctx.actor.userData, data)) throw new HttpsError('permission-denied', 'You do not have access to this Meeting.');
  if (clean(data.actionType).toLowerCase() !== 'meeting') throw new HttpsError('failed-precondition', 'This Action is not a Meeting.');
  const currentStatus = meetingLifecycleStatus(data);
  if (currentStatus === 'in_progress') return { ok: true, duplicate: true, meetingRefPath: ref.path, meetingStatus: currentStatus, meetingType: clean(data.meetingType), presentationType: clean(data.presentationType), leadRefPath: refPath(data.leadRef), personRefPath: refPath(data.personRef), organizationRefPath: refPath(data.organizationRef), meetingLink: clean(data.meetingLink), locationType: clean(data.locationType) };
  if (currentStatus !== 'scheduled') throw new HttpsError('failed-precondition', 'Only scheduled Meetings can be started.');
  const explicitLeadPath = clean(ctx.input.leadRefPath);
  const lead = explicitLeadPath
    ? await resolveLead(ctx.db, { leadRef: ctx.db.doc(path(explicitLeadPath, LEADS, 'leadRefPath', true)) }, data)
    : await resolveLead(ctx.db, data, data);
  if (lead && !visible(ctx.uid, ctx.actor.userData, lead.data)) throw new HttpsError('permission-denied', 'You do not have access to this Lead.');
  const connectionRef = ctx.db.collection(CONNECTIONS).doc(`meeting_started_${ref.id}`);
  let duplicate = false;
  await ctx.db.runTransaction(async transaction => {
    const currentSnap = await transaction.get(ref); const current = currentSnap.data() || {};
    if (!currentSnap.exists) throw new HttpsError('aborted', 'This Meeting changed. Refresh and try again.');
    const status = meetingLifecycleStatus(current);
    if (status === 'in_progress') { duplicate = true; return; }
    if (status !== 'scheduled') throw new HttpsError('aborted', 'This Meeting changed. Refresh and try again.');
    const at = admin.firestore.Timestamp.now();
    transaction.update(ref, { meetingStatus: 'in_progress', meetingStartedAt: at, meetingStartedByRef: ctx.actor.userRef, ...(lead ? { leadRef: lead.ref } : {}), updatedAt: at, updatedByRef: ctx.actor.userRef });
    transaction.set(connectionRef, {
      type: 'meeting_started', summary: `Meeting started: ${clean(current.title)}`, body: '', details: { meetingType: clean(current.meetingType), presentationType: clean(current.presentationType), locationType: clean(current.locationType), scheduledStartAt: current.startAt || null, scheduledEndAt: current.endAt || null },
      actionRef: ref, sourceRef: ref, ...(lead ? { leadRef: lead.ref } : {}),
      personRef: current.personRef || null, personName: clean(current.personName),
      organizationRef: current.organizationRef || null, organizationName: clean(current.organizationName),
      ownerRef: current.ownerRef || ctx.actor.userRef, ownerUid: clean(current.ownerUid || ctx.uid), ownerName: clean(current.ownerName),
      createdByRef: ctx.actor.userRef, createdByUid: ctx.uid,
      createdByName: clean(ctx.actor.userData.fullName || ctx.actor.userData.displayName || ctx.actor.userData.email),
      viewerUids: unique([...(current.viewerUids || []), ctx.uid]), teamRepIds: current.teamRepIds || [], createdAt: at,
    }, { merge: true });
  });
  return { ok: true, duplicate, meetingRefPath: ref.path, meetingStatus: 'in_progress', meetingType: clean(data.meetingType), presentationType: clean(data.presentationType), leadRefPath: lead?.ref.path || '', personRefPath: refPath(data.personRef), organizationRefPath: refPath(data.organizationRef), meetingLink: clean(data.meetingLink), locationType: clean(data.locationType) };
}

exports.startCommandMeeting = onCall(
  { region: 'us-central1', cors: true, timeoutSeconds: 120, memory: '512MiB' },
  startCommandMeetingService
);

async function readVisibleLead(ctx, rawPath) {
  const ref = ctx.db.doc(path(rawPath, LEADS, 'leadRefPath', true));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Lead not found.');
  const data = snap.data() || {};
  if (!visible(ctx.uid, ctx.actor.userData, data)) throw new HttpsError('permission-denied', 'You do not have access to this Lead.');
  if (data.archived === true || clean(data.status) !== 'active') throw new HttpsError('failed-precondition', 'Only active Leads can be called.');
  return { ref, data };
}

function callContextFields(lead) {
  return {
    leadRef: lead.ref,
    leadName: clean(lead.data.displayName),
    personRef: lead.data.subjectPersonRef || lead.data.primaryContactRef || null,
    personName: clean(lead.data.subjectPersonName || lead.data.primaryContactName),
    organizationRef: lead.data.subjectOrganizationRef || null,
    organizationName: clean(lead.data.subjectOrganizationName),
    ownerRef: lead.data.ownerRef || null,
    ownerUid: clean(lead.data.ownerUid),
    ownerName: clean(lead.data.ownerName),
    assignedToRef: lead.data.assignedToRef || null,
    assignedToUid: clean(lead.data.assignedToUid),
    assignedToName: clean(lead.data.assignedToName),
    viewerUids: lead.data.viewerUids || [],
    teamRepIds: lead.data.teamRepIds || [],
  };
}

const { startService: startCommandLeadCallService, finishService: finishCommandLeadCallService } = require('./commandOutreachCalls');

exports.startCommandLeadCall = onCall(
  { region: 'us-central1', cors: true, timeoutSeconds: 120, memory: '512MiB' },
  startCommandLeadCallService
);

exports.finishCommandLeadCall = onCall(
  { region: 'us-central1', cors: true, timeoutSeconds: 120, memory: '512MiB' },
  finishCommandLeadCallService
);

function signingTokenHash(token) {
  return crypto.createHash('sha256').update(clean(token)).digest('hex');
}

async function declineCommandAgreementService(request) {
  const token = clean(request.data?.token);
  if (token.length < 20) throw new HttpsError('permission-denied', 'This signing link is invalid.');
  const reason = clean(request.data?.reason);
  if (reason.length > 1000) throw new HttpsError('invalid-argument', 'Decline reason must be 1,000 characters or fewer.');
  const db = admin.firestore(); const tokenRef = db.collection(TOKENS).doc(signingTokenHash(token));
  await db.runTransaction(async transaction => {
    const tokenSnap = await transaction.get(tokenRef);
    if (!tokenSnap.exists || tokenSnap.data()?.active !== true) throw new HttpsError('permission-denied', 'This signing link is invalid or no longer active.');
    const agreementRef = tokenSnap.data().agreementRef;
    const agreementSnap = await transaction.get(agreementRef);
    if (!agreementSnap.exists) throw new HttpsError('not-found', 'Agreement not found.');
    const data = agreementSnap.data() || {};
    if (data.status !== 'pending') throw new HttpsError('failed-precondition', 'This Agreement is no longer awaiting a response.');
    const at = serverTimestamp();
    transaction.update(agreementRef, { status: 'declined', declinedAt: at, declineReason: reason, updatedAt: at });
    transaction.update(tokenRef, { active: false, declinedAt: at });
    if (data.meetingRef) transaction.set(data.meetingRef, { agreementRef, agreementStatus: 'declined', agreementDeclinedAt: at, updatedAt: at }, { merge: true });
    if (data.leadRef) transaction.set(data.leadRef, { lastAgreementRef: agreementRef, lastAgreementStatus: 'declined', lastAgreementAt: at, updatedAt: at }, { merge: true });
  });
  return { ok: true, status: 'declined' };
}

exports.declineCommandAgreement = onCall(
  { region: 'us-central1', cors: true, timeoutSeconds: 120, memory: '512MiB' },
  declineCommandAgreementService
);

exports._test = {
  canonicalEventType,
  milliseconds,
  secondsBetween,
  actionTiming,
  outcomeFor,
  stageFields,
  isAttempt,
  isMeaningful,
  callContextFields,
  meetingLifecycleStatus,
};

