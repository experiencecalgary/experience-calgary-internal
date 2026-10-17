'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const admin = require('firebase-admin');
const { _test } = require('../routes/command/commandActionQueries');

test('Meeting outcome timing uses scheduled end instead of a stale dueAt', () => {
  const now = Date.parse('2026-09-08T18:00:00.000Z');
  const data = {
    actionType: 'meeting',
    status: 'open',
    startAt: admin.firestore.Timestamp.fromDate(new Date('2026-09-08T16:00:00.000Z')),
    endAt: admin.firestore.Timestamp.fromDate(new Date('2026-09-08T17:00:00.000Z')),
    dueAt: admin.firestore.Timestamp.fromDate(new Date('2026-09-09T17:00:00.000Z')),
  };
  assert.equal(_test.bucket(data, now, '2026-09-08'), 'outcome_required');
});

test('Meeting with a recorded outcome is not returned as outcome required', () => {
  const now = Date.parse('2026-09-08T18:00:00.000Z');
  const data = {
    actionType: 'meeting',
    status: 'open',
    meetingOutcome: 'held',
    startAt: admin.firestore.Timestamp.fromDate(new Date('2026-09-08T16:00:00.000Z')),
    endAt: admin.firestore.Timestamp.fromDate(new Date('2026-09-08T17:00:00.000Z')),
  };
  assert.notEqual(_test.bucket(data, now, '2026-09-08'), 'outcome_required');
});


test('Action visibility accepts team lineage without broadening Mine', () => {
  const actor = { repId: 'leader-rep' };
  const teamAction = {
    ownerUid: 'rep-user',
    assignedToUid: 'rep-user',
    viewerUids: [],
    teamRepIds: ['leader-rep'],
  };
  assert.equal(_test.canSeeAction('leader-user', actor, teamAction), true);
  assert.equal(_test.canSeeAction('unrelated-user', { repId: 'other-rep' }, teamAction), false);
});
