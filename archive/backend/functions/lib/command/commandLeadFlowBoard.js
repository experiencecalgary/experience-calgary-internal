'use strict';

const admin = require('firebase-admin');
const { HttpsError } = require('firebase-functions/v2/https');
const { isPlatformAdminUser } = require('./commandPersonUtils');
const { clean, visible, iso } = require('./commandOutreachSupport');
const { digest, sizeOf } = require('./commandLeadWorkspace');
const { state, projectWork } = require('./commandLeadWorkState');
const STAGES = ['New', 'Opened', 'Engaged', 'Closing'];
const SNAPSHOTS = 'commandMaintenance/leadFlow/snapshots';
const MAX_LEADS = 2000;
const TTL_MS = 15 * 60 * 1000;
const FIELDS = ['displayName', 'leadType', 'subjectPersonName', 'subjectOrganizationName', 'primaryContactName',
  'connectedPersonNames', 'searchTextNormalized', 'stage', 'status', 'archived', 'ownerUid', 'assignedToUid',
  'assignedToRef', 'assignedToName', 'viewerUids', 'teamRepIds', 'leadListId', 'leadListName', 'source',
  'nextActionRef', 'flowWork', 'flowWorkUpdatedAt', 'stageEnteredAt', 'updatedAt', 'lastActivityAt', 'lastActivityType'];
function workState(data, now) {
  const pointer = data.nextActionRef?.path;
  // Creation writes this pointer atomically; reconciliation arrives asynchronously.
  // A new pointer absent from the projection is evidence that it is not current.
  if (pointer && data.flowWork?.complete === true &&
      (!Array.isArray(data.flowWork.entries) || !data.flowWork.entries.some(entry => entry?.path === pointer))) return { ...state(null, now), pending: true };
  return state(data.flowWork, now);
}
const mine = (ctx, d) => d.ownerUid === ctx.uid || d.assignedToUid === ctx.uid;
function filters(ctx) {
  const i = ctx.input, f = { scope: clean(i.scope).toLowerCase() || 'mine',
    leadType: clean(i.leadType).toLowerCase() || 'all', attentionFilter: clean(i.attentionFilter).toLowerCase() || 'all',
    assignedToUid: clean(i.assignedToUid), leadListId: clean(i.leadListId), search: clean(i.search).toLowerCase() };
  if (ctx.actor.userData.active === false) throw new HttpsError('permission-denied', 'Inactive representative.');
  if (!['mine', 'team', 'all'].includes(f.scope) || (f.scope === 'all' && !isPlatformAdminUser(ctx.actor.userData)))
    throw new HttpsError('permission-denied', 'Choose an available scope.');
  if (!['all', 'person', 'organization'].includes(f.leadType) ||
      !['all', 'overdue', 'no_action', 'missing_outcomes', 'in_progress'].includes(f.attentionFilter))
    throw new HttpsError('invalid-argument', 'Invalid Lead Flow filter.');
  if (f.search.length > 200 || f.assignedToUid.length > 128 || f.leadListId.length > 200)
    throw new HttpsError('invalid-argument', 'Filter is too long.');
  return f;
}
function matches(ctx, d, f) {
  if (d.archived === true || d.status !== 'active' || !STAGES.includes(d.stage) || !visible(ctx.uid, ctx.actor.userData, d)) return false;
  if (f.scope === 'mine' && !mine(ctx, d) || f.scope === 'team' && mine(ctx, d)) return false;
  if (f.leadType !== 'all' && d.leadType !== f.leadType || f.assignedToUid && d.assignedToUid !== f.assignedToUid || f.leadListId && d.leadListId !== f.leadListId) return false;
  return !f.search || [d.searchTextNormalized, d.displayName, d.subjectPersonName, d.subjectOrganizationName,
    d.primaryContactName, ...(d.connectedPersonNames || [])].some(v => clean(v).toLowerCase().includes(f.search));
}
function attentionMatches(s, filter) {
  return filter === 'all' || s.complete && (filter === 'overdue' ? s.overdue : filter === 'no_action' ? s.noAction
    : filter === 'in_progress' ? s.inProgress : s.missingOutcomeCount > 0);
}
function baseQueries(ctx, f) {
  const c = ctx.db.collection('commandLeads'), rep = String(ctx.actor.userData.repId ?? '');
  const reps = rep ? [rep, ...(String(Number(rep)) === rep ? [Number(rep)] : [])] : [];
  let shards = f.scope === 'mine' ? [['ownerUid', '==', ctx.uid], ['assignedToUid', '==', ctx.uid]]
    : isPlatformAdminUser(ctx.actor.userData) ? [null]
      : [['viewerUids', 'array-contains', ctx.uid], ...(rep ? [['teamRepIds', 'array-contains-any', reps]] : [])];
  shards = shards.filter(shard => !shard || shard[0] !== 'assignedToUid' || !f.assignedToUid || shard[2] === f.assignedToUid);
  return shards.map(shard => {
    let q = shard ? c.where(...shard) : c;
    q = q.where('status', '==', 'active');
    if (f.assignedToUid && shard?.[0] !== 'assignedToUid') q = q.where('assignedToUid', '==', f.assignedToUid);
    if (f.leadListId) q = q.where('leadListId', '==', f.leadListId);
    if (f.leadType !== 'all') q = q.where('leadType', '==', f.leadType);
    return q.select(...FIELDS).limit(MAX_LEADS + 1);
  });
}
function fingerprint(ctx, f) {
  // A role/rep change invalidates a saved view, even if the UID stayed the same.
  return digest([ctx.uid, ctx.actor.userData.role, ctx.actor.userData.userType, ctx.actor.userData.repId ?? null, f]);
}
async function buildSnapshot(ctx, f, now) {
  const snapshots = await Promise.all(baseQueries(ctx, f).map(q => q.get()));
  const docs = [...new Map(snapshots.flatMap(s => s.docs).map(d => [d.ref.path, d])).values()];
  if (snapshots.some(s => s.size > MAX_LEADS) || docs.length > MAX_LEADS)
    throw new HttpsError('resource-exhausted', 'Choose a representative or Lead List to narrow this pipeline (maximum 2,000 candidates per view).');
  const columns = Object.fromEntries(STAGES.map(s => [s, []]));
  const totals = { active: 0, overdue: 0, noAction: 0, missingOutcomes: 0, inProgress: 0, unknown: 0, matching: 0,
    ...Object.fromEntries(STAGES.map(s => [s, 0])) };
  for (const doc of docs) {
    const d = doc.data(); if (!matches(ctx, d, f)) continue;
    const s = workState(d, now); totals.active++; totals[d.stage]++;
    if (!s.complete) totals.unknown++;
    if (s.overdue) totals.overdue++;
    if (s.noAction) totals.noAction++;
    if (s.inProgress) totals.inProgress++;
    if (s.missingOutcomeCount) totals.missingOutcomes++;
    if (attentionMatches(s, f.attentionFilter)) { columns[d.stage].push({ id: doc.id, rank: s.rank, at: s.sortAt }); totals.matching++; }
  }
  for (const stage of STAGES) columns[stage] = columns[stage]
    .sort((a, b) => a.rank - b.rank || a.at - b.at || a.id.localeCompare(b.id)).map(r => r.id);
  const ref = ctx.db.collection(SNAPSHOTS).doc();
  const data = { uid: ctx.uid, fingerprint: fingerprint(ctx, f), columns, totals, asOf: now,
    expiresAt: admin.firestore.Timestamp.fromMillis(now + TTL_MS) };
  if (Buffer.byteLength(JSON.stringify(data)) > 800000) throw new HttpsError('resource-exhausted', 'Narrow this pipeline by representative or Lead List.');
  await ref.create(data);
  return { id: ref.id, ...data };
}
function decode(raw, stage) {
  if (!raw) return null;
  try {
    if (typeof raw !== 'string' || raw.length > 1000) throw Error();
    const p = JSON.parse(Buffer.from(raw, 'base64url').toString());
    if (p.v !== 2 || p.stage !== stage || !/^[a-zA-Z0-9_-]{1,100}$/.test(p.id) || !Number.isInteger(p.offset) || p.offset < 0 || p.offset > MAX_LEADS) throw Error();
    return p;
  } catch (_) { throw new HttpsError('invalid-argument', 'Refresh Lead Flow to replace this page token.'); }
}
const token = (id, stage, offset) => Buffer.from(JSON.stringify({ v: 2, id, stage, offset })).toString('base64url');
async function readSnapshot(ctx, f, id, now) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new HttpsError('invalid-argument', 'Invalid pipeline view.');
  const doc = await ctx.db.doc(`${SNAPSHOTS}/${id}`).get(); const d = doc.data();
  if (!doc.exists || d.uid !== ctx.uid || d.fingerprint !== fingerprint(ctx, f))
    throw new HttpsError('permission-denied', 'This pipeline view is no longer available. Refresh.');
  if (d.expiresAt.toMillis() <= now) throw new HttpsError('failed-precondition', 'This pipeline view expired. Refresh.');
  return { id, ...d };
}
function row(ctx, doc, s, now, actions) {
  const d = doc.data(); let next = null, stale = false;
  if (s.next) {
    const action = actions.get(s.next.path);
    if (action?.exists && action.data().leadRef?.path === doc.ref.path && action.data().status === 'open' &&
        action.data().archived !== true) {
      const actual = state(projectWork([action]), now).next;
      stale = !actual || actual.at !== s.next.at || actual.state !== s.next.state || actual.kind !== s.next.kind;
      if (!stale && visible(ctx.uid, ctx.actor.userData, action.data())) next = { refPath: action.ref.path, title: clean(action.data().title), type: clean(action.data().actionType),
        kind: s.next.kind, state: s.next.state, at: s.next.at === null ? null : new Date(s.next.at).toISOString() };
    } else stale = true;
  }
  return { id: doc.id, path: doc.ref.path, name: clean(d.displayName) || 'Unnamed Lead', leadType: d.leadType,
    stage: d.stage, contextName: clean(d.leadType === 'organization' ? d.primaryContactName || d.subjectPersonName : d.subjectOrganizationName),
    subjectPersonName: clean(d.subjectPersonName), subjectOrganizationName: clean(d.subjectOrganizationName),
    primaryContactName: clean(d.primaryContactName), assignedToRefPath: d.assignedToRef?.path || '',
    lastActivityAt: iso(d.lastActivityAt), lastActivityType: clean(d.lastActivityType),
    assignedToUid: clean(d.assignedToUid), assignedToName: clean(d.assignedToName), leadListId: clean(d.leadListId),
    leadListName: clean(d.leadListName), source: clean(d.source), updatedAt: iso(d.updatedAt),
    stageEnteredAt: iso(d.stageEnteredAt), daysInStage: d.stageEnteredAt?.toMillis ? Math.max(0, Math.floor((now - d.stageEnteredAt.toMillis()) / 86400000)) : null,
    overdue: !stale && s.overdue, noAction: !stale && s.noAction, workStateComplete: s.complete && !stale, workStatePending: s.pending === true,
    openWorkCount: s.openWorkCount ?? null, overdueActionCount: s.overdueActionCount ?? null,
    missingOutcomeCount: s.missingOutcomeCount ?? null, inProgress: s.inProgress || false,
    hasFutureCommitment: s.complete ? s.hasFutureCommitment : null,
    nextFutureAt: s.nextFutureAt == null ? null : new Date(s.nextFutureAt).toISOString(),
    workStateStale: stale, nextStep: next, nextStepUnavailable: Boolean(s.next && !next),
    nextActionRefPath: next?.refPath || '', nextActionTitle: next?.title || '', nextActionType: next?.type || '', nextActionAt: next?.at || null,
    primaryAction: next ? { destination: next.kind === 'meeting' ? 'schedule' : 'actions', refPath: next.refPath, leadRefPath: doc.ref.path }
      : { destination: s.noAction ? 'create_action' : 'lead', leadRefPath: doc.ref.path },
    canChangeStage: true, canClose: true };
}
async function list(ctx, now = Date.now()) {
  const f = filters(ctx), i = ctx.input, stages = i.stage ? [clean(i.stage)] : STAGES;
  if (stages.some(s => !STAGES.includes(s))) throw new HttpsError('invalid-argument', 'Invalid stage.');
  const tokens = i.pageTokens || {}, decoded = Object.fromEntries(stages.map(s => [s, decode(tokens[s], s)]));
  const ids = [...new Set([clean(i.snapshotId), ...Object.values(decoded).map(t => t?.id)].filter(Boolean))];
  if (ids.length > 1) throw new HttpsError('invalid-argument', 'Do not mix pipeline views. Refresh.');
  const snapshot = ids.length ? await readSnapshot(ctx, f, ids[0], now) : await buildSnapshot(ctx, f, now);
  const columns = {}; let changed = false;
  for (const stage of stages) {
    const members = snapshot.columns[stage], records = []; let offset = decoded[stage]?.offset || 0, scanned = 0;
    const pageSize = sizeOf(i.pageSize);
    while (offset < members.length && records.length < pageSize && scanned < 100) {
      const ids = members.slice(offset, offset + Math.min(pageSize - records.length, 100 - scanned));
      const docs = await ctx.db.getAll(...ids.map(id => ctx.db.doc(`commandLeads/${id}`)));
      const candidates = [];
      for (const doc of docs) {
        offset++; scanned++;
        if (!doc.exists || !matches(ctx, doc.data(), f) || doc.data().stage !== stage) { changed = true; continue; }
        const s = workState(doc.data(), now);
        if (s.pending) changed = true;
        if (!attentionMatches(s, f.attentionFilter)) { changed = true; continue; }
        if ((doc.data().updatedAt?.toMillis?.() || 0) > snapshot.asOf || (doc.data().flowWorkUpdatedAt?.toMillis?.() || 0) > snapshot.asOf) changed = true;
        candidates.push({ doc, s });
      }
      const actionPaths = [...new Set(candidates.map(({ s }) => s.next?.path).filter(Boolean))];
      const actionDocs = actionPaths.length ? await ctx.db.getAll(...actionPaths.map(path => ctx.db.doc(path))) : [];
      const actions = new Map(actionDocs.map(doc => [doc.ref.path, doc]));
      for (const { doc, s } of candidates) {
        const record = row(ctx, doc, s, now, actions);
        if (record.workStateStale) changed = true;
        records.push(record);
      }
    }
    columns[stage] = { stage, total: members.length, records, hasMore: offset < members.length,
      nextPageToken: offset < members.length ? token(snapshot.id, stage, offset) : '' };
  }
  return { ok: true, result: 'success', ...f, activeStages: STAGES, snapshotId: snapshot.id,
    countsAsOf: new Date(snapshot.asOf).toISOString(), expiresAt: iso(snapshot.expiresAt), totals: snapshot.totals,
    countsComplete: snapshot.totals.unknown === 0, countsAreSnapshot: true, refreshRecommended: changed || now - snapshot.asOf > 60000,
    columns, scopeLabel: f.scope === 'team' && isPlatformAdminUser(ctx.actor.userData) ? 'All other representatives' : f.scope };
}
module.exports = { list, filters, matches, attentionMatches, buildSnapshot, decode, token, SNAPSHOTS, MAX_LEADS };
