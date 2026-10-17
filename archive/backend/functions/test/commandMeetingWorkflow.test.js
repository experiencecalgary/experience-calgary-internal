'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { meetingStatus } = require('../routes/command/commandMeetingLifecycle');
const { meetingLifecycleStatus: queryMeetingStatus } = require('../routes/command/commandActionQueries');
const { _test } = require('../routes/command/commandLeadPerformance');

const helpers = [meetingStatus, queryMeetingStatus, _test.meetingLifecycleStatus];

test('meeting lifecycle helpers preserve explicit statuses', () => {
  for (const helper of helpers) {
    for (const status of ['scheduled', 'in_progress', 'completed', 'no_show', 'cancelled']) {
      assert.equal(helper({ meetingStatus: status }), status);
    }
  }
});

test('meeting lifecycle helpers support legacy Meeting records', () => {
  for (const helper of helpers) {
    assert.equal(helper({ status: 'open' }), 'scheduled');
    assert.equal(helper({ status: 'open', meetingStartedAt: {} }), 'in_progress');
    assert.equal(helper({ status: 'completed', meetingOutcome: 'held' }), 'completed');
    assert.equal(helper({ status: 'completed', meetingOutcome: 'no_show' }), 'no_show');
    assert.equal(helper({ status: 'cancelled' }), 'cancelled');
  }
});

test('terminal Action status wins over stale Meeting status', () => {
  for (const helper of helpers) {
    assert.equal(helper({ status: 'completed', meetingStatus: 'scheduled', meetingOutcome: 'held' }), 'completed');
    assert.equal(helper({ status: 'cancelled', meetingStatus: 'in_progress' }), 'cancelled');
  }
});
