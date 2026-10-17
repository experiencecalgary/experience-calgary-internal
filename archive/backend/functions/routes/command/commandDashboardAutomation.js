'use strict';

const admin = require('firebase-admin');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { requireAuth, requireCommandAccess, isPlatformAdminUser } = require('../../lib/command/commandPersonUtils');

const ZONE = 'America/Edmonton';
const ACTIVE_STAGES = new Set(['New', 'Opened', 'Engaged', 'Closing']);
const FLOW_STAGES = ['Opened', 'Engaged', 'Closing'];
const FLOW_STAGE_SET = new Set(FLOW_STAGES);
const DASHBOARD_PREVIEW_LIMIT = 3;
const clean = value => typeof value === 'string' ? value.trim() : '';
const millis = value => value?.toMillis?.() || 0;
const iso = value => value?.toDate ? value.toDate().toISOString() : null;
const unique = values => [...new Set((values || []).filter(Boolean))];
const callable = handler => onCall({ region: 'us-central1', cors: true, timeoutSeconds: 120, memory: '512MiB' }, handler);

function dayKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date).filter(part => part.type !== 'literal');
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return [map.year, map.month, map.day].join('-');
}
function mondayForKey(key) {
  const date = new Date(`${key}T12:00:00.000Z`);
  const offset = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
}
function importedAtMillis(data) {
  return millis(data.importedAt) || (clean(data.importBatchId) ? millis(data.createdAt) : 0);
}
function isStaleImportedRecord(data, hasAnyAction, nowMs) {
  if (data.archived === true || (data.status && data.status !== 'active') || !ACTIVE_STAGES.has(clean(data.stage)) || hasAnyAction) return false;
  const importedAt = importedAtMillis(data);
  return importedAt > 0 && importedAt <= nowMs - 7 * 86400000;
}
function visible(uid, repId, data, platformAdmin = false) {
  if (platformAdmin) return true;
  return data.ownerUid === uid || data.assignedToUid === uid ||
    (Array.isArray(data.viewerUids) && data.viewerUids.includes(uid)) ||
    (repId && Array.isArray(data.teamRepIds) && data.teamRepIds.map(String).includes(repId));
}
function assignedScope(scope, uid, repId, data, platformAdmin = false) {
  const mine = clean(data.assignedToUid) === uid;
  return scope === 'mine' ? mine : visible(uid, repId, data, platformAdmin) && !mine;
}
function recordScope(scope, uid, repId, data, platformAdmin = false) {
  const mine = clean(data.assignedToUid) === uid || (!clean(data.assignedToUid) && clean(data.ownerUid) === uid);
  return scope === 'mine' ? mine : visible(uid, repId, data, platformAdmin) && !mine;
}
function connectionScope(scope, uid, repId, data, platformAdmin = false) {
  const mine = clean(data.ownerUid) === uid || clean(data.assignedToUid) === uid;
  return scope === 'mine' ? mine : visible(uid, repId, data, platformAdmin) && !mine;
}
function related(data) {
  if (data.personRef) return { relatedType: 'person', relatedRefPath: data.personRef.path, relatedName: clean(data.personName) };
  if (data.organizationRef) return { relatedType: 'organization', relatedRefPath: data.organizationRef.path, relatedName: clean(data.organizationName) };
  return { relatedType: 'general', relatedRefPath: '', relatedName: '' };
}
function actionRow(doc, data, now, today) {
  const meeting = clean(data.actionType).toLowerCase() === 'meeting';
  const scheduled = meeting ? data.startAt : data.dueAt;
  const endedAt = meeting ? (data.endAt || data.startAt) : data.dueAt;
  const scheduleMs = millis(scheduled); const endedMs = millis(endedAt);
  const status = clean(data.status).toLowerCase();
  const outcome = clean(data.meetingOutcome || data.outcomeStatus);
  const meetingStatus = meeting
    ? clean(data.meetingStatus) || (data.meetingStartedAt && !data.meetingFinishedAt ? 'in_progress' : 'scheduled')
    : '';
  return {
    itemType: meeting ? 'meeting' : 'action', refPath: doc.ref.path, actionRefPath: doc.ref.path,
    leadRefPath: data.leadRef?.path || '',
    personRefPath: data.personRef?.path || '', organizationRefPath: data.organizationRef?.path || '',
    title: clean(data.title), actionType: clean(data.actionType), scheduledAt: iso(scheduled),
    dueAt: iso(data.dueAt), startAt: iso(data.startAt), endAt: iso(data.endAt),
    dueDateKey: clean(data.dueDateKey), status, priority: clean(data.priority),
    assignedToUid: clean(data.assignedToUid), assignedToName: clean(data.assignedToName),
    timezone: clean(data.timezone || data.timeZone), locationType: clean(data.locationType),
    location: clean(data.location), meetingUrl: clean(data.meetingUrl || data.meetingLink),
    meetingStatus, outcomeStatus: outcome, ...related(data),
    isOverdue: !meeting && status === 'open' && scheduleMs > 0 && scheduleMs < now,
    dueToday: !meeting && status === 'open' &&
      (clean(data.dueDateKey) === today || (scheduleMs > 0 && dayKey(new Date(scheduleMs)) === today)),
    requiresOutcome: meeting && status === 'open' && endedMs > 0 && endedMs < now && !outcome,
    canComplete: !meeting && status === 'open', canReschedule: status === 'open',
    canRecordOutcome: meeting && status === 'open' && endedMs > 0 && endedMs <= now && !outcome,
  };
}
function flowName(data) {
  return clean(data.fullName) || clean(data.organizationName) || clean(data.organization) || clean(data.name) || 'Command record';
}
function connectionRow(doc, data) {
  const recordType = data.leadRef ? 'lead' : clean(data.recordType) || (data.personRef ? 'person' : (data.organizationRef ? 'organization' : 'general'));
  return {
    refPath: doc.ref.path, activityType: clean(data.type), occurredAt: iso(data.createdAt),
    actorName: clean(data.createdByName || data.ownerName) || 'Experience Command',
    displayTitle: clean(data.displayTitle || data.summary),
    displaySummary: clean(data.displaySummary || data.body || data.summary),
    recordType, recordName: clean(data.recordName) || clean(data.personName) || clean(data.organizationName),
    relatedRefPath: data.leadRef?.path || data.personRef?.path || data.organizationRef?.path || '',
    direction: clean(data.direction || data.details?.direction),
  };
}
function unreadThreadRow(doc, data) {
  return {
    itemType: 'exmail', refPath: doc.ref.path, threadRefPath: doc.ref.path,
    subject: clean(data.subject) || '(No subject)',
    senderName: clean(data.senderName || data.fromName), lastMessageAt: iso(data.lastMessageAt),
    lastDirection: clean(data.lastDirection || data.lastMessageDirection),
    personRefPath: data.personRef?.path || '', organizationRefPath: data.organizationRef?.path || '',
  };
}
function dashboardBucket(items, destination, previewLimit = DASHBOARD_PREVIEW_LIMIT) {
  const previewItems = items.slice(0, previewLimit);
  return {
    totalCount: items.length,
    previewItems,
    showingCount: previewItems.length,
    remainingCount: Math.max(0, items.length - previewItems.length),
    hasMore: items.length > previewItems.length,
    destination,
  };
}
function nextMoveItem(kind, row, reason, actionLabel) {
  if (!row) {
    return {
      kind: 'start_working', itemType: 'queue', title: 'Start the next conversation',
      reason: 'Nothing urgent is waiting. Work the best available Lead.',
      actionLabel: 'START WORKING', destination: { workspace: 'outreach', queueMode: 'priority_calls' },
    };
  }
  const lead = kind === 'lead_at_risk';
  const meeting = row.itemType === 'meeting';
  return {
    kind, itemType: lead ? 'lead' : row.itemType,
    title: lead ? `Set the next move for ${row.name}` : row.title,
    reason, actionLabel,
    refPath: row.refPath,
    actionRefPath: lead ? '' : (row.actionRefPath || row.refPath),
    meetingRefPath: meeting ? (row.actionRefPath || row.refPath) : '',
    leadRefPath: lead ? row.refPath : clean(row.leadRefPath),
    scheduledAt: row.scheduledAt || row.nextActionAt || null,
    dueAt: row.dueAt || null,
    stage: clean(row.stage),
    relatedType: clean(row.relatedType),
    relatedRefPath: clean(row.relatedRefPath),
    relatedName: clean(row.relatedName),
    personRefPath: clean(row.personRefPath),
    organizationRefPath: clean(row.organizationRefPath),
  };
}
function isCurrentMeeting(row, today, now) {
  if (row.itemType !== 'meeting' || row.status !== 'open') return false;
  if (clean(row.meetingStatus).toLowerCase() === 'in_progress') return true;
  if (!row.scheduledAt || dayKey(new Date(row.scheduledAt)) !== today) return false;
  const end = Date.parse(row.endAt || row.scheduledAt);
  return Number.isFinite(end) && end >= now;
}
function chooseNextMove({ todayMeetings, meetingOutcomes, overdueActions, followUpsToday, atRiskLeads, now }) {
  const inProgress = todayMeetings.find(row => clean(row.meetingStatus).toLowerCase() === 'in_progress');
  if (inProgress) return nextMoveItem(
    'meeting_in_progress', inProgress,
    'This Meeting is already in progress. Finish it before starting something else.',
    'RESUME MEETING'
  );
  const nearMeeting = todayMeetings.find(row => {
    const start = Date.parse(row.startAt || row.scheduledAt);
    return Number.isFinite(start) && start - now >= -120 * 60000 && start - now <= 30 * 60000;
  });
  if (nearMeeting) return nextMoveItem(
    'meeting_up_next', nearMeeting,
    'This is the next scheduled commitment and its start time is approaching.',
    'START MEETING'
  );
  if (meetingOutcomes[0]) return nextMoveItem(
    'meeting_outcome', meetingOutcomes[0],
    'This Meeting needs its result and next step recorded.',
    'RECORD OUTCOME'
  );
  if (overdueActions[0]) return nextMoveItem(
    'overdue_action', overdueActions[0],
    'This promised Action is overdue. Close the loop before momentum fades.',
    'OPEN ACTION'
  );
  if (followUpsToday[0]) return nextMoveItem(
    'follow_up_today', followUpsToday[0],
    'This planned Action is due today.',
    'OPEN ACTION'
  );
  if (atRiskLeads[0]) return nextMoveItem(
    'lead_at_risk', atRiskLeads[0],
    atRiskLeads[0].reason,
    'OPEN LEAD'
  );
  return nextMoveItem();
}
async function dashboardContext(request) {
  const db = admin.firestore(); const uid = requireAuth(request);
  const actor = await requireCommandAccess(db, uid);
  const scope = clean(request.data?.scope).toLowerCase() || 'mine';
  if (!['mine', 'team'].includes(scope)) throw new HttpsError('invalid-argument', 'scope must be mine or team.');
  return { db, uid, actor, scope, repId: String(actor.userData.repId || '').trim(), isPlatformAdmin: isPlatformAdminUser(actor.userData) };
}
async function scopedDashboardRows(ctx, collection) {
  const ref = collection === 'commandLeads'
    ? ctx.db.collection(collection).where('status', '==', 'active').where('archived', '==', false)
    : ctx.db.collection(collection);
  if (ctx.isPlatformAdmin && ctx.scope === 'team') return ref.get();
  const requests = [ref.where('ownerUid', '==', ctx.uid).get(), ref.where('assignedToUid', '==', ctx.uid).get()];
  if (ctx.scope === 'team') {
    requests.push(ref.where('viewerUids', 'array-contains', ctx.uid).get());
    if (ctx.repId) requests.push(ref.where('teamRepIds', 'array-contains', ctx.repId).get());
  }
  if (collection === 'commandActions') requests.push(ref.where('internalAttendeeUids', 'array-contains', ctx.uid).get());
  const snapshots = await Promise.all(requests), docs = new Map();
  for (const snap of snapshots) for (const doc of snap.docs) docs.set(doc.id, doc);
  return { docs: [...docs.values()] };
}

async function getCommandDashboardSummaryService(request) {
  const ctx = await dashboardContext(request);
  const leadRows = scopedDashboardRows(ctx, 'commandLeads');
  const [actionsSnap, threadsSnap, connectionsSnap, peopleSnap, organizationsSnap, usersSnap] = await Promise.all([
    scopedDashboardRows(ctx, 'commandActions'),
    scopedDashboardRows(ctx, 'commandEmailThreads'),
    ctx.db.collection('commandConnections').orderBy('createdAt', 'desc').limit(100).get(),
    leadRows.then(snap => ({docs:snap.docs.filter(doc=>doc.data().archived!==true&&doc.data().status==='active'&&doc.data().leadType==='person')})),
    leadRows.then(snap => ({docs:snap.docs.filter(doc=>doc.data().archived!==true&&doc.data().status==='active'&&doc.data().leadType==='organization')})),
    ctx.db.collection('users').get(),
  ]);
  const now = Date.now(); const todayKey = dayKey(new Date(now));
  const scopedActions = actionsSnap.docs.map(doc => ({ doc, data: doc.data() || {} }))
    .filter(({ data }) => data.archived !== true)
    .filter(({ data }) => assignedScope(ctx.scope, ctx.uid, ctx.repId, data, ctx.isPlatformAdmin));
  const actions = scopedActions.map(({ doc, data }) => actionRow(doc, data, now, todayKey));
  const overdueActions = actions.filter(row => row.isOverdue)
    .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
  const meetingOutcomes = actions.filter(row => row.requiresOutcome)
    .sort((a, b) => Date.parse(a.endAt || a.startAt) - Date.parse(b.endAt || b.startAt));
  const todayMeetings = actions.filter(row => isCurrentMeeting(row, todayKey, now))
    .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
  const todayActions = actions.filter(row => row.itemType === 'action' && row.status === 'open' &&
    row.scheduledAt && dayKey(new Date(row.scheduledAt)) === todayKey)
    .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
  const todayItems = [...todayMeetings, ...todayActions]
    .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
  // Every open non-Meeting Action due later today is a planned follow-up for My Day.
  // Already-late Actions remain exclusively in overdueActions so the buckets do not overlap.
  const followUpsToday = todayActions.filter(row => !row.isOverdue);
  const unreadThreads = threadsSnap.docs.map(doc => ({ doc, data: doc.data() || {} }))
    .filter(({ data }) => Array.isArray(data.unreadBy) &&
      (ctx.isPlatformAdmin && ctx.scope === 'team' ? data.unreadBy.length > 0 : data.unreadBy.includes(ctx.uid)) &&
      visible(ctx.uid, ctx.repId, data, ctx.isPlatformAdmin) && (ctx.scope === 'mine'
        ? (clean(data.ownerUid) === ctx.uid || clean(data.assignedToUid) === ctx.uid)
        : clean(data.ownerUid) !== ctx.uid && clean(data.assignedToUid) !== ctx.uid))
    .sort((a, b) => millis(b.data.lastMessageAt) - millis(a.data.lastMessageAt));
  const flowDocs = [
    ...peopleSnap.docs.map(doc => ({ doc, recordType: 'person', data: doc.data() || {} })),
    ...organizationsSnap.docs.map(doc => ({ doc, recordType: 'organization', data: doc.data() || {} })),
  ].filter(({ data }) => FLOW_STAGE_SET.has(clean(data.stage)) && recordScope(ctx.scope, ctx.uid, ctx.repId, data, ctx.isPlatformAdmin));
  const stageMap = Object.fromEntries(FLOW_STAGES.map(stage => [stage, {
    stage, peopleCount: 0, organizationCount: 0, totalCount: 0,
    peopleValue: 0, organizationValue: 0, estimatedValue: 0,
  }]));
  for (const row of flowDocs) {
    const stage = stageMap[clean(row.data.stage)]; const value = Number(row.data.estimatedValue) || 0;
    stage.totalCount += 1; stage.estimatedValue += value;
    if ((row.leadType || row.recordType) === 'person') { stage.peopleCount += 1; stage.peopleValue += value; }
    else { stage.organizationCount += 1; stage.organizationValue += value; }
  }
  // Lead health considers every linked Action, even when assigned to another rep.
  const healthActions = [];
  const healthLeads = [...peopleSnap.docs, ...organizationsSnap.docs].filter(doc => recordScope(ctx.scope, ctx.uid, ctx.repId, doc.data(), ctx.isPlatformAdmin));
  for (let offset = 0; offset < healthLeads.length; offset += 30) {
    const snap = await ctx.db.collection('commandActions').where('leadRef', 'in', healthLeads.slice(offset, offset + 30).map(doc => doc.ref)).get();
    healthActions.push(...snap.docs);
  }
  const actionByRecord = new Map();
  for (const doc of healthActions) {
    const data = doc.data() || {};
    if (data.archived === true) continue;
    if (clean(data.status).toLowerCase() !== 'open') continue;
    const path = data.leadRef?.path; if (!path) continue;
    const when = millis(clean(data.actionType).toLowerCase() === 'meeting' ? data.startAt : data.dueAt);
    const item = actionByRecord.get(path) || { future: [], overdue: 0 };
    if (when >= now) item.future.push(when); else if (when > 0) item.overdue += 1;
    actionByRecord.set(path, item);
  }
  const followUpGaps = flowDocs.filter(({ data }) => ['Engaged', 'Closing'].includes(clean(data.stage)))
    .map(({ doc, recordType, data }) => {
      const schedule = actionByRecord.get(doc.ref.path) || { future: [], overdue: 0 };
      const nextActionMs = schedule.future.length ? Math.min(...schedule.future) : 0;
      // Momentum risk means there is no future commitment. Overdue Actions remain
      // useful context, but do not make a Lead risky when another future Action exists.
      const gapType = !nextActionMs ? 'no_follow_up' : '';
      if (!gapType) return null;
      return {
        recordType: 'lead', leadType: recordType, refPath: doc.ref.path, name: clean(data.displayName) || flowName(data), stage: clean(data.stage),
        estimatedValue: Number(data.estimatedValue) || 0, assignedToName: clean(data.assignedToName),
        gapType, nextActionAt: nextActionMs ? new Date(nextActionMs).toISOString() : null,
        overdueActionCount: schedule.overdue,
      };
    }).filter(Boolean)
    .sort((a, b) => a.stage === b.stage ? b.estimatedValue - a.estimatedValue : (a.stage === 'Closing' ? -1 : 1));
  const actionRecordPaths = new Set(healthActions.flatMap(doc => {
    const data = doc.data() || {};
    return [data.leadRef?.path].filter(Boolean);
  }));
  const staleRecords = [
    ...peopleSnap.docs.map(doc => ({ doc, recordType: 'person', data: doc.data() || {} })),
    ...organizationsSnap.docs.map(doc => ({ doc, recordType: 'organization', data: doc.data() || {} })),
  ].filter(({ doc, data }) =>
    recordScope(ctx.scope, ctx.uid, ctx.repId, data, ctx.isPlatformAdmin) &&
    isStaleImportedRecord(data, actionRecordPaths.has(doc.ref.path), now)
  ).map(({ doc, recordType, data }) => ({
    recordType: 'lead', leadType: recordType,
    refPath: doc.ref.path,
    name: clean(data.displayName) || flowName(data),
    stage: clean(data.stage),
    importedAt: iso(data.importedAt || data.createdAt),
    assignedToName: clean(data.assignedToName),
  })).sort((a, b) => Date.parse(a.importedAt) - Date.parse(b.importedAt));

  const recentConnections = connectionsSnap.docs.map(doc => ({ doc, data: doc.data() || {} }))
    .filter(({ data }) => connectionScope(ctx.scope, ctx.uid, ctx.repId, data, ctx.isPlatformAdmin))
    .slice(0, 6).map(({ doc, data }) => connectionRow(doc, data));
  const teamMembers = usersSnap.docs.map(doc => ({ doc, data: doc.data() || {} }))
    .filter(({ doc, data }) => data.active !== false &&
      (ctx.isPlatformAdmin
        ? doc.id !== ctx.uid && data.userType === 'rep'
        : ctx.repId && [data.programDirectorRepId, data.directorRepId]
          .map(value => String(value || '').trim()).includes(ctx.repId)))
    .map(({ doc, data }) => ({
      repId: String(data.repId || '').trim(), userRefPath: doc.ref.path,
      displayName: clean(data.fullName || data.displayName || data.name) ||
        [clean(data.firstName), clean(data.lastName)].filter(Boolean).join(' '),
    })).filter(row => row.repId && row.displayName).sort((a, b) => a.displayName.localeCompare(b.displayName));
  const stages = FLOW_STAGES.map(stage => stageMap[stage]);
  const closingGaps = followUpGaps.filter(row => row.stage === 'Closing');
  const atRiskLeads = followUpGaps.map(row => ({
    ...row,
    itemType: 'lead',
    leadRefPath: row.refPath,
    issueType: 'no_future_action',
    reason: row.overdueActionCount > 0
      ? `This ${row.stage || 'active'} Lead has no future Action and ${row.overdueActionCount} overdue Action${row.overdueActionCount === 1 ? '' : 's'}.`
      : `This ${row.stage || 'active'} Lead has no future Action.`,
  }));
  const unreadExMail = unreadThreads.map(({ doc, data }) => unreadThreadRow(doc, data));
  const nextMove = chooseNextMove({
    todayMeetings, meetingOutcomes, overdueActions, followUpsToday, atRiskLeads, now,
  });
  const dashboard = {
    nextMove,
    todayMeetings: dashboardBucket(todayMeetings, {
      workspace: 'schedule', initialTab: 'today',
    }),
    missingOutcomes: dashboardBucket(meetingOutcomes, {
      workspace: 'schedule', initialTab: 'missing_outcomes',
    }),
    overdueActions: dashboardBucket(overdueActions, {
      workspace: 'actions', status: 'open', type: 'action', timing: 'overdue',
    }),
    followUpsToday: dashboardBucket(followUpsToday, {
      workspace: 'actions', status: 'open', type: 'action', timing: 'today',
    }),
    atRiskLeads: dashboardBucket(atRiskLeads, {
      workspace: 'leads', status: 'active', risk: 'at_risk', stages: ['Engaged', 'Closing'],
      callable: 'getCommandDashboardSummary', bucket: 'at_risk_leads',
    }),
    unreadExMail: dashboardBucket(unreadExMail, {
      workspace: 'exmail', unread: true,
    }),
  };
  const requestedBucket = clean(request.data?.bucket).toLowerCase();
  let bucketPage = null;
  if (requestedBucket) {
    if (requestedBucket !== 'at_risk_leads') {
      throw new HttpsError('invalid-argument', 'bucket must be at_risk_leads.');
    }
    const pageSize = Math.min(Math.max(Number(request.data?.pageSize) || 25, 1), 100);
    const offset = Math.max(Number(request.data?.pageToken) || 0, 0);
    const records = atRiskLeads.slice(offset, offset + pageSize);
    const nextOffset = offset + records.length;
    bucketPage = {
      bucket: requestedBucket, records, totalCount: atRiskLeads.length,
      hasMore: nextOffset < atRiskLeads.length,
      nextPageToken: nextOffset < atRiskLeads.length ? String(nextOffset) : '',
    };
  }
  return {
    ok: true, result: 'success', scope: ctx.scope, generatedAt: new Date(now).toISOString(),
    ...(bucketPage ? { bucketPage } : {}),
    dashboard, nextMove,
    todayMeetings: dashboard.todayMeetings,
    missingOutcomes: dashboard.missingOutcomes,
    overdueActions: dashboard.overdueActions,
    followUpsToday: dashboard.followUpsToday,
    atRiskLeads: dashboard.atRiskLeads,
    unreadExMail: dashboard.unreadExMail,
    attention: {
      overdueActions: overdueActions.slice(0, 5), meetingOutcomes: meetingOutcomes.slice(0, 5),
      closingWithoutFollowUp: closingGaps.slice(0, 5),
      staleRecords: staleRecords.slice(0, 10),
      stalePeople: staleRecords.filter(row => (row.leadType || row.recordType) === 'person').slice(0, 5),
      staleOrganizations: staleRecords.filter(row => (row.leadType || row.recordType) === 'organization').slice(0, 5),
      unreadThreads: unreadExMail.slice(0, 5),
      counts: { overdueActions: overdueActions.length, meetingOutcomes: meetingOutcomes.length,
        closingWithoutFollowUp: closingGaps.length,
        staleRecords: staleRecords.length,
        stalePeople: staleRecords.filter(row => (row.leadType || row.recordType) === 'person').length,
        staleOrganizations: staleRecords.filter(row => (row.leadType || row.recordType) === 'organization').length,
        unreadThreads: unreadThreads.length },
    },
    today: { items: todayItems.slice(0, 12),
      dueTodayCount: todayItems.filter(row => row.itemType === 'action').length,
      upcomingMeetingCount: todayItems.filter(row => row.itemType === 'meeting').length },
    flow: { stages, totalRecords: stages.reduce((sum, stage) => sum + stage.totalCount, 0),
      totalEstimatedValue: stages.reduce((sum, stage) => sum + stage.estimatedValue, 0),
      followUpGaps: followUpGaps.slice(0, 6) },
    recentConnections, teamMembers,
  };
}

function notificationId(uid, type, sourceId, window = '') {
  return `${uid}_${type}_${sourceId}_${window}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 1400);
}
function recipientUids(data) {
  const actionType = clean(data.actionType).toLowerCase();
  if (actionType === 'meeting') return unique(data.internalAttendeeUids || []);
  if (actionType) return unique([data.assignedToUid]);
  return unique([data.assignedToUid, data.ownerUid]);
}
function notificationData(db, uid, type, title, body, source, dedupeKey, extra = {}) {
  return { uid, userRef: db.collection('users').doc(uid), type, title, body, read: false, isRead: false,
    sourceRef: source.ref, actionRef: source.ref, deduplicationKey: dedupeKey,
    createdAt: admin.firestore.FieldValue.serverTimestamp(), ...extra };
}
async function writeNotification(db, uid, type, source, window, title, body, extra = {}) {
  if (!uid) return false; const id = notificationId(uid, type, source.id, window);
  const ref = db.collection('commandNotifications').doc(id); const snap = await ref.get(); if (snap.exists) return false;
  await ref.create(notificationData(db, uid, type, title, body, source, id, extra)); return true;
}
async function processActions(db, predicate, type, window, title, body) {
  const snap = await db.collection('commandActions').where('status', '==', 'open').get(); let created = 0;
  for (const doc of snap.docs) { const data = doc.data() || {}; if (!predicate(data)) continue;
    for (const uid of recipientUids(data)) if (await writeNotification(db, uid, type(data), doc, window(data), title(data), body(data))) created += 1; }
  return { scanned: snap.size, created };
}
async function processCommandActionRemindersService(now = new Date()) {
  const nowMs = now.getTime();
  return processActions(admin.firestore(), data => clean(data.actionType).toLowerCase() !== 'meeting' && millis(data.dueAt) >= nowMs && millis(data.dueAt) <= nowMs + 3600000,
    () => 'action_due_soon', data => String(millis(data.dueAt)),
    () => 'Action due in one hour', data => clean(data.title) || 'Command Action');
}
async function processCommandMeetingRemindersService(now = new Date()) {
  const nowMs = now.getTime();
  return processActions(admin.firestore(), data => clean(data.actionType).toLowerCase() === 'meeting' && millis(data.startAt) >= nowMs && millis(data.startAt) <= nowMs + 3600000,
    () => 'meeting_reminder', data => String(millis(data.startAt)), () => 'Meeting starts in one hour', data => clean(data.title) || 'Command Meeting');
}
async function processCommandMeetingOutcomeRemindersService(now = new Date()) {
  const nowMs = now.getTime(); const today = dayKey(now);
  return processActions(admin.firestore(), data => clean(data.actionType).toLowerCase() === 'meeting' && millis(data.endAt || data.dueAt) > 0 && millis(data.endAt || data.dueAt) < nowMs && !clean(data.meetingOutcome),
    () => 'meeting_outcome_required', () => today, () => 'Meeting outcome required', data => clean(data.title) || 'Command Meeting');
}
async function processCommandDailySummaryService(now = new Date()) {
  const db = admin.firestore();
  const nowMs = now.getTime();
  const today = dayKey(now);
  const [usersSnap, actionsSnap, peopleSnap, organizationsSnap] = await Promise.all([
    db.collection('users').where('userType', '==', 'rep').get(),
    db.collection('commandActions').get(),
    db.collection('commandLeads').where('archived', '==', false).where('leadType', '==', 'person').get(),
    db.collection('commandLeads').where('archived', '==', false).where('leadType', '==', 'organization').get(),
  ]);
  const activeUsers = usersSnap.docs.filter(doc => doc.data()?.active !== false);
  const countsByUid = new Map(activeUsers.map(doc => [doc.id, {
    overdueActions: 0, dueToday: 0, meetingsToday: 0,
    stalePeople: 0, staleOrganizations: 0, closingWithoutFollowUp: 0,
  }]));
  const actionRecordPaths = new Set();
  const futureActionPaths = new Set();

  for (const doc of actionsSnap.docs) {
    const data = doc.data() || {};
    const path = data.leadRef?.path;
    if (path) actionRecordPaths.add(path);
    if (clean(data.status).toLowerCase() !== 'open') continue;
    const meeting = clean(data.actionType).toLowerCase() === 'meeting';
    const when = millis(meeting ? data.startAt : data.dueAt);
    if (path && when >= nowMs) futureActionPaths.add(path);
    if (!when) continue;
    if (meeting) {
      if (dayKey(new Date(when)) !== today) continue;
      for (const uid of unique([...(data.internalAttendeeUids || []), data.assignedToUid])) {
        const counts = countsByUid.get(uid);
        if (counts) counts.meetingsToday += 1;
      }
      continue;
    }
    const counts = countsByUid.get(clean(data.assignedToUid));
    if (!counts) continue;
    if (when < nowMs) counts.overdueActions += 1;
    else if (dayKey(new Date(when)) === today) counts.dueToday += 1;
  }

  for (const [collection, recordType, snapshot] of [
    ['commandPeople', 'person', peopleSnap],
    ['commandOrganizations', 'organization', organizationsSnap],
  ]) {
    for (const doc of snapshot.docs) {
      const data = doc.data() || {};
      const recipients = recipientUids(data).filter(uid => countsByUid.has(uid));
      if (!recipients.length || data.archived === true || data.status !== 'active' || !ACTIVE_STAGES.has(clean(data.stage))) continue;
      const stale = isStaleImportedRecord(data, actionRecordPaths.has(doc.ref.path), nowMs);
      const closingGap = clean(data.stage) === 'Closing' && !futureActionPaths.has(doc.ref.path);
      for (const uid of recipients) {
        const counts = countsByUid.get(uid);
        if (stale) counts[recordType === 'person' ? 'stalePeople' : 'staleOrganizations'] += 1;
        if (closingGap) counts.closingWithoutFollowUp += 1;
      }
    }
  }

  let created = 0;
  for (const user of activeUsers) {
    const uid = user.id;
    const counts = countsByUid.get(uid);
    const summaryRef = db.collection('commandDailySummaries').doc(`${today}_${uid}`);
    await summaryRef.set({
      uid, userRef: user.ref, dayKey: today, counts,
      generatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    const body = [
      `${counts.overdueActions} overdue`,
      `${counts.dueToday} due today`,
      `${counts.stalePeople + counts.staleOrganizations} stale`,
      `${counts.closingWithoutFollowUp} follow-up gaps`,
      `${counts.meetingsToday} meetings`,
    ].join(' · ');
    if (await writeNotification(db, uid, 'daily_command_summary',
      { id: summaryRef.id, ref: summaryRef }, today,
      'Your Command Summary', body, {
        destinationType: 'command_dashboard',
        summaryDateKey: today,
        summaryCounts: counts,
      })) created += 1;
  }
  return { scannedUsers: activeUsers.length, created, dayKey: today };
}

async function processCommandWeeklyPlanRemindersService(now = new Date()) {
  const db = admin.firestore();
  const today = dayKey(now);
  if (mondayForKey(today) !== today) return { skipped: true, reason: 'not_monday', created: 0 };
  const usersSnap = await db.collection('users').where('userType', '==', 'rep').get();
  const users = usersSnap.docs.filter(doc => doc.data()?.active !== false);
  const planRefs = users.map(user => db.collection('repWeeklyPlans').doc(`${user.id}_${today}`));
  const planSnaps = planRefs.length ? await db.getAll(...planRefs) : [];
  let created = 0;
  for (let index = 0; index < users.length; index += 1) {
    if (planSnaps[index]?.exists) continue;
    const user = users[index];
    const reminderRef = db.collection('commandWeeklyPlanReminders').doc(`${today}_${user.id}`);
    await reminderRef.set({
      uid: user.id, userRef: user.ref, weekStartKey: today,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    if (await writeNotification(db, user.id, 'weekly_plan_reminder',
      { id: reminderRef.id, ref: reminderRef }, today,
      'Set Your Weekly Plan', 'Build and lock in your priorities for this week.', {
        destinationType: 'weekly_plan',
        weekStartKey: today,
      })) created += 1;
  }
  return { scannedUsers: users.length, created, weekStartKey: today };
}

// Backward-compatible service name for callers and tests from the old per-record warning job.
const processCommandStaleLeadWarningsService = processCommandDailySummaryService;

async function commandActionNotificationHandler(event) {
  const after = event.data?.after;
  if (!after?.exists) return;

  const before = event.data?.before;
  const current = after.data() || {};
  const previous = before?.exists ? before.data() || {} : null;
  const db = admin.firestore();
  const meeting = clean(current.actionType).toLowerCase() === 'meeting';
  const actorUid = clean(
    (current.updatedByRef || current.createdByRef)?.id ||
    current.updatedByUid || current.createdByUid ||
    current.editorUid || current.creatorUid
  );
  const currentAttendees = unique(current.internalAttendeeUids || []);
  const previousAttendees = unique(previous?.internalAttendeeUids || []);
  const window = [
    millis(current.updatedAt), millis(current.dueAt), millis(current.startAt),
    clean(current.assignedToUid), clean(current.status),
  ].join('_');

  let type = '';
  let title = '';
  let recipients = [];

  if (!previous) {
    type = meeting ? 'meeting_created' : 'action_assigned';
    title = meeting ? 'Meeting created' : 'Action assigned';
    recipients = meeting ? currentAttendees : [current.assignedToUid];
  } else if (meeting) {
    const attendeeChanged =
      currentAttendees.slice().sort().join('|') !== previousAttendees.slice().sort().join('|');
    const rescheduled = millis(current.startAt) !== millis(previous.startAt);
    const cancelled = current.status === 'cancelled' && previous.status !== 'cancelled';

    if (cancelled) {
      type = 'meeting_cancelled';
      title = 'Meeting cancelled';
    } else if (rescheduled) {
      type = 'meeting_rescheduled';
      title = 'Meeting rescheduled';
    } else if (attendeeChanged) {
      type = 'meeting_changed';
      title = 'Meeting attendees updated';
    }
    if (type) recipients = unique([...currentAttendees, ...previousAttendees]);
  } else {
    const reassigned =
      clean(current.assignedToUid) &&
      clean(current.assignedToUid) !== clean(previous.assignedToUid);
    const dueChanged = millis(current.dueAt) !== millis(previous.dueAt);

    if (reassigned) {
      type = previous.assignedToUid ? 'action_reassigned' : 'action_assigned';
      title = dueChanged
        ? 'Action reassigned with a new due time'
        : (previous.assignedToUid ? 'Action reassigned to you' : 'Action assigned');
    } else if (dueChanged) {
      type = 'action_changed';
      title = 'Action due time updated';
    }
    if (type) recipients = [current.assignedToUid];
  }

  for (const uid of unique(recipients).filter(uid => uid !== actorUid)) {
    await writeNotification(
      db, uid, type, after, window, title,
      clean(current.title) || 'Command item'
    );
  }
}

exports.getCommandDashboardSummaryService = getCommandDashboardSummaryService;
exports.processCommandActionRemindersService = processCommandActionRemindersService;
exports.processCommandMeetingRemindersService = processCommandMeetingRemindersService;
exports.processCommandMeetingOutcomeRemindersService = processCommandMeetingOutcomeRemindersService;
exports.processCommandStaleLeadWarningsService = processCommandStaleLeadWarningsService;
exports.processCommandDailySummaryService = processCommandDailySummaryService;
exports.processCommandWeeklyPlanRemindersService = processCommandWeeklyPlanRemindersService;
exports.getCommandDashboardSummary = callable(getCommandDashboardSummaryService);
exports.processCommandActionReminders = onSchedule({ region: 'us-central1', schedule: 'every 5 minutes', timeZone: ZONE, timeoutSeconds: 300, memory: '512MiB' }, () => processCommandActionRemindersService());
exports.processCommandMeetingReminders = onSchedule({ region: 'us-central1', schedule: 'every 5 minutes', timeZone: ZONE, timeoutSeconds: 300, memory: '512MiB' }, () => processCommandMeetingRemindersService());
exports.processCommandMeetingOutcomeReminders = onSchedule({ region: 'us-central1', schedule: 'every 60 minutes', timeZone: ZONE, timeoutSeconds: 300, memory: '512MiB' }, () => processCommandMeetingOutcomeRemindersService());
exports.processCommandStaleLeadWarnings = onSchedule({ region: 'us-central1', schedule: '0 10 * * *', timeZone: ZONE, timeoutSeconds: 300, memory: '512MiB' }, () => processCommandDailySummaryService());
exports.processCommandWeeklyPlanReminders = onSchedule({ region: 'us-central1', schedule: '0 10 * * 1', timeZone: ZONE, timeoutSeconds: 300, memory: '512MiB' }, () => processCommandWeeklyPlanRemindersService());
exports.commandActionNotifications = onDocumentWritten({ region: 'us-central1', document: 'commandActions/{actionId}', timeoutSeconds: 120, memory: '256MiB' }, commandActionNotificationHandler);
exports._test = { dayKey, mondayForKey, importedAtMillis, isStaleImportedRecord, visible, assignedScope, recordScope, connectionScope, notificationId, actionRow, connectionRow, unreadThreadRow, dashboardBucket, nextMoveItem, isCurrentMeeting, chooseNextMove };


