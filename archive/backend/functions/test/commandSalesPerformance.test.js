'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReport, _test } = require('../lib/command/commandSalesPerformanceMetrics');

const event = (eventType, hour, extra = {}) => ({
  performanceVersion: 1, performanceLinkStatus: 'linked', leadPath: extra.leadPath || 'commandLeads/a',
  eventType, eventAt: new Date(`2026-09-01T${String(hour).padStart(2, '0')}:00:00Z`), repName: 'Alex', ...extra,
});

test('calculates contact and ordered funnel conversions', () => {
  const report = buildReport([
    event('call_finished', 15, { outcome: 'connected' }),
    event('call_finished', 16, { outcome: 'no_answer' }),
    event('meeting_booked', 17),
    event('meeting_finished', 18, { durationSeconds: 2700, outcome: 'positive' }),
    event('agreement_sent', 19),
    event('lead_won', 20),
  ]);
  assert.deepEqual(report.metrics.contactRate, { attempts: 2, meaningfulConnections: 1, rate: 50 });
  assert.equal(report.metrics.callsToMeetings.rate, 100);
  assert.equal(report.metrics.meetingsToAgreements.rate, 100);
  assert.equal(report.metrics.agreementsToWon.rate, 100);
  assert.equal(report.metrics.meetingLength.averageMinutes, 45);
});

test('does not count a conversion that happened before its prerequisite', () => {
  const result = _test.sequenceConversion([event('meeting_booked', 10), event('call_finished', 11)], 'call_finished', 'meeting_booked');
  assert.deepEqual(result, { started: 1, converted: 0, rate: 0 });
});

test('measures attendance, follow-up reliability, lost reasons and unknown coverage', () => {
  const report = buildReport([
    event('meeting_finished', 10, { durationSeconds: 1800 }),
    event('meeting_no_show', 11, { leadPath: 'commandLeads/b' }),
    event('action_completed', 12, { completedOnTime: true }),
    event('action_completed', 13, { completedOnTime: false }),
    event('lead_lost', 14, { lostReason: 'Timing' }),
  ]);
  assert.equal(report.metrics.meetingAttendance.rate, 50);
  assert.equal(report.metrics.followUpReliability.rate, 50);
  assert.deepEqual(report.metrics.lostReasons[0], { name: 'Timing', count: 1 });
  assert.equal(report.coverage.industryKnown, 0);
});

test('counts attempts through the first meaningful connection per Lead', () => {
  const result = _test.attemptsBeforeConnection([
    event('call_finished', 10, { outcome: 'no_answer' }),
    event('email_sent', 11),
    event('email_received', 12),
  ]);
  assert.deepEqual(result, { connectedLeads: 1, average: 2, median: 2 });
});

test('does not treat an inbound reply from earlier outreach as zero attempts', () => {
  const result = _test.attemptsBeforeConnection([event('email_received', 10)]);
  assert.deepEqual(result, { connectedLeads: 0, average: null, median: null });
});

test('calculates completed stage intervals without estimating an open stage', () => {
  const result = _test.stageTiming([
    event('stage_changed', 10, { nextStage: 'Opened' }),
    event('stage_changed', 12, { previousStage: 'Opened', nextStage: 'Engaged' }),
  ]);
  assert.deepEqual(result, [{ stage: 'Opened', transitions: 1, averageHours: 2, medianHours: 2 }]);
});
