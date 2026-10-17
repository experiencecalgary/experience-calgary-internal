'use strict';

const crypto = require('node:crypto');
const admin = require('firebase-admin');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { requireAuth, requireCommandAccess, isPlatformAdminUser } = require('../../lib/command/commandPersonUtils');

const REGION = 'us-central1';
const MEETINGS = 'commandActions';
const LEADS = 'commandLeads';
const ORGANIZATIONS = 'commandOrganizations';
const PEOPLE = 'commandPeople';
const PRESENTATIONS = 'commandPartnerPresentations';
const CONNECTIONS = 'commandConnections';
const MAX_PAGE_SECONDS = 2 * 60 * 60;
const SLIDES = Object.freeze([
  'opening',
  'partnership_glance',
  'experience_calgary',
  'opportunity',
  'signal_decay',
  'vip_revival',
  'partner_advantage',
  'thirty_day_story',
  'complete_partnership',
  'partnership_options',
  'invitation',
]);
const callable = handler => onCall({ region: REGION, cors: true, timeoutSeconds: 120, memory: '512MiB' }, handler);
const clean = value => typeof value === 'string' ? value.trim() : '';
const refPath = value => clean(value?.path || value);
const now = () => admin.firestore.Timestamp.now();
const iso = value => value?.toDate ? value.toDate().toISOString() : null;

function documentPath(value, collection, field) {
  const parts = refPath(value).split('/').filter(Boolean);
  if (parts.length !== 2 || parts[0] !== collection) {
    throw new HttpsError('invalid-argument', `${field} must use ${collection}/{documentId}.`);
  }
  return parts.join('/');
}

function visible(uid, actorData, data = {}) {
  if (isPlatformAdminUser(actorData)) return true;
  const repId = clean(String(actorData?.repId ?? ''));
  return data.ownerUid === uid || data.assignedToUid === uid ||
    (Array.isArray(data.viewerUids) && data.viewerUids.includes(uid)) ||
    (repId && Array.isArray(data.teamRepIds) && data.teamRepIds.map(String).includes(repId));
}

function slide(index, key = '') {
  const value = Number(index);
  if (!Number.isInteger(value) || value < 0 || value >= SLIDES.length) {
    throw new HttpsError('invalid-argument', `pageIndex must be between 0 and ${SLIDES.length - 1}.`);
  }
  if (clean(key) && clean(key) !== SLIDES[value]) {
    throw new HttpsError('invalid-argument', 'pageKey does not match pageIndex.');
  }
  return { index: value, key: SLIDES[value] };
}

function eventId(value) {
  const raw = clean(value);
  if (!raw || raw.length > 200) throw new HttpsError('invalid-argument', 'clientEventId is required and must be 200 characters or fewer.');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function durationSeconds(start, finish) {
  if (!start?.toMillis || !finish?.toMillis) return 0;
  return Math.max(0, Math.round((finish.toMillis() - start.toMillis()) / 1000));
}

function meetingStatus(data = {}) {
  if (clean(data.status).toLowerCase() === 'completed') return 'completed';
  if (clean(data.status).toLowerCase() === 'cancelled') return 'cancelled';
  if (clean(data.meetingStatus).toLowerCase() === 'in_progress' || data.meetingStartedAt) return 'in_progress';
  return clean(data.meetingStatus).toLowerCase() || 'scheduled';
}

function assertActivePartnershipMeeting(data = {}) {
  if (clean(data.actionType).toLowerCase() !== 'meeting' ||
      clean(data.meetingType).toLowerCase() !== 'partnership' ||
      meetingStatus(data) !== 'in_progress') {
    throw new HttpsError('failed-precondition', 'The Partnership Meeting must still be in progress.');
  }
}

function assertMeetingContextUnchanged(data = {}, expected = {}) {
  for (const field of ['leadRef', 'organizationRef', 'personRef']) {
    if (refPath(data[field]) !== refPath(expected[field])) {
      throw new HttpsError('aborted', 'The Meeting context changed. Refresh before continuing the presentation.');
    }
  }
}

function actorName(ctx) {
  const data = ctx.actor?.userData || {};
  return clean(data.fullName || data.displayName || data.name || data.email);
}

async function context(request) {
  const db = admin.firestore();
  const uid = requireAuth(request);
  const actor = await requireCommandAccess(db, uid);
  return { db, uid, actor, input: request.data || {} };
}

async function readPresentationMeeting(ctx) {
  const ref = ctx.db.doc(documentPath(ctx.input.meetingRefPath, MEETINGS, 'meetingRefPath'));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Meeting not found.');
  const data = snap.data() || {};
  if (!visible(ctx.uid, ctx.actor.userData, data)) throw new HttpsError('permission-denied', 'You do not have access to this Meeting.');
  if (clean(data.actionType).toLowerCase() !== 'meeting') throw new HttpsError('failed-precondition', 'This Action is not a Meeting.');
  if (clean(data.meetingType).toLowerCase() !== 'partnership') throw new HttpsError('failed-precondition', 'Only Partnership Meetings use the Partner Reveal presentation.');
  if (!data.leadRef || !data.organizationRef) throw new HttpsError('failed-precondition', 'The Partnership Meeting must have a Lead and Organization.');
  return { ref, data };
}

async function readRelated(ref, label) {
  if (!ref?.get) throw new HttpsError('failed-precondition', `${label} is missing.`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('failed-precondition', `${label} no longer exists.`);
  return { ref, data: snap.data() || {} };
}

function organizationPayload(record) {
  const data = record.data;
  return {
    refPath: record.ref.path,
    id: record.ref.id,
    name: clean(data.organization || data.name || data.displayName),
    website: clean(data.website || data.websiteUrl),
    logoUrl: clean(data.logoUrl),
    heroImageUrl: clean(data.heroImageUrl),
    brandColorHex: clean(data.brandColorHex),
    galleryImageUrls: Array.isArray(data.galleryImageUrls) ? data.galleryImageUrls.filter(value => clean(value)) : [],
    address: clean(data.address || data.fullAddress),
    industry: clean(data.industry),
  };
}

function personPayload(record) {
  if (!record) return null;
  const data = record.data;
  return {
    refPath: record.ref.path,
    id: record.ref.id,
    name: clean(data.fullName) || [clean(data.firstName), clean(data.lastName)].filter(Boolean).join(' ') || clean(data.displayName),
    firstName: clean(data.firstName),
    email: clean(data.emailNormalized || data.email),
    phone: clean(data.phoneNormalized || data.phone),
  };
}

function leadPayload(record) {
  const data = record.data;
  return {
    refPath: record.ref.path,
    id: record.ref.id,
    name: clean(data.displayName),
    leadType: clean(data.leadType),
    stage: clean(data.stage),
    status: clean(data.status),
    source: clean(data.source),
    leadListId: clean(data.leadListId),
    leadListName: clean(data.leadListName),
  };
}

function sessionPayload(ref, data = {}) {
  return {
    refPath: ref.path,
    status: clean(data.status),
    currentPageIndex: Number.isInteger(data.currentPageIndex) ? data.currentPageIndex : null,
    currentPageKey: clean(data.currentPageKey),
    pageDurationsSeconds: data.pageDurationsSeconds || {},
    pageVisitCounts: data.pageVisitCounts || {},
    navigationCount: Number(data.navigationCount) || 0,
    activeDurationSeconds: Number(data.activeDurationSeconds) || 0,
    totalDurationSeconds: Number(data.totalDurationSeconds) || 0,
    timingAnomalyCount: Number(data.timingAnomalyCount) || 0,
    startedAt: iso(data.startedAt),
    completedAt: iso(data.completedAt),
  };
}

function baseSession(ctx, meeting, lead, organization, person, at) {
  return {
    schemaVersion: 1,
    presentationType: clean(meeting.data.presentationType) || 'partner_reveal',
    status: 'in_progress',
    meetingRef: meeting.ref,
    meetingType: 'partnership',
    locationType: clean(meeting.data.locationType),
    scheduledStartAt: meeting.data.startAt || null,
    scheduledEndAt: meeting.data.endAt || null,
    meetingStartedAt: meeting.data.meetingStartedAt || null,
    leadRef: lead.ref,
    leadName: clean(lead.data.displayName),
    leadSource: clean(lead.data.source),
    leadListId: clean(lead.data.leadListId),
    leadListName: clean(lead.data.leadListName),
    organizationRef: organization.ref,
    organizationName: clean(organization.data.organization || organization.data.name || organization.data.displayName),
    industry: clean(organization.data.industry || lead.data.industry),
    personRef: person?.ref || null,
    personName: clean(person?.data?.fullName) ||
      [clean(person?.data?.firstName), clean(person?.data?.lastName)].filter(Boolean).join(' ') ||
      clean(person?.data?.displayName),
    ownerRef: meeting.data.ownerRef || ctx.actor.userRef,
    ownerUid: clean(meeting.data.ownerUid) || ctx.uid,
    ownerName: clean(meeting.data.ownerName),
    assignedToRef: meeting.data.assignedToRef || ctx.actor.userRef,
    assignedToUid: clean(meeting.data.assignedToUid) || ctx.uid,
    assignedToName: clean(meeting.data.assignedToName),
    teamRepIds: meeting.data.teamRepIds || [],
    viewerUids: meeting.data.viewerUids || [ctx.uid],
    startedAt: at,
    startedByRef: ctx.actor.userRef,
    startedByUid: ctx.uid,
    currentPageIndex: null,
    currentPageKey: '',
    currentPageEnteredAt: null,
    pageDurationsSeconds: {},
    pageVisitCounts: {},
    navigationCount: 0,
    activeDurationSeconds: 0,
    timingAnomalyCount: 0,
    createdAt: at,
    updatedAt: at,
  };
}

async function relatedContext(ctx, meeting) {
  const [lead, organization, person] = await Promise.all([
    readRelated(meeting.data.leadRef, 'Lead'),
    readRelated(meeting.data.organizationRef, 'Organization'),
    meeting.data.personRef ? readRelated(meeting.data.personRef, 'Person') : null,
  ]);
  if (!visible(ctx.uid, ctx.actor.userData, lead.data)) throw new HttpsError('permission-denied', 'You do not have access to this Lead.');
  return { lead, organization, person };
}

async function getCommandPartnerPresentationContextService(request) {
  const ctx = await context(request);
  const meeting = await readPresentationMeeting(ctx);
  const related = await relatedContext(ctx, meeting);
  const presentationRef = ctx.db.collection(PRESENTATIONS).doc(meeting.ref.id);
  const presentationSnap = await presentationRef.get();
  return {
    ok: true,
    meeting: {
      refPath: meeting.ref.path,
      title: clean(meeting.data.title),
      status: meetingStatus(meeting.data),
      locationType: clean(meeting.data.locationType),
      meetingLink: clean(meeting.data.meetingLink),
      actualStartAt: iso(meeting.data.meetingStartedAt),
    },
    lead: leadPayload(related.lead),
    organization: organizationPayload(related.organization),
    person: personPayload(related.person),
    presentation: presentationSnap.exists ? sessionPayload(presentationRef, presentationSnap.data() || {}) : null,
  };
}

async function startCommandPartnerPresentationService(request) {
  const ctx = await context(request);
  const meeting = await readPresentationMeeting(ctx);
  if (meetingStatus(meeting.data) !== 'in_progress') throw new HttpsError('failed-precondition', 'Start the Meeting before starting its presentation.');
  const related = await relatedContext(ctx, meeting);
  const presentationRef = ctx.db.collection(PRESENTATIONS).doc(meeting.ref.id);
  const connectionRef = ctx.db.collection(CONNECTIONS).doc(`presentation_started_${meeting.ref.id}`);
  const at = now();
  let duplicate = false;
  await ctx.db.runTransaction(async transaction => {
    const [snap, liveMeetingSnap] = await Promise.all([
      transaction.get(presentationRef),
      transaction.get(meeting.ref),
    ]);
    if (!liveMeetingSnap.exists) throw new HttpsError('not-found', 'Meeting not found.');
    const liveMeeting = liveMeetingSnap.data() || {};
    assertActivePartnershipMeeting(liveMeeting);
    assertMeetingContextUnchanged(liveMeeting, meeting.data);
    if (snap.exists) { duplicate = true; return; }
    const data = baseSession(ctx, meeting, related.lead, related.organization, related.person, at);
    transaction.create(presentationRef, data);
    transaction.set(meeting.ref, { presentationRef, presentationStatus: 'in_progress', presentationStartedAt: at, updatedAt: at, updatedByRef: ctx.actor.userRef }, { merge: true });
    transaction.set(connectionRef, {
      type: 'presentation_started', eventType: 'presentation_started', summary: `Partner Reveal started: ${data.organizationName}`,
      body: '', details: { presentationType: data.presentationType, locationType: data.locationType },
      sourceRef: presentationRef, presentationRef, meetingRef: meeting.ref, actionRef: meeting.ref,
      leadRef: related.lead.ref, leadName: data.leadName,
      personRef: related.person?.ref || null, personName: data.personName,
      organizationRef: related.organization.ref, organizationName: data.organizationName,
      ownerRef: data.ownerRef, ownerUid: data.ownerUid, ownerName: data.ownerName,
      assignedToRef: data.assignedToRef, assignedToUid: data.assignedToUid, assignedToName: data.assignedToName,
      teamRepIds: data.teamRepIds, viewerUids: data.viewerUids,
      createdAt: at, createdByRef: ctx.actor.userRef, createdByUid: ctx.uid,
      createdByName: actorName(ctx),
    }, { merge: true });
  });
  const snap = await presentationRef.get();
  return { ok: true, duplicate, presentation: sessionPayload(presentationRef, snap.data() || {}), organization: organizationPayload(related.organization), lead: leadPayload(related.lead), person: personPayload(related.person) };
}

function closeCurrentPage(data, at) {
  const index = Number.isInteger(data.currentPageIndex) ? data.currentPageIndex : null;
  if (index === null || !data.currentPageEnteredAt?.toMillis) return { data, closed: null };
  const key = SLIDES[index];
  const rawSeconds = durationSeconds(data.currentPageEnteredAt, at);
  const seconds = Math.min(rawSeconds, MAX_PAGE_SECONDS);
  const durations = { ...(data.pageDurationsSeconds || {}) };
  durations[key] = (Number(durations[key]) || 0) + seconds;
  return {
    data: {
      ...data,
      pageDurationsSeconds: durations,
      activeDurationSeconds: (Number(data.activeDurationSeconds) || 0) + seconds,
      timingAnomalyCount: (Number(data.timingAnomalyCount) || 0) + (rawSeconds > MAX_PAGE_SECONDS ? 1 : 0),
      currentPageIndex: null,
      currentPageKey: '',
      currentPageEnteredAt: null,
    },
    closed: { index, key, enteredAt: data.currentPageEnteredAt, exitedAt: at, durationSeconds: seconds, rawDurationSeconds: rawSeconds, durationCapped: rawSeconds > MAX_PAGE_SECONDS },
  };
}

async function recordCommandPartnerPresentationPageService(request) {
  const ctx = await context(request);
  const meeting = await readPresentationMeeting(ctx);
  if (meetingStatus(meeting.data) !== 'in_progress') throw new HttpsError('failed-precondition', 'The Meeting must be in progress while presenting.');
  const requested = slide(ctx.input.pageIndex, ctx.input.pageKey);
  const id = eventId(ctx.input.clientEventId);
  const presentationRef = ctx.db.collection(PRESENTATIONS).doc(meeting.ref.id);
  const eventRef = presentationRef.collection('navigationEvents').doc(id);
  const visitRef = presentationRef.collection('pageVisits').doc(id);
  const at = now();
  let response;
  await ctx.db.runTransaction(async transaction => {
    const [presentationSnap, priorEvent, liveMeetingSnap] = await Promise.all([
      transaction.get(presentationRef),
      transaction.get(eventRef),
      transaction.get(meeting.ref),
    ]);
    if (priorEvent.exists) { response = priorEvent.data()?.result || {}; return; }
    if (!liveMeetingSnap.exists) throw new HttpsError('not-found', 'Meeting not found.');
    const liveMeeting = liveMeetingSnap.data() || {};
    assertActivePartnershipMeeting(liveMeeting);
    if (!presentationSnap.exists) throw new HttpsError('failed-precondition', 'Start the presentation first.');
    const current = presentationSnap.data() || {};
    assertMeetingContextUnchanged(liveMeeting, current);
    if (clean(current.status) === 'completed') throw new HttpsError('failed-precondition', 'This presentation is already complete.');
    const closed = closeCurrentPage(current, at);
    const counts = { ...(closed.data.pageVisitCounts || {}) };
    counts[requested.key] = (Number(counts[requested.key]) || 0) + 1;
    const update = {
      pageDurationsSeconds: closed.data.pageDurationsSeconds || {},
      activeDurationSeconds: Number(closed.data.activeDurationSeconds) || 0,
      timingAnomalyCount: Number(closed.data.timingAnomalyCount) || 0,
      pageVisitCounts: counts,
      currentPageIndex: requested.index,
      currentPageKey: requested.key,
      currentPageEnteredAt: at,
      navigationCount: (Number(current.navigationCount) || 0) + 1,
      lastInteractionAt: at,
      updatedAt: at,
    };
    transaction.update(presentationRef, update);
    if (closed.closed) transaction.set(visitRef, { ...closed.closed, presentationRef, meetingRef: meeting.ref, leadRef: current.leadRef, organizationRef: current.organizationRef, createdAt: at });
    response = { pageIndex: requested.index, pageKey: requested.key, navigationCount: update.navigationCount, activeDurationSeconds: update.activeDurationSeconds };
    transaction.create(eventRef, { type: 'page_entered', pageIndex: requested.index, pageKey: requested.key, at, result: response });
  });
  return { ok: true, presentationRefPath: presentationRef.path, ...response };
}

async function pauseCommandPartnerPresentationService(request) {
  const ctx = await context(request);
  const meeting = await readPresentationMeeting(ctx);
  const id = eventId(ctx.input.clientEventId);
  const presentationRef = ctx.db.collection(PRESENTATIONS).doc(meeting.ref.id);
  const eventRef = presentationRef.collection('navigationEvents').doc(id);
  const visitRef = presentationRef.collection('pageVisits').doc(id);
  const at = now(); let response;
  await ctx.db.runTransaction(async transaction => {
    const [snap, priorEvent] = await Promise.all([transaction.get(presentationRef), transaction.get(eventRef)]);
    if (priorEvent.exists) { response = priorEvent.data()?.result || {}; return; }
    if (!snap.exists) throw new HttpsError('failed-precondition', 'Start the presentation first.');
    const current = snap.data() || {};
    if (clean(current.status) === 'completed') { response = { duplicate: true, status: 'completed' }; transaction.create(eventRef, { type: 'pause_after_complete', at, result: response }); return; }
    const closed = closeCurrentPage(current, at);
    const update = { pageDurationsSeconds: closed.data.pageDurationsSeconds || {}, activeDurationSeconds: Number(closed.data.activeDurationSeconds) || 0, timingAnomalyCount: Number(closed.data.timingAnomalyCount) || 0, currentPageIndex: null, currentPageKey: '', currentPageEnteredAt: null, pausedAt: at, updatedAt: at };
    transaction.update(presentationRef, update);
    if (closed.closed) transaction.set(visitRef, { ...closed.closed, presentationRef, meetingRef: meeting.ref, leadRef: current.leadRef, organizationRef: current.organizationRef, createdAt: at });
    response = { status: 'paused', activeDurationSeconds: update.activeDurationSeconds };
    transaction.create(eventRef, { type: 'paused', at, result: response });
  });
  return { ok: true, presentationRefPath: presentationRef.path, ...response };
}

async function completeCommandPartnerPresentationService(request) {
  const ctx = await context(request);
  const meeting = await readPresentationMeeting(ctx);
  if (meetingStatus(meeting.data) !== 'in_progress') throw new HttpsError('failed-precondition', 'Complete the presentation before finishing the Meeting.');
  const id = eventId(ctx.input.clientEventId);
  const presentationRef = ctx.db.collection(PRESENTATIONS).doc(meeting.ref.id);
  const eventRef = presentationRef.collection('navigationEvents').doc(id);
  const visitRef = presentationRef.collection('pageVisits').doc(id);
  const connectionRef = ctx.db.collection(CONNECTIONS).doc(`presentation_completed_${meeting.ref.id}`);
  const at = now(); let response;
  await ctx.db.runTransaction(async transaction => {
    const [snap, priorEvent, liveMeetingSnap] = await Promise.all([
      transaction.get(presentationRef),
      transaction.get(eventRef),
      transaction.get(meeting.ref),
    ]);
    if (priorEvent.exists) { response = priorEvent.data()?.result || {}; return; }
    if (!liveMeetingSnap.exists) throw new HttpsError('not-found', 'Meeting not found.');
    const liveMeeting = liveMeetingSnap.data() || {};
    assertActivePartnershipMeeting(liveMeeting);
    if (!snap.exists) throw new HttpsError('failed-precondition', 'Start the presentation first.');
    const current = snap.data() || {};
    assertMeetingContextUnchanged(liveMeeting, current);
    if (clean(current.status) === 'completed') {
      response = { duplicate: true, status: 'completed', activeDurationSeconds: Number(current.activeDurationSeconds) || 0 };
      transaction.create(eventRef, { type: 'complete_duplicate', at, result: response });
      return;
    }
    const closed = closeCurrentPage(current, at);
    const totalSeconds = durationSeconds(current.startedAt, at);
    const update = {
      status: 'completed',
      pageDurationsSeconds: closed.data.pageDurationsSeconds || {},
      activeDurationSeconds: Number(closed.data.activeDurationSeconds) || 0,
      timingAnomalyCount: Number(closed.data.timingAnomalyCount) || 0,
      totalDurationSeconds: totalSeconds,
      currentPageIndex: null,
      currentPageKey: '',
      currentPageEnteredAt: null,
      completedAt: at,
      completedByRef: ctx.actor.userRef,
      updatedAt: at,
    };
    transaction.update(presentationRef, update);
    transaction.set(meeting.ref, { presentationStatus: 'completed', presentationCompletedAt: at, presentationActiveDurationSeconds: update.activeDurationSeconds, presentationTotalDurationSeconds: totalSeconds, presentationPageDurationsSeconds: update.pageDurationsSeconds, updatedAt: at, updatedByRef: ctx.actor.userRef }, { merge: true });
    if (closed.closed) transaction.set(visitRef, { ...closed.closed, presentationRef, meetingRef: meeting.ref, leadRef: current.leadRef, organizationRef: current.organizationRef, createdAt: at });
    transaction.set(connectionRef, {
      type: 'presentation_completed', eventType: 'presentation_completed', summary: `Partner Reveal completed: ${clean(current.organizationName)}`,
      body: '', details: { presentationType: clean(current.presentationType), locationType: clean(current.locationType), startedAt: current.startedAt, finishedAt: at, durationSeconds: update.activeDurationSeconds, totalDurationSeconds: totalSeconds, pageDurationsSeconds: update.pageDurationsSeconds, pageVisitCounts: current.pageVisitCounts || {}, navigationCount: Number(current.navigationCount) || 0, timingAnomalyCount: update.timingAnomalyCount },
      sourceRef: presentationRef, presentationRef, meetingRef: meeting.ref, actionRef: meeting.ref,
      leadRef: current.leadRef, leadName: clean(current.leadName), personRef: current.personRef, personName: clean(current.personName), organizationRef: current.organizationRef, organizationName: clean(current.organizationName),
      ownerRef: current.ownerRef, ownerUid: clean(current.ownerUid), ownerName: clean(current.ownerName), assignedToRef: current.assignedToRef, assignedToUid: clean(current.assignedToUid), assignedToName: clean(current.assignedToName), teamRepIds: current.teamRepIds || [], viewerUids: current.viewerUids || [],
      createdAt: at, createdByRef: ctx.actor.userRef, createdByUid: ctx.uid,
      createdByName: actorName(ctx),
    }, { merge: true });
    response = { duplicate: false, status: 'completed', activeDurationSeconds: update.activeDurationSeconds, totalDurationSeconds: totalSeconds, pageDurationsSeconds: update.pageDurationsSeconds };
    transaction.create(eventRef, { type: 'completed', at, result: response });
  });
  return { ok: true, presentationRefPath: presentationRef.path, meetingRefPath: meeting.ref.path, nextStep: 'record_meeting_outcome', ...response };
}

exports.getCommandPartnerPresentationContextService = getCommandPartnerPresentationContextService;
exports.startCommandPartnerPresentationService = startCommandPartnerPresentationService;
exports.recordCommandPartnerPresentationPageService = recordCommandPartnerPresentationPageService;
exports.pauseCommandPartnerPresentationService = pauseCommandPartnerPresentationService;
exports.completeCommandPartnerPresentationService = completeCommandPartnerPresentationService;
exports.getCommandPartnerPresentationContext = callable(getCommandPartnerPresentationContextService);
exports.startCommandPartnerPresentation = callable(startCommandPartnerPresentationService);
exports.recordCommandPartnerPresentationPage = callable(recordCommandPartnerPresentationPageService);
exports.pauseCommandPartnerPresentation = callable(pauseCommandPartnerPresentationService);
exports.completeCommandPartnerPresentation = callable(completeCommandPartnerPresentationService);
exports._test = { personPayload, baseSession, relatedContext, readPresentationMeeting, SLIDES, MAX_PAGE_SECONDS, documentPath, slide, eventId, durationSeconds, meetingStatus, assertActivePartnershipMeeting, assertMeetingContextUnchanged, closeCurrentPage };

