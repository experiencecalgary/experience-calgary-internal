'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../routes/command/commandCallQueueV2');

const now = Date.parse('2026-08-31T18:00:00.000Z');
const row = (overrides = {}) => ({
  data: { stage: 'New', ...(overrides.data || {}) }, untouched: false, nextAt: null,
  nextAction: { title: '', type: '', ref: null, at: null }, lastMeaningful: null,
  lastActivityAt: now, hasOpenAction: false, noOpenAction: true,
  noFutureAction: true, calledToday: false,
  ...overrides,
});

test('advanced queue modes remain available', () => {
  assert.equal(_test.matchesQueueMode(row({ untouched: true }), 'new_leads', now), true);
  assert.equal(_test.matchesQueueMode(row({ nextAt: now - 1 }), 'follow_ups_due', now), true);
  assert.equal(_test.matchesQueueMode(row({ lastMeaningful: now - _test.RECONNECT_AFTER_MS - 1 }), 'reconnect', now), true);
  assert.equal(_test.normalizeMode('follow-ups-due'), 'follow_ups_due');
});

test('lead type defaults to all and accepts legacy values', () => {
  assert.equal(_test.normalizeType(), 'all');
  assert.equal(_test.normalizeType('people'), 'person');
  assert.equal(_test.normalizeType('organizations'), 'organization');
});

test('best contact prefers a callable primary contact then email', () => {
  const people = new Map([
    ['commandPeople/primary', { fullName: 'Primary', phone: '4035551212', email: 'primary@example.com' }],
    ['commandPeople/other', { fullName: 'Other', phone: 'bad', email: 'other@example.com' }],
  ]);
  const lead = {
    primaryContactRef: { path: 'commandPeople/primary' },
    connectedPersonRefs: [{ path: 'commandPeople/other' }],
  };
  assert.equal(_test.chooseBestContact(lead, people).name, 'Primary');
  people.get('commandPeople/primary').doNotCall = true;
  people.get('commandPeople/primary').email = '';
  assert.equal(_test.chooseBestContact(lead, people).name, 'Other');
});

test('recommendation explains the strongest reason', () => {
  const result = _test.recommendation(row({
    data: { stage: 'Closing' }, nextAt: now - 86400000,
    nextAction: { title: 'Decision follow-up' }, noFutureAction: true,
  }), now);
  assert.match(result.reason, /Decision follow-up is 1 day overdue/);
  assert.ok(result.score > 100000);
});

test('an overdue open Action is not described as missing', () => {
  const result = _test.recommendation(row({
    data: { stage: 'Closing' }, nextAt: now - 1,
    nextAction: { title: 'Decision follow-up' },
    hasOpenAction: true, noOpenAction: false, noFutureAction: true,
  }), now);
  assert.equal(result.reasons.length, 1);
  assert.match(result.reason, /overdue/);
});

test('phone validation remains conservative', () => {
  assert.equal(_test.validPhone('(403) 555-1212'), true);
  assert.equal(_test.validPhone('555-1212'), false);
});
