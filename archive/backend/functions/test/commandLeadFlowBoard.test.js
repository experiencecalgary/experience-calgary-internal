'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture, Timestamp } = require('./helpers/outreachMemory');
const { state, projectWork } = load('../../lib/command/commandLeadWorkState');
const board = load('../../lib/command/commandLeadFlowBoard');
const workspace = load('../../lib/command/commandLeadWorkspace');
const { closeCommandLeadService, updateCommandLeadService } = load('../../routes/command/commandLeads');
const maintenance = load('../../routes/command/commandLeadFlowMaintenance')._test;
const NOW = 100000;
const projection = entries => ({ version: 1, complete: true, entries });
const entry = (id, at, extra = {}) => ({ path: `commandActions/${id}`, at, end: null, kind: 'action', inProgress: false, hasOutcome: false, ...extra });
const ctx = (f, input = {}) => f.context({ data: input });
function addLead(f, id, extra = {}) {
  f.db.store.set(`commandLeads/${id}`, { ...f.db.store.get(f.leadRef.path), displayName: id,
    flowWork: projection([]), ...extra });
}
function addAction(f, id, at, extra = {}) {
  f.db.store.set(`commandActions/${id}`, { leadRef: f.leadRef, ownerUid: 'u1', status: 'open',
    actionType: 'Follow-up', title: id, dueAt: Timestamp.fromMillis(at), ...extra });
}
test('missing and overflow summaries are unknown, never no-action', () => {
  assert.equal(state(undefined, NOW).complete, false);
  assert.equal(state(undefined, NOW).noAction, false);
  assert.equal(state({ version: 1, complete: false }, NOW).noAction, false);
});
test('future meeting does not hide an overdue action; future commitment remains true', () => {
  const s = state(projection([entry('late', 1), entry('meeting', NOW + 1, { kind: 'meeting', end: NOW + 100 })]), NOW);
  assert.equal(s.overdue, true); assert.equal(s.hasFutureCommitment, true);
  assert.equal(s.next.path, 'commandActions/late'); assert.equal(s.openWorkCount, 2);
});
test('meetings become missing outcomes only after end, and in-progress wins', () => {
  const e = entry('meeting', 1, { kind: 'meeting', end: NOW + 1 });
  assert.equal(state(projection([e]), NOW).next.state, 'upcoming_meeting');
  assert.equal(state(projection([e]), NOW).overdue, false);
  assert.equal(state(projection([e]), NOW + 2).next.state, 'missing_outcome');
  assert.equal(state(projection([{ ...e, inProgress: true }]), NOW + 2).next.state, 'in_progress');
});
test('undated work is not missing work and is not a future commitment', () => {
  const s = state(projection([entry('undated', null)]), NOW);
  assert.equal(s.noAction, false); assert.equal(s.hasFutureCommitment, false); assert.equal(s.next.state, 'unscheduled');
});
test('reconciliation replaces stale pointer, keeps independent work and excludes closed work', async () => {
  const f = fixture(); addAction(f, 'closed', 1, { status: 'completed' }); addAction(f, 'remaining', 2);
  addAction(f, 'archived', 0, { archived: true });
  await workspace.refreshNextAction(f.db, f.leadRef);
  const d = f.db.store.get(f.leadRef.path);
  assert.equal(d.nextActionRef.path, 'commandActions/remaining'); assert.equal(d.flowWork.entries.length, 1);
  f.db.store.get('commandActions/remaining').status = 'completed';
  await workspace.refreshNextAction(f.db, f.leadRef);
  assert.equal(state(f.db.store.get(f.leadRef.path).flowWork, NOW).noAction, true);
});
test('projection excludes completed meetings and never stores titles or private bodies', async () => {
  const f = fixture(); addAction(f, 'meeting', 1, { actionType: 'Meeting', meetingStatus: 'completed', body: 'secret' });
  const p = projectWork((await f.db.collection('commandActions').get()).docs);
  assert.deepEqual(p.entries, []);
});
test('snapshot totals respect search/type/list/rep while attention totals retain context', async () => {
  const f = fixture(); addLead(f, 'a', { leadType: 'organization', leadListId: 'list', flowWork: projection([entry('late', 1)]) });
  addLead(f, 'b', { leadType: 'organization', leadListId: 'list' });
  addLead(f, 'c', { leadType: 'person', leadListId: 'other' });
  const result = await board.list(await ctx(f, { assignedToUid: 'u1', leadListId: 'list', leadType: 'organization', attentionFilter: 'overdue' }), NOW);
  assert.equal(result.totals.active, 2); assert.equal(result.totals.overdue, 1); assert.equal(result.totals.noAction, 1);
  assert.equal(result.totals.matching, 1); assert.equal(result.columns.New.records.length, 1);
  assert.ok(f.db.reads.every(r => r.col !== 'commandLeads' || r.count === 2001));
});
test('new view sorts whole membership before paging, and continuation does not query Leads', async () => {
  const f = fixture(); f.db.store.delete(f.leadRef.path);
  const base = { ownerUid: 'u1', status: 'active', stage: 'New', archived: false };
  for (let n = 0; n < 30; n++) f.db.store.set(`commandLeads/${String(n).padStart(2, '0')}`, { ...base, displayName: 'Item', flowWork: projection([entry('x', 30 - n)]) });
  const first = await board.list(await ctx(f, { stage: 'New', pageSize: 2 }), NOW);
  assert.deepEqual(first.columns.New.records.map(r => r.id), ['29', '28']);
  f.db.reads.length = 0;
  const second = await board.list(await ctx(f, { stage: 'New', pageSize: 2, pageTokens: { New: first.columns.New.nextPageToken } }), NOW);
  assert.deepEqual(second.columns.New.records.map(r => r.id), ['27', '26']);
  assert.equal(f.db.reads.filter(r => r.col === 'commandLeads').length, 0);
  assert.equal(Object.keys(second.columns).length, 1);
});
test('moved or deleted members do not shift remaining offsets; stale counts request refresh', async () => {
  const f = fixture(); addLead(f, 'a'); addLead(f, 'b'); addLead(f, 'c');
  const first = await board.list(await ctx(f, { stage: 'New', pageSize: 1 }), NOW);
  f.db.store.delete('commandLeads/a'); f.db.store.get('commandLeads/b').stage = 'Closing';
  const second = await board.list(await ctx(f, { stage: 'New', pageSize: 1, pageTokens: { New: first.columns.New.nextPageToken } }), NOW);
  assert.equal(second.columns.New.records[0].id, 'c'); assert.equal(second.refreshRecommended, true);
});
test('saved views enforce actor, filter, stage and expiry bindings', async () => {
  const f = fixture(); addLead(f, 'a'); addLead(f, 'b');
  const first = await board.list(await ctx(f, { stage: 'New', pageSize: 1 }), NOW);
  const i = { stage: 'New', snapshotId: first.snapshotId };
  await assert.rejects(board.list(await ctx(f, { ...i, search: 'changed' }), NOW), /view/);
  const other = await ctx(f, i); other.uid = 'u2'; await assert.rejects(board.list(other, NOW), /view/);
  await assert.rejects(board.list(await ctx(f, i), NOW + 900001), /expired/);
  await assert.rejects(board.list(await ctx(f, { stage: 'Closing', pageTokens: { Closing: first.columns.New.nextPageToken } }), NOW), /token/);
  await assert.rejects(board.list(await ctx(f, { pageTokens: { New: '20' } }), NOW), /token/);
});
test('team includes viewer and numeric team access, deduplicates and excludes mine', async () => {
  const f = fixture(); addLead(f, 'shared', { ownerUid: 'u2', assignedToUid: 'u2', viewerUids: ['u1'], teamRepIds: [1] });
  addLead(f, 'numeric', { ownerUid: 'u2', assignedToUid: 'u2', teamRepIds: [1] });
  addLead(f, 'hidden', { ownerUid: 'u3', assignedToUid: 'u3' });
  const result = await board.list(await ctx(f, { scope: 'team' }), NOW);
  assert.equal(result.totals.active, 2);
  assert.deepEqual(result.columns.New.records.map(r => r.id).sort(), ['numeric', 'shared']);
});
test('page hydration rechecks lead and action access without disclosing private action details', async () => {
  const f = fixture(); addAction(f, 'secret', 1, { ownerUid: 'u2', title: 'Private title' });
  addLead(f, 'a', { flowWork: projection([entry('secret', 1)]) });
  const result = await board.list(await ctx(f, {}), NOW);
  const row = result.columns.New.records.find(r => r.id === 'a');
  assert.equal(row.nextStep, null); assert.equal(row.nextStepUnavailable, true); assert.equal(JSON.stringify(result).includes('Private title'), false);
  const snap = result.snapshotId; f.db.store.get('commandLeads/a').ownerUid = 'u2'; f.db.store.get('commandLeads/a').assignedToUid = 'u2';
  const after = await board.list(await ctx(f, { snapshotId: snap }), NOW);
  assert.equal(after.columns.New.records.some(r => r.id === 'a'), false);
});
test('oversized views fail clearly rather than reporting truncated totals', async () => {
  const f = fixture(); for (let n = 0; n < 2001; n++) addLead(f, `id${n}`);
  await assert.rejects(board.list(await ctx(f), NOW), e => e.code === 'resource-exhausted');
});
test('closing from New is retry-safe, rejects conflicting outcomes and retains actions', async () => {
  const f = fixture(); addAction(f, 'keep', NOW + 100);
  const input = { leadRefPath: f.leadRef.path, outcome: 'lost', lostReason: 'Not a fit' };
  const result = await closeCommandLeadService({ data: input }, f);
  assert.equal(result.remainingWorkUnchanged, true); assert.equal(f.db.store.get(f.leadRef.path).status, 'lost');
  assert.equal((await closeCommandLeadService({ data: input }, f)).duplicate, true);
  assert.equal([...f.db.store.keys()].filter(p => p.startsWith('commandConnections/')).length, 1);
  assert.equal(f.db.store.get('commandActions/keep').status, 'open');
  await assert.rejects(closeCommandLeadService({ data: { ...input, outcome: 'won' } }, f), /already closed/);
});
test('closing rejects stale revisions and lost reason omissions', async () => {
  const f = fixture(); f.db.store.get(f.leadRef.path).updatedAt = Timestamp.fromMillis(NOW);
  await assert.rejects(closeCommandLeadService({ data: { leadRefPath: f.leadRef.path, outcome: 'won', expectedUpdatedAt: 'old' } }, f), /changed/);
  await assert.rejects(closeCommandLeadService({ data: { leadRefPath: f.leadRef.path, outcome: 'lost' } }, f), /reason/);
  assert.equal(f.db.store.get(f.leadRef.path).status, 'active');
});
test('repair is admin-only, bounded and preserves unknown historical stage age', async () => {
  const f = fixture(); await assert.rejects(maintenance.repair({ data: {} }, f), /administrators/);
  f.db.store.get('users/u1').role = 'platform_admin'; for (let n = 0; n < 24; n++) addLead(f, `item${n}`);
  const first = await maintenance.repair({ data: {} }, f);
  assert.equal(first.processed, 20); assert.equal(first.hasMore, true); assert.equal(first.stageAgesBackfilled, false);
  const second = await maintenance.repair({ data: { afterId: first.afterId } }, f);
  assert.equal(second.processed, 5); assert.equal(second.hasMore, false);
  assert.equal(f.db.store.get(f.leadRef.path).stageEnteredAt, undefined);
});

test('manual stage changes require a reason and record the stage entry timestamp', async () => {
  const f = fixture(); Object.assign(f.db.store.get(f.leadRef.path), { leadType: 'person', subjectPersonRef: f.personRef });
  const input = { leadRefPath: f.leadRef.path, stage: 'Engaged' };
  await assert.rejects(updateCommandLeadService({ data: input }, f), /Explain what changed/);
  assert.equal(f.db.store.get(f.leadRef.path).stage, 'New');
  await updateCommandLeadService({ data: { ...input, stageChangeReason: 'Confirmed interest' } }, f);
  assert.equal(f.db.store.get(f.leadRef.path).stage, 'Engaged');
  assert.ok(f.db.store.get(f.leadRef.path).stageEnteredAt.toMillis());
  assert.equal([...f.db.store.values()].filter(d => d.type === 'lead_stage_changed').length, 1);
});
test('rep filtering never constructs contradictory assignedToUid predicates', async () => {
  const f = fixture(); addLead(f, 'delegated', { assignedToUid: 'u2' });
  const result = await board.list(await ctx(f, { assignedToUid: 'u2' }), NOW);
  assert.equal(result.totals.active, 1);
  for (const read of f.db.reads) assert.ok(read.filters.filter(x => x[0] === 'assignedToUid').length <= 1);
});
test('a changed action date is not advertised using the stale projection', async () => {
  const f = fixture(); addAction(f, 'changed', NOW + 100);
  f.db.store.get(f.leadRef.path).flowWork = projection([entry('changed', 1)]);
  const result = await board.list(await ctx(f), NOW);
  const row = result.columns.New.records[0];
  assert.equal(row.workStateStale, true); assert.equal(row.nextStep, null); assert.equal(result.refreshRecommended, true);
});
test('clock rollover invalidates a saved overdue filter without waiting for a write', async () => {
  const f = fixture(); f.db.store.get(f.leadRef.path).flowWork = projection([entry('future', NOW + 1)]);
  assert.equal((await board.list(await ctx(f, { attentionFilter: 'overdue' }), NOW)).totals.overdue, 0);
  assert.equal((await board.list(await ctx(f, { attentionFilter: 'overdue' }), NOW + 2)).totals.overdue, 1);
});

test('new action pointer pending reconciliation cannot appear as no-action', async () => {
  const f = fixture(); addAction(f, 'new', NOW + 100);
  Object.assign(f.db.store.get(f.leadRef.path), { flowWork: projection([]), nextActionRef: f.db.doc('commandActions/new') });
  const result = await board.list(await ctx(f, {}), NOW);
  assert.equal(result.totals.noAction, 0); assert.equal(result.totals.unknown, 1); assert.equal(result.countsComplete, false);
  const row = result.columns.New.records[0];
  assert.equal(row.noAction, false); assert.equal(row.workStatePending, true); assert.equal(row.primaryAction.destination, 'lead');
  assert.equal((await board.list(await ctx(f, { attentionFilter: 'no_action' }), NOW)).columns.New.records.length, 0);
});
test('card action hydration uses one batch per page, not a serial request per card', async () => {
  const f = fixture(); f.db.store.get(f.leadRef.path).flowWork = projection([]);
  for (let n = 0; n < 20; n++) {
    addLead(f, `item${n}`, { flowWork: projection([entry(`a${n}`, 1)]) });
    addAction(f, `a${n}`, 1, { leadRef: f.db.doc(`commandLeads/item${n}`) });
  }
  const original = f.db.getAll, batches = [];
  f.db.getAll = async (...refs) => { batches.push(refs.map(r => r.path)); return original(...refs); };
  const result = await board.list(await ctx(f, { stage: 'New', pageSize: 20 }), NOW);
  assert.equal(result.columns.New.records.length, 20);
  const actions = batches.filter(paths => paths[0]?.startsWith('commandActions/'));
  assert.equal(actions.length, 1); assert.equal(actions[0].length, 20);
  assert.ok(result.columns.New.records.every(r => r.nextStep));
});
test('inactive representatives cannot change a stage through the mutation endpoint', async () => {
  const f = fixture(); f.db.store.get('users/u1').active = false;
  await assert.rejects(updateCommandLeadService({ data: { leadRefPath: f.leadRef.path, stage: 'Engaged', stageChangeReason: 'Interest' } }, f), /Inactive/);
  assert.equal(f.db.store.get(f.leadRef.path).stage, 'New');
});
test('cleanup removes only a bounded batch of expired saved views', async () => {
  const f = fixture();
  for (let n = 0; n < 105; n++) f.db.store.set(`${board.SNAPSHOTS}/old${n}`, { expiresAt: Timestamp.fromMillis(1) });
  f.db.store.set(`${board.SNAPSHOTS}/current`, { expiresAt: Timestamp.fromMillis(Date.now() + 100000) });
  await maintenance.cleanup({}, f);
  assert.equal([...f.db.store.keys()].filter(p => p.startsWith(board.SNAPSHOTS + '/old')).length, 5);
  assert.equal(f.db.store.has(`${board.SNAPSHOTS}/current`), true);
  assert.equal(f.db.reads.at(-1).count, 100);
});

test('additive index checklist covers every supported scope and pushed filter combination', async () => {
  const definitions = require('../../docs/LEAD_FLOW_INDEXES.json').indexes;
  for (const admin of [false, true]) for (const scope of (admin ? ['mine', 'team', 'all'] : ['mine', 'team'])) {
    for (const leadType of ['all', 'person']) for (const leadListId of ['', 'list']) for (const assignedToUid of ['', 'u1', 'u2']) {
      const f = fixture(); if (admin) f.db.store.get('users/u1').role = 'platform_admin';
      await board.list(await ctx(f, { scope, leadType, leadListId, assignedToUid }), NOW);
      for (const q of f.db.reads.filter(r => r.col === 'commandLeads')) {
        const required = [...new Map(q.filters.map(([field, op]) => [field, op.startsWith('array-') ? 'CONTAINS' : 'ASCENDING'])).entries()];
        if (required.length < 2) continue;
        assert.ok(definitions.some(index => index.fields.length === required.length && required.every(([field, mode]) =>
          index.fields.some(f => f.fieldPath === field && (f.order || f.arrayConfig) === mode))), JSON.stringify(q.filters));
      }
    }
  }
});
