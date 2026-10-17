'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const admin = require('firebase-admin');
const { _test } = require('../routes/command/commandDashboardAutomation');

test('builds Edmonton day keys across UTC midnight', () => {
  assert.equal(_test.dayKey(new Date('2026-08-02T05:30:00.000Z')), '2026-08-01');
});

test('Actions use assignment for distinct Mine and Team scope', () => {
  const teamAction = {
    ownerUid: 'manager',
    assignedToUid: 'rep-user',
    viewerUids: ['manager'],
    teamRepIds: ['manager-rep'],
  };
  assert.equal(_test.assignedScope('mine', 'manager', 'manager-rep', teamAction), false);
  assert.equal(_test.assignedScope('team', 'manager', 'manager-rep', teamAction), true);
  assert.equal(_test.assignedScope('mine', 'rep-user', 'rep-user-id', teamAction), true);
});

test('Flow excludes another assignee from Mine even when the viewer owns it', () => {
  const teamRecord = {
    ownerUid: 'manager',
    assignedToUid: 'rep-user',
    viewerUids: ['manager'],
    teamRepIds: ['manager-rep'],
  };
  assert.equal(_test.recordScope('mine', 'manager', 'manager-rep', teamRecord), false);
  assert.equal(_test.recordScope('team', 'manager', 'manager-rep', teamRecord), true);
});

test('creates deterministic notification ids', () => {
  assert.equal(
    _test.notificationId('u/1', 'action_due_soon', 'a/2', '2026-08-01'),
    _test.notificationId('u/1', 'action_due_soon', 'a/2', '2026-08-01')
  );
});

test('Meetings use startAt for schedule and endAt for required outcome', () => {
  const startAt = admin.firestore.Timestamp.fromDate(new Date('2026-08-01T12:00:00.000Z'));
  const endAt = admin.firestore.Timestamp.fromDate(new Date('2026-08-01T13:00:00.000Z'));
  const doc = { ref: { path: 'commandActions/a1' } };
  const row = _test.actionRow(
    doc,
    { title: 'Demo', actionType: 'meeting', status: 'open', startAt, endAt },
    Date.parse('2026-08-01T13:30:00.000Z'),
    '2026-08-01'
  );
  assert.equal(row.scheduledAt, '2026-08-01T12:00:00.000Z');
  assert.equal(row.requiresOutcome, true);
  assert.equal(row.isOverdue, false);
  assert.equal(row.canRecordOutcome, true);
});

test('recorded Meeting outcomes are not requested again', () => {
  const startAt = admin.firestore.Timestamp.fromDate(new Date('2026-08-01T12:00:00.000Z'));
  const endAt = admin.firestore.Timestamp.fromDate(new Date('2026-08-01T13:00:00.000Z'));
  const doc = { ref: { path: 'commandActions/a2' } };
  const row = _test.actionRow(
    doc,
    { actionType: 'meeting', status: 'open', startAt, endAt, meetingOutcome: 'held' },
    Date.parse('2026-08-01T13:30:00.000Z'),
    '2026-08-01'
  );
  assert.equal(row.requiresOutcome, false);
  assert.equal(row.canRecordOutcome, false);
});


test('stale means imported for seven days with no Action ever created', () => {
  const now = Date.parse('2026-08-31T18:00:00.000Z');
  const oldImport = admin.firestore.Timestamp.fromDate(new Date('2026-08-24T17:59:59.000Z'));
  const recentImport = admin.firestore.Timestamp.fromDate(new Date('2026-08-25T18:00:00.000Z'));
  const base = { stage: 'New', importedAt: oldImport, importBatchId: 'batch_1', archived: false };
  assert.equal(_test.isStaleImportedRecord(base, false, now), true);
  assert.equal(_test.isStaleImportedRecord(base, true, now), false, 'any historical Action prevents stale');
  assert.equal(_test.isStaleImportedRecord({ ...base, importedAt: recentImport }, false, now), false);
  assert.equal(_test.isStaleImportedRecord({ ...base, importedAt: null, importBatchId: '' }, false, now), false, 'manual records are not stale');
  assert.equal(_test.isStaleImportedRecord({ ...base, stage: 'Won' }, false, now), false);
});

test('Monday keys are stable for weekly-plan reminders', () => {
  assert.equal(_test.mondayForKey('2026-08-31'), '2026-08-31');
  assert.equal(_test.mondayForKey('2026-09-06'), '2026-08-31');
});


test('dashboard buckets expose exact totals separately from bounded previews', () => {
  const items = Array.from({ length: 5 }, (_, index) => ({ id: index + 1 }));
  const bucket = _test.dashboardBucket(items, { workspace: 'actions', timing: 'overdue' });
  assert.equal(bucket.totalCount, 5);
  assert.equal(bucket.previewItems.length, 3);
  assert.equal(bucket.showingCount, 3);
  assert.equal(bucket.remainingCount, 2);
  assert.equal(bucket.hasMore, true);
  assert.deepEqual(bucket.destination, { workspace: 'actions', timing: 'overdue' });
});

test('Your Next Move prioritizes active Meetings before cleanup work', () => {
  const move = _test.chooseNextMove({
    now: Date.parse('2026-09-08T16:00:00.000Z'),
    todayMeetings: [{
      itemType: 'meeting',
      refPath: 'commandActions/m1',
      actionRefPath: 'commandActions/m1',
      title: 'Partner Meeting',
      meetingStatus: 'in_progress',
      startAt: '2026-09-08T15:30:00.000Z',
    }],
    meetingOutcomes: [{ itemType: 'meeting', refPath: 'commandActions/m0', title: 'Old Meeting' }],
    overdueActions: [{ itemType: 'action', refPath: 'commandActions/a1', title: 'Call back' }],
    followUpsToday: [],
    atRiskLeads: [],
  });
  assert.equal(move.kind, 'meeting_in_progress');
  assert.equal(move.meetingRefPath, 'commandActions/m1');
  assert.equal(move.actionLabel, 'RESUME MEETING');
});

test('Your Next Move falls back to the authoritative outreach queue', () => {
  const move = _test.chooseNextMove({
    now: Date.now(),
    todayMeetings: [],
    meetingOutcomes: [],
    overdueActions: [],
    followUpsToday: [],
    atRiskLeads: [],
  });
  assert.equal(move.kind, 'start_working');
  assert.deepEqual(move.destination, { workspace: 'outreach', queueMode: 'priority_calls' });
});


test('an in-progress Meeting remains current after its scheduled end', () => {
  const row = {
    itemType: 'meeting',
    status: 'open',
    meetingStatus: 'in_progress',
    scheduledAt: '2026-09-07T23:30:00.000Z',
    endAt: '2026-09-08T00:00:00.000Z',
  };
  assert.equal(
    _test.isCurrentMeeting(row, '2026-09-08', Date.parse('2026-09-08T18:00:00.000Z')),
    true
  );
});
