'use strict';

const { onCall } = require('firebase-functions/v2/https');
const {
  clean, commandActorContext, resolveAllowedRepresentatives,
  requireAllowedRepresentative, localDayBounds, zonedParts,
} = require('../../lib/command/commandReportingUtils');

const CALL_OUTCOMES = ['connected', 'voicemail', 'no_answer', 'wrong_number', 'not_interested'];
const serialize = value => value?.toDate ? value.toDate().toISOString() : (value?.path || value || null);

function emptyTotals() {
  return {
    totalActivity: 0, callsLogged: 0, connectedCalls: 0, voicemails: 0,
    noAnswers: 0, wrongNumbers: 0, notInterested: 0, emailsSent: 0,
    actionsCreated: 0, actionsCompleted: 0, followUpsCreated: 0,
    stageChanges: 0, opportunitiesWon: 0, opportunitiesLost: 0,
    meetingsScheduled: 0, meetingsHeld: 0, meetingNoShows: 0, notesAdded: 0,
  };
}

async function getCommandDailyOverviewService(request) {
  const ctx = await commandActorContext(request);
  const allowedReps = await resolveAllowedRepresentatives(ctx, {
    includeAllForPlatformAdmin: true,
  });
  const selectedRep = requireAllowedRepresentative(allowedReps, ctx.input.selectedRepUid, ctx.uid);
  const timeZone = clean(ctx.input.timeZone) || 'America/Edmonton';
  const localDate = clean(ctx.input.localDate);
  const bounds = localDayBounds(localDate, timeZone);
  const base = ctx.db.collection('commandConnections');
  const [uidSnapshot, legacyRefSnapshot] = await Promise.all([
    base.where('createdByUid', '==', selectedRep.uid)
      .where('createdAt', '>=', bounds.start).where('createdAt', '<', bounds.end)
      .orderBy('createdAt', 'desc').get(),
    base.where('createdByRef', '==', ctx.db.doc(selectedRep.refPath))
      .where('createdAt', '>=', bounds.start).where('createdAt', '<', bounds.end)
      .orderBy('createdAt', 'desc').get(),
  ]);
  const documents = [...new Map(
    [...uidSnapshot.docs, ...legacyRefSnapshot.docs].map(doc => [doc.ref.path, doc])
  ).values()].sort((a, b) => (b.data()?.createdAt?.toMillis?.() || 0) - (a.data()?.createdAt?.toMillis?.() || 0));

  const totals = emptyTotals();
  const callOutcomeBreakdown = Object.fromEntries(CALL_OUTCOMES.map(value => [value, 0]));
  const stageMovementBreakdown = {};
  const hourlyActivity = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
  const people = new Set(); const organizations = new Set();
  let firstActivityAt = null; let lastActivityAt = null;
  const recentActivity = [];

  for (const doc of documents) {
    const data = doc.data() || {}; const type = clean(data.type).toLowerCase();
    const details = data.details || {}; const createdAt = data.createdAt;
    totals.totalActivity += 1;
    if (!lastActivityAt) lastActivityAt = serialize(createdAt);
    firstActivityAt = serialize(createdAt);
    if (data.personRef?.path) people.add(data.personRef.path);
    if (data.organizationRef?.path) organizations.add(data.organizationRef.path);
    if (createdAt?.toDate) hourlyActivity[zonedParts(createdAt.toDate(), timeZone).hour].count += 1;
    if (type === 'call') {
      totals.callsLogged += 1; const outcome = clean(details.outcome).toLowerCase();
      if (Object.hasOwn(callOutcomeBreakdown, outcome)) callOutcomeBreakdown[outcome] += 1;
      if (outcome === 'connected') totals.connectedCalls += 1;
      if (outcome === 'voicemail') totals.voicemails += 1;
      if (outcome === 'no_answer') totals.noAnswers += 1;
      if (outcome === 'wrong_number') totals.wrongNumbers += 1;
      if (outcome === 'not_interested') totals.notInterested += 1;
      if (clean(details.followUpRefPath)) totals.followUpsCreated += 1;
    } else if (type === 'email_out') totals.emailsSent += 1;
    else if (type === 'action_created') { totals.actionsCreated += 1; if (data.sourceCallRef || clean(details.sourceCallRefPath)) totals.followUpsCreated += 1; }
    else if (type === 'action_completed') totals.actionsCompleted += 1;
    else if (type === 'stage_change') {
      totals.stageChanges += 1;
      const key = `${clean(details.fromStage) || 'Unknown'} → ${clean(details.toStage) || 'Unknown'}`;
      stageMovementBreakdown[key] = (stageMovementBreakdown[key] || 0) + 1;
    } else if (type === 'flow_won') totals.opportunitiesWon += 1;
    else if (type === 'flow_lost') totals.opportunitiesLost += 1;
    else if (type === 'meeting_scheduled') totals.meetingsScheduled += 1;
    else if (type === 'meeting_held') totals.meetingsHeld += 1;
    else if (type === 'meeting_no_show') totals.meetingNoShows += 1;
    else if (type === 'note') totals.notesAdded += 1;
    if (recentActivity.length < 100) recentActivity.push({
      refPath: doc.ref.path, type, summary: clean(data.summary), body: clean(data.body), details,
      recordType: clean(data.recordType) || (data.personRef ? 'person' : (data.organizationRef ? 'organization' : 'general')),
      recordName: clean(data.recordName) || clean(data.personName) || clean(data.organizationName),
      personRefPath: serialize(data.personRef) || '', personName: clean(data.personName),
      organizationRefPath: serialize(data.organizationRef) || '', organizationName: clean(data.organizationName),
      createdAt: serialize(createdAt), performedByName: clean(data.createdByName) || selectedRep.name,
    });
  }

  return {
    ok: true, result: 'success', allowedReps, selectedRep, localDate, timeZone,
    range: { startAt: bounds.start.toDate().toISOString(), endAt: bounds.end.toDate().toISOString() },
    ...totals, uniquePeopleContacted: people.size, uniqueOrganizationsContacted: organizations.size,
    firstActivityAt, lastActivityAt, callOutcomeBreakdown, stageMovementBreakdown,
    hourlyActivity, recentActivity,
  };
}

exports.getCommandDailyOverviewService = getCommandDailyOverviewService;
exports.getCommandDailyOverview = onCall(
  { region: 'us-central1', cors: true, timeoutSeconds: 120, memory: '512MiB' },
  getCommandDailyOverviewService
);
