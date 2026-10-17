'use strict';

const admin = require('firebase-admin');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const {
  clean,
  commandActorContext,
  resolveAllowedRepresentatives,
  requireAllowedRepresentative,
} = require('../../lib/command/commandReportingUtils');
const { normalizeOrder } = require('../../lib/orderNormalizer');

const TIME_ZONE = 'America/Edmonton';
const REGION = {
  region: 'us-central1', cors: true, timeoutSeconds: 120, memory: '512MiB',
};
const COLLECTION = 'repWeeklyPlans';
const MAX_WEEK_RECORDS = 5000;
const CHANNELS = new Set([
  'doors', 'activation_tables', 'referrals', 'crm_outreach',
  'partnerships', 'events', 'personal_network', 'other',
]);

function text(value, max = 1000) {
  return clean(value).replace(/\s+/g, ' ').slice(0, max);
}

function dateFromKey(key) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  const date = new Date(`${key}T12:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === key
    ? date : null;
}

function addDays(key, days) {
  const date = dateFromKey(key);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function weekKeys(rawKey) {
  const weekStartKey = text(rawKey, 10);
  const date = dateFromKey(weekStartKey);
  if (!date) {
    throw new HttpsError('invalid-argument', 'weekStartKey must use a real YYYY-MM-DD date.');
  }
  if (date.getUTCDay() !== 1) {
    throw new HttpsError('invalid-argument', 'weekStartKey must be a Monday.');
  }
  return { weekStartKey, weekEndKey: addDays(weekStartKey, 6) };
}

function zonedParts(date, timeZone = TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  return Object.fromEntries(parts
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, Number(part.value)]));
}

function localMidnightUtc(key, timeZone = TIME_ZONE) {
  const date = dateFromKey(key);
  if (!date) throw new HttpsError('invalid-argument', 'A real local date is required.');
  const expected = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  let instant = expected;
  for (let i = 0; i < 3; i += 1) {
    const p = zonedParts(new Date(instant), timeZone);
    instant += expected - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  }
  return new Date(instant);
}

function localDateKey(date = new Date(), timeZone = TIME_ZONE) {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function mondayForKey(dayKey) {
  const date = dateFromKey(dayKey);
  if (!date) throw new HttpsError('invalid-argument', 'A real local date is required.');
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

function planId(uid, weekStartKey) {
  return `${uid}_${weekStartKey}`;
}

function nonNegativeInteger(value, field, max = 1000000) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > max) {
    throw new HttpsError('invalid-argument', `${field} must be a non-negative whole number.`);
  }
  return number;
}

function clockMinutes(value) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function normalizePlanInput(raw, keys) {
  const workBlocks = (Array.isArray(raw.workBlocks) ? raw.workBlocks : []).map((item, index) => {
    const dayKey = text(item?.dayKey, 10);
    const startTime = text(item?.startTime, 5);
    const endTime = text(item?.endTime, 5);
    const start = clockMinutes(startTime);
    const end = clockMinutes(endTime);
    if (!dateFromKey(dayKey) || dayKey < keys.weekStartKey || dayKey > keys.weekEndKey) {
      throw new HttpsError('invalid-argument', 'Every work block must fall inside the selected week.');
    }
    if (start == null || end == null || end <= start) {
      throw new HttpsError('invalid-argument', 'Every work block requires a valid start and end time.');
    }
    return {
      blockId: text(item?.blockId, 80) || `block_${index + 1}`,
      dayKey, startTime, endTime, plannedMinutes: end - start,
    };
  });
  if (!workBlocks.length || workBlocks.length > 30) {
    throw new HttpsError('invalid-argument', 'Add between 1 and 30 work blocks.');
  }
  const ids = new Set();
  for (const block of workBlocks) {
    if (ids.has(block.blockId)) throw new HttpsError('invalid-argument', 'Work block IDs must be unique.');
    ids.add(block.blockId);
  }
  const ordered = [...workBlocks].sort((a, b) =>
    `${a.dayKey}_${a.startTime}`.localeCompare(`${b.dayKey}_${b.startTime}`));
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i].dayKey === ordered[i - 1].dayKey && ordered[i].startTime < ordered[i - 1].endTime) {
      throw new HttpsError('invalid-argument', 'Work blocks may not overlap.');
    }
  }
  const channels = [...new Set((Array.isArray(raw.channels) ? raw.channels : [])
    .map((value) => text(value, 60).toLowerCase()).filter(Boolean))];
  if (!channels.length || channels.some((value) => !CHANNELS.has(value))) {
    throw new HttpsError('invalid-argument', 'Select at least one valid sales channel.');
  }
  const weeklyFocus = text(raw.weeklyFocus, 500);
  if (!weeklyFocus) throw new HttpsError('invalid-argument', 'A weekly focus is required.');
  return {
    workBlocks,
    plannedMinutes: workBlocks.reduce((sum, block) => sum + block.plannedMinutes, 0),
    channels,
    sitTarget: nonNegativeInteger(raw.sitTarget, 'sitTarget', 1000),
    xTarget: nonNegativeInteger(raw.xTarget, 'xTarget', 1000000),
    weeklyFocus,
  };
}

function serialize(value) {
  if (value == null) return value;
  if (typeof value?.toDate === 'function') return value.toDate().toISOString();
  if (typeof value?.path === 'string') return value.path;
  if (Array.isArray(value)) return value.map(serialize);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serialize(item)]));
  }
  return value;
}

async function context(request, selectedUid) {
  const ctx = await commandActorContext(request);
  const allowedReps = await resolveAllowedRepresentatives(ctx);
  const selectedRep = requireAllowedRepresentative(allowedReps, selectedUid, ctx.uid);
  return { ...ctx, allowedReps, selectedRep };
}

function ensureCurrentWeek(keys, nowDate = new Date()) {
  if (keys.weekStartKey !== mondayForKey(localDateKey(nowDate))) {
    throw new HttpsError('failed-precondition', 'Weekly plans can be created or amended only for the current Edmonton week.');
  }
}

function requireManagerAmendmentAccess(ctx) {
  const role = Number(ctx.actor?.userData?.role ?? ctx.actor?.userData?.roleLevel ?? 0);
  if (!Number.isFinite(role) || role < 6 || ctx.selectedRep.uid === ctx.uid) {
    throw new HttpsError(
      'permission-denied',
      'Only an authorized leader may amend a current plan for a representative on their team.'
    );
  }
}

function percent(actual, target) {
  if (target === 0) return actual === 0 ? 100 : 100;
  return Math.round((actual / target) * 1000) / 10;
}

function isContactMeeting(data = {}) {
  const hasContact = Boolean(data.personRef?.path || data.organizationRef?.path || data.personRef || data.organizationRef);
  return text(data.actionType).toLowerCase() === 'meeting'
    && text(data.status).toLowerCase() === 'completed'
    && text(data.meetingOutcome).toLowerCase() === 'held'
    && Boolean(text(data.assignedToUid, 128))
    && hasContact;
}

function paidDate(order = {}) {
  const raw = order.datePaid;
  const date = raw?.toDate ? raw.toDate() : new Date(raw);
  return Number.isNaN(date?.valueOf?.()) ? null : date;
}

function groupWeeklyResults(meetingDocs, orderDocs, keys) {
  const start = localMidnightUtc(keys.weekStartKey);
  const end = localMidnightUtc(addDays(keys.weekEndKey, 1));
  const sitsByUid = new Map();
  const xByRepId = new Map();
  for (const doc of meetingDocs) {
    const data = doc.data ? doc.data() : doc;
    const startAt = data.startAt?.toDate ? data.startAt.toDate() : new Date(data.startAt);
    if (!isContactMeeting(data) || Number.isNaN(startAt.valueOf()) || startAt < start || startAt >= end) continue;
    sitsByUid.set(data.assignedToUid, (sitsByUid.get(data.assignedToUid) || 0) + 1);
  }
  for (const doc of orderDocs) {
    const raw = doc.data ? doc.data() : doc;
    const order = normalizeOrder(raw || {});
    const repId = text(order.salesRepId, 80);
    const date = paidDate(order);
    if (!repId || !date || date < start || date >= end || !order.isPayable || order.isRefunded) continue;
    xByRepId.set(repId, (xByRepId.get(repId) || 0) + Number(order.xValue || 0));
  }
  return { sitsByUid, xByRepId };
}

function chunks(values, size = 30) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

async function loadAttributedOrders(ctx, reps) {
  const repIds = [...new Set((reps || []).map((rep) => text(rep.repId, 80)).filter(Boolean))];
  if (!repIds.length) return [];
  const snapshots = await Promise.all(chunks(repIds).map((ids) =>
    ctx.db.collection('orderIngest').where('salesRepId', 'in', ids).get()));
  const unique = new Map();
  for (const snapshot of snapshots) {
    for (const doc of snapshot.docs) unique.set(doc.ref?.path || doc.id, doc);
  }
  return [...unique.values()];
}

async function loadWeeklyResults(ctx, keys, reps) {
  const start = admin.firestore.Timestamp.fromDate(localMidnightUtc(keys.weekStartKey));
  const end = admin.firestore.Timestamp.fromDate(localMidnightUtc(addDays(keys.weekEndKey, 1)));
  const [meetings, orders] = await Promise.all([
    ctx.db.collection('commandActions').where('startAt', '>=', start).where('startAt', '<', end)
      .limit(MAX_WEEK_RECORDS + 1).get(),
    loadAttributedOrders(ctx, reps),
  ]);
  if (meetings.size > MAX_WEEK_RECORDS) {
    throw new HttpsError('resource-exhausted', 'Weekly meeting data exceeds the reporting safety limit.');
  }
  return groupWeeklyResults(meetings.docs, orders, keys);
}

function resultFor(rep, plan, grouped) {
  const completedSits = grouped.sitsByUid.get(rep.uid) || 0;
  const verifiedX = grouped.xByRepId.get(text(rep.repId, 80)) || 0;
  return {
    completedSits,
    verifiedX,
    sitPercentage: percent(completedSits, Number(plan?.sitTarget || 0)),
    xPercentage: percent(verifiedX, Number(plan?.xTarget || 0)),
  };
}

function publicPlan(snapshot, rep, grouped, todayKey = localDateKey()) {
  if (!snapshot?.exists) return null;
  const plan = snapshot.data() || {};
  const liveResults = grouped ? resultFor(rep, plan, grouped) : null;
  return serialize({
    id: snapshot.id, refPath: snapshot.ref.path, ...plan,
    liveResults,
    displayResults: plan.status === 'reviewed' && plan.finalResults ? plan.finalResults : liveResults,
    reviewAvailable: todayKey >= addDays(plan.weekEndKey, 1),
  });
}

async function createRepWeeklyPlanService(request, dependencies = {}) {
  const getContext = dependencies.context || context;
  const keys = weekKeys(request.data?.weekStartKey);
  ensureCurrentWeek(keys, dependencies.nowDate || new Date());
  const ctx = await getContext(request, request.data?.repUid);
  const repSnap = await ctx.db.doc(ctx.selectedRep.refPath).get();
  const repData = repSnap.data() || {};
  if (!repSnap.exists || repData.active === false || repData.userType !== 'rep') {
    throw new HttpsError('failed-precondition', 'The selected representative must be active.');
  }
  const plan = normalizePlanInput(request.data || {}, keys);
  const ref = ctx.db.collection(COLLECTION).doc(planId(ctx.selectedRep.uid, keys.weekStartKey));
  const serverTimestamp = dependencies.serverTimestamp || (() => admin.firestore.FieldValue.serverTimestamp());
  const now = serverTimestamp();
  await ref.create({
    repUid: ctx.selectedRep.uid,
    repRef: ctx.db.doc(ctx.selectedRep.refPath),
    repId: ctx.selectedRep.repId,
    repName: ctx.selectedRep.name,
    ...keys, timeZone: TIME_ZONE, ...plan,
    status: 'active', locked: true,
    createdAt: now, createdByUid: ctx.uid, createdByRef: ctx.actor.userRef,
    repReflection: '', managerCoachingNote: '',
    finalResults: null, reviewedAt: null, reviewedByUid: null, reviewedByRef: null,
  }).catch((error) => {
    if (error?.code === 6 || error?.code === 'already-exists') {
      throw new HttpsError('already-exists', 'This representative already has a locked plan for the selected week.');
    }
    throw error;
  });
  return { ok: true, result: 'success', planId: ref.id, planRefPath: ref.path, locked: true };
}

async function getRepWeeklyPlanService(request, dependencies = {}) {
  const getContext = dependencies.context || context;
  const getResults = dependencies.loadWeeklyResults || loadWeeklyResults;
  const keys = weekKeys(request.data?.weekStartKey);
  const ctx = await getContext(request, request.data?.repUid);
  const includeResults = request.data?.includeResults !== false;
  const [snapshot, grouped] = await Promise.all([
    ctx.db.collection(COLLECTION).doc(planId(ctx.selectedRep.uid, keys.weekStartKey)).get(),
    includeResults ? getResults(ctx, keys, [ctx.selectedRep]) : Promise.resolve(null),
  ]);
  return {
    ok: true, result: 'success', week: keys, resultsIncluded: includeResults,
    selectedRep: serialize(ctx.selectedRep),
    plan: publicPlan(snapshot, ctx.selectedRep, grouped),
  };
}

async function listTeamWeeklyPlansService(request, dependencies = {}) {
  const getContext = dependencies.context || context;
  const getResults = dependencies.loadWeeklyResults || loadWeeklyResults;
  const keys = weekKeys(request.data?.weekStartKey);
  const ctx = await getContext(request, request.data?.repUid);
  const reps = ctx.allowedReps;
  const includeResults = request.data?.includeResults !== false;
  const refs = reps.map((rep) => ctx.db.collection(COLLECTION).doc(planId(rep.uid, keys.weekStartKey)));
  const [snapshots, grouped] = await Promise.all([
    refs.length ? ctx.db.getAll(...refs) : Promise.resolve([]),
    includeResults ? getResults(ctx, keys, reps) : Promise.resolve(null),
  ]);
  const rows = reps.map((rep, index) => {
    const plan = publicPlan(snapshots[index], rep, grouped);
    return {
      rep: serialize(rep), status: plan?.status || 'missing', planExists: Boolean(plan),
      plan, reviewAvailable: Boolean(plan?.reviewAvailable),
    };
  });
  return {
    ok: true, result: 'success', week: keys, resultsIncluded: includeResults, rows,
    totals: {
      representatives: rows.length,
      missing: rows.filter((row) => !row.planExists).length,
      active: rows.filter((row) => row.status === 'active').length,
      reviewed: rows.filter((row) => row.status === 'reviewed').length,
    },
  };
}

async function updateRepWeeklyPlanService(request, dependencies = {}) {
  const getContext = dependencies.context || context;
  const keys = weekKeys(request.data?.weekStartKey);
  ensureCurrentWeek(keys, dependencies.nowDate || new Date());
  const ctx = await getContext(request, request.data?.repUid);
  requireManagerAmendmentAccess(ctx);
  const replacement = normalizePlanInput(request.data || {}, keys);
  const ref = ctx.db.collection(COLLECTION).doc(planId(ctx.selectedRep.uid, keys.weekStartKey));
  const serverTimestamp = dependencies.serverTimestamp || (() => admin.firestore.FieldValue.serverTimestamp());
  const timestampNow = dependencies.timestampNow || (() => admin.firestore.Timestamp.now());

  let amendmentCount = 0;
  await ctx.db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) throw new HttpsError('not-found', 'Weekly plan not found.');
    const existing = snapshot.data() || {};
    if (existing.status !== 'active' || existing.weekStartKey !== keys.weekStartKey) {
      throw new HttpsError('failed-precondition', 'Only an active current-week plan may be amended.');
    }
    const history = Array.isArray(existing.amendmentHistory)
      ? existing.amendmentHistory.slice(-49) : [];
    amendmentCount = Number(existing.amendmentCount || 0) + 1;
    history.push({
      amendmentNumber: amendmentCount,
      amendedAt: timestampNow(),
      amendedByUid: ctx.uid,
      amendedByRef: ctx.actor.userRef,
      previous: {
        workBlocks: existing.workBlocks || [],
        plannedMinutes: Number(existing.plannedMinutes || 0),
        channels: existing.channels || [],
        sitTarget: Number(existing.sitTarget || 0),
        xTarget: Number(existing.xTarget || 0),
        weeklyFocus: text(existing.weeklyFocus, 500),
      },
      replacement,
    });
    tx.update(ref, {
      ...replacement,
      locked: true,
      updatedAt: serverTimestamp(),
      updatedByUid: ctx.uid,
      updatedByRef: ctx.actor.userRef,
      amendmentCount,
      amendmentHistory: history,
    });
  });
  return {
    ok: true, result: 'success', planId: ref.id, status: 'active',
    lockedForRep: true, amendmentCount,
  };
}

async function completeWeeklyReviewService(request, dependencies = {}) {
  const getContext = dependencies.context || context;
  const getResults = dependencies.loadWeeklyResults || loadWeeklyResults;
  const todayKey = dependencies.todayKey || localDateKey();
  const serverTimestamp = dependencies.serverTimestamp || (() => admin.firestore.FieldValue.serverTimestamp());
  const keys = weekKeys(request.data?.weekStartKey);
  const ctx = await getContext(request, request.data?.repUid);
  if (ctx.selectedRep.uid === ctx.uid) {
    throw new HttpsError('permission-denied', 'An authorized manager must complete the weekly review.');
  }
  if (todayKey < addDays(keys.weekEndKey, 1)) {
    throw new HttpsError('failed-precondition', 'The review opens the following Edmonton Monday.');
  }
  const repReflection = text(request.data?.repReflection, 2000);
  const managerCoachingNote = text(request.data?.managerCoachingNote, 2000);
  if (!repReflection || !managerCoachingNote) {
    throw new HttpsError('invalid-argument', 'Both the rep reflection and manager coaching note are required.');
  }
  const grouped = await getResults(ctx, keys, [ctx.selectedRep]);
  const ref = ctx.db.collection(COLLECTION).doc(planId(ctx.selectedRep.uid, keys.weekStartKey));
  await ctx.db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) throw new HttpsError('not-found', 'Weekly plan not found.');
    const plan = snapshot.data() || {};
    if (plan.status !== 'active') throw new HttpsError('failed-precondition', 'This weekly review is already complete.');
    tx.update(ref, {
      repReflection, managerCoachingNote,
      finalResults: resultFor(ctx.selectedRep, plan, grouped),
      status: 'reviewed', reviewedAt: serverTimestamp(),
      reviewedByUid: ctx.uid, reviewedByRef: ctx.actor.userRef,
    });
  });
  return { ok: true, result: 'success', planId: ref.id, status: 'reviewed' };
}

exports.createRepWeeklyPlanService = createRepWeeklyPlanService;
exports.getRepWeeklyPlanService = getRepWeeklyPlanService;
exports.listTeamWeeklyPlansService = listTeamWeeklyPlansService;
exports.updateRepWeeklyPlanService = updateRepWeeklyPlanService;
exports.completeWeeklyReviewService = completeWeeklyReviewService;
exports.createRepWeeklyPlan = onCall(REGION, createRepWeeklyPlanService);
exports.getRepWeeklyPlan = onCall(REGION, getRepWeeklyPlanService);
exports.listTeamWeeklyPlans = onCall(REGION, listTeamWeeklyPlansService);
exports.updateRepWeeklyPlan = onCall(REGION, updateRepWeeklyPlanService);
exports.completeWeeklyReview = onCall(REGION, completeWeeklyReviewService);
exports.__test = {
  weekKeys, addDays, mondayForKey, localMidnightUtc, localDateKey,
  normalizePlanInput, isContactMeeting, paidDate, groupWeeklyResults, resultFor, percent, chunks, loadAttributedOrders,
  requireManagerAmendmentAccess,
};
