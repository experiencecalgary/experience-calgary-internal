'use strict';

const admin = require('firebase-admin');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { requireAuth, requireCommandAccess, isPlatformAdminUser } = require('../../lib/command/commandPersonUtils');
const { canAssignTo, assignmentActor } = require('../../lib/command/commandRecordAssignment');

const clean = (v) => typeof v === 'string' ? v.trim() : '';
const serialize = (v) => typeof v?.toDate === 'function' ? v.toDate().toISOString() : (v?.path || v || null);
const callable = (handler) => onCall({ region: 'us-central1', cors: true, timeoutSeconds: 120, memory: '512MiB' }, handler);

function canSeeAction(uid, actorData, data = {}) {
  if (isPlatformAdminUser(actorData)) return true;
  const repId = clean(String(actorData?.repId || ''));
  return clean(data.ownerUid) === uid || clean(data.assignedToUid) === uid ||
    (Array.isArray(data.viewerUids) && data.viewerUids.includes(uid)) ||
    (repId && Array.isArray(data.teamRepIds) && data.teamRepIds.map(String).includes(repId));
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

async function actor(request) {
  const db = admin.firestore(); const uid = requireAuth(request);
  const profile = await requireCommandAccess(db, uid);
  return { db, uid, profile, input: request.data || {} };
}

async function listCommandAssignableUsersService(request) {
  const ctx = await actor(request);
  const snapshot = await ctx.db.collection('users').where('userType', '==', 'rep').get();
  const authority = await assignmentActor(ctx.db, ctx.uid, ctx.profile.userData);
  const users = snapshot.docs.filter(doc => canAssignTo(authority, doc.id, doc.data()))
    .map(doc => ({ refPath: doc.ref.path, uid: doc.id, repId: clean(doc.data().repId), name: clean(doc.data().displayName) || clean(doc.data().fullName) || [clean(doc.data().firstName), clean(doc.data().lastName)].filter(Boolean).join(' '), email: clean(doc.data().email) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, result: 'success', users };
}

function bucket(data, now, today) {
  if (clean(data.actionType).toLowerCase() === 'meeting') {
    const lifecycle = meetingLifecycleStatus(data);
    if (lifecycle === 'in_progress') return 'in_progress';
    const scheduledEnd = data.endAt || data.startAt || data.dueAt;
    if (lifecycle === 'scheduled' && scheduledEnd?.toMillis?.() < now && !clean(data.meetingOutcome)) {
      return 'outcome_required';
    }
  }
  if (data.status === 'open' && data.dueAt?.toMillis?.() < now) return 'overdue';
  if (data.status === 'open' && clean(data.dueDateKey) === today) return 'today';
  return data.status === 'open' ? 'upcoming' : clean(data.status).toLowerCase();
}

async function listCommandActionsPageService(request) {
  const ctx = await actor(request); const input = ctx.input;
  const mineTeam = clean(input.scope).toLowerCase() || 'mine';
  if (!['mine', 'team'].includes(mineTeam)) throw new HttpsError('invalid-argument', 'scope must be mine or team.');
  const collection = ctx.db.collection('commandActions');
  const repId = clean(String(ctx.profile.userData?.repId || ''));
  const hasMeetingRange = Boolean(input.startAtFrom || input.startAtTo);
  // A date-first query uses Firestore's single-field startAt index. Visibility is
  // enforced below, avoiding hidden array-contains + range composite indexes.
  let queries = hasMeetingRange
    ? [collection]
    : mineTeam === 'mine'
      ? [collection.where('assignedToUid', '==', ctx.uid)]
      : isPlatformAdminUser(ctx.profile.userData)
        ? [collection]
        : [
            collection.where('viewerUids', 'array-contains', ctx.uid),
            ...(repId ? [collection.where('teamRepIds', 'array-contains', repId)] : []),
          ];
  if (hasMeetingRange) {
    for (const [field, operator] of [['startAtFrom','>='],['startAtTo','<']]) {
      if (!input[field]) continue;
      const date = new Date(input[field]);
      if (!Number.isFinite(date.getTime())) throw new HttpsError('invalid-argument', 'Invalid meeting date range.');
      queries[0] = queries[0].where('startAt', operator, admin.firestore.Timestamp.fromDate(date));
    }
  }
  const snapshots = await Promise.all(queries.map(query => query.get()));
  const snapshot = {
    docs: [...new Map(snapshots.flatMap(item => item.docs).map(doc => [doc.id, doc])).values()],
  };
  const now = Date.now();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Edmonton', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const typeFilter = clean(input.type).toLowerCase() || 'all'; const statusFilter = clean(input.status).toLowerCase() || 'open'; const timingFilter = clean(input.timing).toLowerCase() || 'all'; const search = clean(input.searchQuery).toLowerCase();
  const rows = snapshot.docs.map(doc => ({ doc, data: doc.data() || {} })).filter(({ data }) => {
    if (!canSeeAction(ctx.uid, ctx.profile.userData, data)) return false;
    const mine = clean(data.assignedToUid) === ctx.uid;
    if (mineTeam === 'mine' && !mine) return false;
    if (mineTeam === 'team' && mine) return false;
    if (input.leadRefPath && serialize(data.leadRef) !== clean(input.leadRefPath)) return false;
    const meeting = clean(data.actionType).toLowerCase() === 'meeting';
    if (typeFilter === 'meeting' && !meeting) return false; if (typeFilter === 'action' && meeting) return false;
    if (statusFilter !== 'all' && clean(data.status).toLowerCase() !== statusFilter) return false;
    if (timingFilter !== 'all' && bucket(data, now, today) !== timingFilter) return false;
    if (search && ![data.title, data.description, data.personName, data.organizationName, data.assignedToName].some(v => clean(v).toLowerCase().includes(search))) return false;
    return data.archived !== true;
  }).sort((a, b) => (a.data.dueAt?.toMillis?.() || Number.MAX_SAFE_INTEGER) - (b.data.dueAt?.toMillis?.() || Number.MAX_SAFE_INTEGER));
  const pageSize = Math.min(Math.max(Number(input.pageSize) || 25, 1), 100); const offset = Math.max(Number(input.pageToken) || 0, 0); const page = rows.slice(offset, offset + pageSize);
  return { ok: true, result: 'success', records: page.map(({ doc, data }) => { const meeting = clean(data.actionType).toLowerCase() === 'meeting'; const meetingStatus = meeting ? meetingLifecycleStatus(data) : ''; const canManageMeeting = ['scheduled', 'in_progress'].includes(meetingStatus); return { id: doc.id, refPath: doc.ref.path, leadRefPath: serialize(data.leadRef) || '', title: clean(data.title), description: clean(data.description), actionType: clean(data.actionType), status: clean(data.status), priority: clean(data.priority), dueAt: serialize(data.dueAt), dueDateKey: clean(data.dueDateKey), timing: bucket(data, now, today), relatedType: clean(data.relatedType), personRefPath: serialize(data.personRef) || '', personName: clean(data.personName), organizationRefPath: serialize(data.organizationRef) || '', organizationName: clean(data.organizationName), assignedToRefPath: serialize(data.assignedToRef) || '', assignedToName: clean(data.assignedToName), startAt: serialize(data.startAt), endAt: serialize(data.endAt), scheduledStartAt: serialize(data.startAt), scheduledEndAt: serialize(data.endAt), actualStartAt: serialize(data.meetingStartedAt), actualFinishAt: serialize(data.meetingFinishedAt), actualDurationSeconds: Number.isFinite(data.meetingDurationSeconds) ? data.meetingDurationSeconds : null, timeZone: clean(data.timeZone), locationType: clean(data.locationType), location: clean(data.location), meetingLink: clean(data.meetingLink), calendarEventLink: clean(data.calendarEventLink), meetingStatus, meetingOutcome: clean(data.meetingOutcome), meetingOutcomeNotes: clean(data.meetingOutcomeNotes), mainBlocker: clean(data.mainBlocker), blockerNotes: clean(data.blockerNotes), canEdit: !meeting && data.status === 'open', canComplete: !meeting && data.status === 'open', canCancel: meeting ? canManageMeeting : data.status === 'open', canStart: meeting && meetingStatus === 'scheduled', canFinish: meeting && meetingStatus === 'in_progress', canMarkNoShow: meeting && meetingStatus === 'scheduled', requiresMeetingOutcome: meeting && bucket(data, now, today) === 'outcome_required', canReschedule: meeting && meetingStatus === 'scheduled' }; }), total: rows.length, hasMore: offset + page.length < rows.length, nextPageToken: offset + page.length < rows.length ? String(offset + page.length) : '' };
}

exports.listCommandAssignableUsersService = listCommandAssignableUsersService;
exports.listCommandActionsPageService = listCommandActionsPageService;
exports.meetingLifecycleStatus = meetingLifecycleStatus;
exports._test = { bucket, meetingLifecycleStatus, canSeeAction };
exports.listCommandAssignableUsers = callable(listCommandAssignableUsersService);
exports.listCommandActionsPage = callable(listCommandActionsPageService);

