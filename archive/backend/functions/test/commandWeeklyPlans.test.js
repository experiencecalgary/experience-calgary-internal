'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  __test,
  createRepWeeklyPlanService,
  getRepWeeklyPlanService,
  listTeamWeeklyPlansService,
  updateRepWeeklyPlanService,
  completeWeeklyReviewService,
} = require('../routes/command/commandWeeklyPlans');

const keys = { weekStartKey: '2026-08-10', weekEndKey: '2026-08-16' };
const validPlan = () => ({
  workBlocks: [
    { blockId: 'monday', dayKey: '2026-08-10', startTime: '09:00', endTime: '12:00' },
    { blockId: 'tuesday', dayKey: '2026-08-11', startTime: '13:00', endTime: '17:00' },
  ],
  channels: ['doors', 'crm_outreach'], sitTarget: 8, xTarget: 500,
  weeklyFocus: 'Follow through on every warm lead.',
});

test('week validation accepts Monday and returns Sunday', () => {
  assert.deepEqual(__test.weekKeys('2026-08-10'), keys);
  assert.throws(() => __test.weekKeys('2026-08-11'), /Monday/);
  assert.throws(() => __test.weekKeys('2026-02-30'), /real/);
});

test('Edmonton midnight handles summer, winter, and local Sunday crossover', () => {
  assert.equal(__test.localMidnightUtc('2026-08-10').toISOString(), '2026-08-10T06:00:00.000Z');
  assert.equal(__test.localMidnightUtc('2026-12-10').toISOString(), '2026-12-10T07:00:00.000Z');
  assert.equal(__test.localDateKey(new Date('2026-08-17T03:30:00.000Z')), '2026-08-16');
  assert.equal(__test.mondayForKey('2026-08-16'), '2026-08-10');
});

test('plan normalization derives minutes and preserves simple commitments', () => {
  const plan = __test.normalizePlanInput(validPlan(), keys);
  assert.equal(plan.plannedMinutes, 420);
  assert.equal(plan.sitTarget, 8);
  assert.equal(plan.xTarget, 500);
  assert.deepEqual(plan.channels, ['doors', 'crm_outreach']);
});

test('plan normalization rejects invalid, overlapping, or missing inputs', () => {
  const overlap = validPlan();
  overlap.workBlocks.push({ blockId: 'overlap', dayKey: '2026-08-10', startTime: '11:00', endTime: '13:00' });
  assert.throws(() => __test.normalizePlanInput(overlap, keys), /overlap/);
  const badTime = validPlan(); badTime.workBlocks[0].startTime = '25:00';
  assert.throws(() => __test.normalizePlanInput(badTime, keys), /valid start/);
  const badChannel = validPlan(); badChannel.channels = ['invented'];
  assert.throws(() => __test.normalizePlanInput(badChannel, keys), /valid sales channel/);
  const noFocus = validPlan(); noFocus.weeklyFocus = '';
  assert.throws(() => __test.normalizePlanInput(noFocus, keys), /focus/);
});

test('only held, completed, contact-linked meetings qualify as sits', () => {
  const base = {
    actionType: 'meeting', status: 'completed', meetingOutcome: 'held',
    assignedToUid: 'u1', personRef: { path: 'commandPeople/p1' },
  };
  assert.equal(__test.isContactMeeting(base), true);
  assert.equal(__test.isContactMeeting({ ...base, meetingOutcome: 'no_show' }), false);
  assert.equal(__test.isContactMeeting({ ...base, status: 'open' }), false);
  assert.equal(__test.isContactMeeting({ ...base, personRef: null }), false);
  assert.equal(__test.isContactMeeting({ ...base, personRef: null, organizationRef: { path: 'commandOrganizations/o1' } }), true);
});

test('weekly results group qualifying sits by uid and verified X by rep id', () => {
  const meetings = [
    { actionType: 'meeting', status: 'completed', meetingOutcome: 'held', assignedToUid: 'u1', personRef: { path: 'commandPeople/p1' }, startAt: new Date('2026-08-12T18:00:00Z') },
    { actionType: 'meeting', status: 'completed', meetingOutcome: 'no_show', assignedToUid: 'u1', personRef: { path: 'commandPeople/p1' }, startAt: new Date('2026-08-13T18:00:00Z') },
    { actionType: 'meeting', status: 'completed', meetingOutcome: 'held', assignedToUid: 'u2', personRef: { path: 'commandPeople/p2' }, startAt: new Date('2026-08-16T06:30:00Z') },
  ];
  const orders = [
    { salesRepId: 'R1', datePaid: '2026-08-12T18:00:00Z', xValue: 250, tier: 'vip', attributionStatus: 'rep_attributed', attributionFinalized: true },
    { salesRepId: 'R1', datePaid: '2026-08-13T18:00:00Z', xValue: 250, tier: 'vip', attributionStatus: 'review_required', attributionFinalized: false },
    { salesRepId: 'R2', datePaid: '2026-08-17T07:00:00Z', xValue: 100, tier: 'signature', attributionStatus: 'rep_attributed', attributionFinalized: true },
  ];
  const grouped = __test.groupWeeklyResults(meetings, orders, keys);
  assert.equal(grouped.sitsByUid.get('u1'), 1);
  assert.equal(grouped.sitsByUid.get('u2'), 1, 'Sunday 00:30 Edmonton remains inside the week');
  assert.equal(grouped.xByRepId.get('R1'), 250);
  assert.equal(grouped.xByRepId.has('R2'), false, 'Monday 01:00 Edmonton belongs to the next week');
});

test('target comparisons return stable progress values', () => {
  const results = __test.resultFor(
    { uid: 'u1', repId: 'R1' }, { sitTarget: 4, xTarget: 500 },
    { sitsByUid: new Map([['u1', 3]]), xByRepId: new Map([['R1', 250]]) }
  );
  assert.deepEqual(results, { completedSits: 3, verifiedX: 250, sitPercentage: 75, xPercentage: 50 });
  assert.equal(__test.percent(0, 0), 100);
});


function memoryDb(seed = {}) {
  const store = new Map(Object.entries(seed));
  function snapshot(path) {
    const value = store.get(path);
    return {
      id: path.split('/').pop(), exists: value !== undefined, ref: { path },
      data: () => value,
    };
  }
  function ref(path) {
    return {
      id: path.split('/').pop(), path,
      get: async () => snapshot(path),
      create: async (value) => {
        if (store.has(path)) {
          const error = new Error('already exists'); error.code = 6; throw error;
        }
        store.set(path, value);
      },
    };
  }
  return {
    _store: store,
    doc: (path) => ref(path),
    collection: (name) => ({ doc: (id) => ref(`${name}/${id}`) }),
    getAll: async (...refs) => refs.map((item) => snapshot(item.path)),
    runTransaction: async (handler) => handler({
      get: async (item) => snapshot(item.path),
      update: (item, patch) => store.set(item.path, { ...store.get(item.path), ...patch }),
    }),
  };
}

function serviceContext(db, selectedRep, allowedReps, uid = 'manager') {
  return {
    db, uid, selectedRep, allowedReps,
    actor: { userRef: { path: `users/${uid}` } },
  };
}

test('normalized order dates include payloadRaw date_paid fallback', () => {
  const grouped = __test.groupWeeklyResults([], [{
    salesRepId: 'R1',
    payloadRaw: { date_paid: '2026-08-12T18:00:00Z' },
    xValue: 250, tier: 'vip',
    attributionStatus: 'rep_attributed', attributionFinalized: true,
  }], keys);
  assert.equal(grouped.xByRepId.get('R1'), 250);
});

test('attributed order loading scopes reads to visible leader and team rep IDs', async () => {
  const calls = [];
  const docs = [{ id: 'o1', ref: { path: 'orderIngest/o1' }, data: () => ({}) }];
  const ctx = { db: { collection: () => ({
    where: (field, op, values) => {
      calls.push({ field, op, values });
      return { get: async () => ({ docs }) };
    },
  }) } };
  const reps = Array.from({ length: 31 }, (_, index) => ({ repId: `R${index + 1}` }));
  const loaded = await __test.loadAttributedOrders(ctx, reps);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { field: 'salesRepId', op: 'in', values: reps.slice(0, 30).map((rep) => rep.repId) });
  assert.equal(loaded.length, 1, 'duplicate documents from chunks are removed');
});

test('callable services create once, keep leaders in team rows, and return the locked plan', async () => {
  const rep = { uid: 'rep1', repId: 'R1', name: 'Rep One', refPath: 'users/rep1' };
  const leader = { uid: 'manager', repId: 'M1', name: 'Leader', refPath: 'users/manager', isMe: true };
  const db = memoryDb({
    'users/rep1': { active: true, userType: 'rep' },
    'users/manager': { active: true, userType: 'rep' },
  });
  const context = async () => serviceContext(db, rep, [leader, rep]);
  const request = { data: { repUid: 'rep1', weekStartKey: keys.weekStartKey, ...validPlan() } };
  const created = await createRepWeeklyPlanService(request, {
    context, nowDate: new Date('2026-08-10T18:00:00Z'), serverTimestamp: () => 'SERVER_TIME',
  });
  assert.equal(created.locked, true);
  await assert.rejects(
    createRepWeeklyPlanService(request, { context, nowDate: new Date('2026-08-10T18:00:00Z'), serverTimestamp: () => 'SERVER_TIME' }),
    (error) => error.code === 'already-exists'
  );
  const grouped = { sitsByUid: new Map([['rep1', 3]]), xByRepId: new Map([['R1', 250]]) };
  const viewed = await getRepWeeklyPlanService(request, {
    context, loadWeeklyResults: async () => grouped,
  });
  assert.equal(viewed.plan.status, 'active');
  assert.equal(viewed.plan.locked, true);
  assert.equal(viewed.plan.liveResults.completedSits, 3);

  const listContext = async () => serviceContext(db, leader, [leader, rep]);
  const listed = await listTeamWeeklyPlansService(
    { data: { weekStartKey: keys.weekStartKey } },
    { context: listContext, loadWeeklyResults: async (_ctx, _keys, reps) => {
      assert.deepEqual(reps.map((item) => item.uid), ['manager', 'rep1']);
      return grouped;
    } }
  );
  assert.deepEqual(listed.rows.map((row) => row.rep.uid), ['manager', 'rep1']);
  assert.equal(listed.rows[0].status, 'missing');
  assert.equal(listed.rows[1].status, 'active');
});

test('structure-only reads skip expensive weekly result loading', async () => {
  const rep = { uid: 'rep1', repId: 'R1', name: 'Rep One', refPath: 'users/rep1' };
  const planPath = `repWeeklyPlans/rep1_${keys.weekStartKey}`;
  const db = memoryDb({ [planPath]: { ...validPlan(), ...keys, status: 'active', locked: true } });
  const context = async () => serviceContext(db, rep, [rep]);
  let resultLoads = 0;
  const viewed = await getRepWeeklyPlanService(
    { data: { repUid: 'rep1', weekStartKey: keys.weekStartKey, includeResults: false } },
    { context, loadWeeklyResults: async () => { resultLoads += 1; return { sitsByUid: new Map(), xByRepId: new Map() }; } }
  );
  assert.equal(resultLoads, 0);
  assert.equal(viewed.resultsIncluded, false);
  assert.equal(viewed.plan.liveResults, null);
  assert.equal(viewed.plan.status, 'active');

  const listed = await listTeamWeeklyPlansService(
    { data: { weekStartKey: keys.weekStartKey, includeResults: false } },
    { context, loadWeeklyResults: async () => { resultLoads += 1; return { sitsByUid: new Map(), xByRepId: new Map() }; } }
  );
  assert.equal(resultLoads, 0);
  assert.equal(listed.resultsIncluded, false);
  assert.equal(listed.rows[0].status, 'active');
  assert.equal(listed.rows[0].plan.liveResults, null);
});

test('authorized leaders can amend active current-week team plans with an audit trail', async () => {
  const rep = { uid: 'rep1', repId: 'R1', name: 'Rep One', refPath: 'users/rep1' };
  const planPath = `repWeeklyPlans/rep1_${keys.weekStartKey}`;
  const original = { ...validPlan(), ...keys, status: 'active', locked: true, amendmentCount: 0 };
  const db = memoryDb({ [planPath]: original });
  const context = async () => ({
    ...serviceContext(db, rep, [rep]),
    actor: { userRef: { path: 'users/manager' }, userData: { role: 6 } },
  });
  const replacement = validPlan();
  replacement.sitTarget = 10;
  replacement.xTarget = 800;
  replacement.weeklyFocus = 'Prioritize qualified appointments and same-day follow-up.';

  const result = await updateRepWeeklyPlanService({
    data: { repUid: 'rep1', weekStartKey: keys.weekStartKey, ...replacement },
  }, {
    context,
    nowDate: new Date('2026-08-12T18:00:00Z'),
    serverTimestamp: () => 'SERVER_TIME',
    timestampNow: () => 'AUDIT_TIME',
  });

  assert.equal(result.amendmentCount, 1);
  assert.equal(result.lockedForRep, true);
  const saved = db._store.get(planPath);
  assert.equal(saved.status, 'active');
  assert.equal(saved.locked, true);
  assert.equal(saved.sitTarget, 10);
  assert.equal(saved.xTarget, 800);
  assert.equal(saved.updatedByUid, 'manager');
  assert.equal(saved.amendmentHistory.length, 1);
  assert.equal(saved.amendmentHistory[0].previous.sitTarget, 8);
  assert.equal(saved.amendmentHistory[0].replacement.sitTarget, 10);
});

test('rep self-edits, non-leaders, reviewed plans, and past-week amendments are rejected', async () => {
  const rep = { uid: 'rep1', repId: 'R1', name: 'Rep One', refPath: 'users/rep1' };
  const planPath = `repWeeklyPlans/rep1_${keys.weekStartKey}`;
  const request = { data: { repUid: 'rep1', weekStartKey: keys.weekStartKey, ...validPlan() } };

  const selfDb = memoryDb({ [planPath]: { ...validPlan(), ...keys, status: 'active', locked: true } });
  const selfContext = async () => ({
    ...serviceContext(selfDb, rep, [rep], 'rep1'),
    actor: { userRef: { path: 'users/rep1' }, userData: { role: 6 } },
  });
  await assert.rejects(
    updateRepWeeklyPlanService(request, { context: selfContext, nowDate: new Date('2026-08-12T18:00:00Z') }),
    (error) => error.code === 'permission-denied'
  );

  const juniorContext = async () => ({
    ...serviceContext(selfDb, rep, [rep]),
    actor: { userRef: { path: 'users/manager' }, userData: { role: 5 } },
  });
  await assert.rejects(
    updateRepWeeklyPlanService(request, { context: juniorContext, nowDate: new Date('2026-08-12T18:00:00Z') }),
    (error) => error.code === 'permission-denied'
  );

  const reviewedDb = memoryDb({ [planPath]: { ...validPlan(), ...keys, status: 'reviewed', locked: true } });
  const leaderContext = async () => ({
    ...serviceContext(reviewedDb, rep, [rep]),
    actor: { userRef: { path: 'users/manager' }, userData: { role: 6 } },
  });
  await assert.rejects(
    updateRepWeeklyPlanService(request, { context: leaderContext, nowDate: new Date('2026-08-12T18:00:00Z') }),
    (error) => error.code === 'failed-precondition'
  );

  await assert.rejects(
    updateRepWeeklyPlanService(request, { context: leaderContext, nowDate: new Date('2026-08-20T18:00:00Z') }),
    (error) => error.code === 'failed-precondition'
  );
});

test('manager review enforces timing, required notes, snapshots results, and completes once', async () => {
  const rep = { uid: 'rep1', repId: 'R1', name: 'Rep One', refPath: 'users/rep1' };
  const planPath = `repWeeklyPlans/rep1_${keys.weekStartKey}`;
  const db = memoryDb({ [planPath]: { ...validPlan(), ...keys, status: 'active', locked: true } });
  const context = async () => serviceContext(db, rep, [rep]);
  const base = { repUid: 'rep1', weekStartKey: keys.weekStartKey };
  const grouped = { sitsByUid: new Map([['rep1', 6]]), xByRepId: new Map([['R1', 750]]) };

  await assert.rejects(
    completeWeeklyReviewService({ data: { ...base, repReflection: 'Good', managerCoachingNote: 'Focus' } }, {
      context, todayKey: '2026-08-16', loadWeeklyResults: async () => grouped,
    }),
    (error) => error.code === 'failed-precondition'
  );
  await assert.rejects(
    completeWeeklyReviewService({ data: { ...base, repReflection: '', managerCoachingNote: 'Focus' } }, {
      context, todayKey: '2026-08-17', loadWeeklyResults: async () => grouped,
    }),
    (error) => error.code === 'invalid-argument'
  );
  const result = await completeWeeklyReviewService({
    data: { ...base, repReflection: 'I followed up consistently.', managerCoachingNote: 'Keep the same rhythm.' },
  }, { context, todayKey: '2026-08-17', loadWeeklyResults: async () => grouped, serverTimestamp: () => 'SERVER_TIME' });
  assert.equal(result.status, 'reviewed');
  const saved = db._store.get(planPath);
  assert.equal(saved.status, 'reviewed');
  assert.deepEqual(saved.finalResults, {
    completedSits: 6, verifiedX: 750, sitPercentage: 75, xPercentage: 150,
  });
  await assert.rejects(
    completeWeeklyReviewService({
      data: { ...base, repReflection: 'Again', managerCoachingNote: 'Again' },
    }, { context, todayKey: '2026-08-17', loadWeeklyResults: async () => grouped, serverTimestamp: () => 'SERVER_TIME' }),
    (error) => error.code === 'failed-precondition'
  );
});

test('a leader cannot self-complete their own review', async () => {
  const leader = { uid: 'manager', repId: 'M1', name: 'Leader', refPath: 'users/manager' };
  const db = memoryDb();
  const context = async () => serviceContext(db, leader, [leader]);
  await assert.rejects(
    completeWeeklyReviewService({
      data: {
        repUid: 'manager', weekStartKey: keys.weekStartKey,
        repReflection: 'Reflection', managerCoachingNote: 'Coaching',
      },
    }, { context, todayKey: '2026-08-17', loadWeeklyResults: async () => ({ sitsByUid: new Map(), xByRepId: new Map() }) }),
    (error) => error.code === 'permission-denied'
  );
});
