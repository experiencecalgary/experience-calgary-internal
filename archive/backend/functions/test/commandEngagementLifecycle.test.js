'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const admin = require('firebase-admin');
const { _test } = require('../routes/command/commandEngagementLifecycle');

test('normalizes singular and plural record types', () => {
  assert.equal(_test.normalizeType('People'), 'person');
  assert.equal(_test.normalizeType('organization'), 'organization');
});

test('builds Edmonton date keys for Action bucketing', () => {
  const value = admin.firestore.Timestamp.fromDate(new Date('2026-08-02T05:30:00.000Z'));
  assert.equal(_test.dateKey(value), '2026-08-01');
});


test('defines the final frontend activity groups', () => {
  assert.deepEqual([..._test.ACTIVITY_GROUPS.emails], ['email_in', 'email_out']);
  assert.ok(_test.ACTIVITY_GROUPS.actions.has('action_completed'));
  assert.ok(_test.ACTIVITY_GROUPS.meetings.has('meeting_scheduled'));
  assert.ok(_test.ACTIVITY_GROUPS.flow.has('stage_change'));
});

test('round-trips opaque Connections cursor values', () => {
  const createdAt = admin.firestore.Timestamp.fromMillis(1785564000000);
  const token = _test.encodeConnectionCursor({
    id: 'connection-123',
    data: () => ({ createdAt }),
  });
  const decoded = _test.decodeConnectionCursor(token);
  assert.equal(decoded.createdAt.toMillis(), createdAt.toMillis());
  assert.equal(decoded.id, 'connection-123');
});
