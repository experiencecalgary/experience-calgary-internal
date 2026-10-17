'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { _test } = require('../routes/command/commandLeadPerformance');

test('existing activity types map to one performance vocabulary', () => {
  assert.equal(_test.canonicalEventType('call'), 'call_finished');
  assert.equal(_test.canonicalEventType('email_out'), 'email_sent');
  assert.equal(_test.canonicalEventType('email_in'), 'email_received');
  assert.equal(_test.canonicalEventType('meeting_scheduled'), 'meeting_booked');
  assert.equal(_test.canonicalEventType('meeting_held'), 'meeting_finished');
  assert.equal(_test.canonicalEventType('presentation_started'), 'presentation_started');
  assert.equal(_test.canonicalEventType('presentation_completed'), 'presentation_completed');
  assert.equal(_test.canonicalEventType('stage_change'), 'stage_changed');
  assert.equal(_test.canonicalEventType('unknown_event'), '');
});

test('duration is calculated from actual start and finish timestamps', () => {
  assert.equal(_test.secondsBetween(new Date('2026-09-05T10:00:00Z'), new Date('2026-09-05T10:27:32Z')), 1652);
  assert.equal(_test.secondsBetween(new Date('2026-09-05T10:10:00Z'), new Date('2026-09-05T10:00:00Z')), 0);
  assert.equal(_test.secondsBetween(null, new Date()), null);
});

test('Action completion is classified on time or late', () => {
  assert.deepEqual(_test.actionTiming({
    dueAt: new Date('2026-09-05T12:00:00Z'),
    completedAt: new Date('2026-09-05T11:59:59Z'),
  }), { completedOnTime: true, completionTiming: 'on_time' });
  assert.deepEqual(_test.actionTiming({
    dueAt: new Date('2026-09-05T12:00:00Z'),
    completedAt: new Date('2026-09-05T12:00:01Z'),
  }), { completedOnTime: false, completionTiming: 'late' });
});

test('meaningful connection rules use real customer engagement', () => {
  assert.equal(_test.isMeaningful('call_finished', 'connected'), true);
  assert.equal(_test.isMeaningful('call_finished', 'voicemail'), false);
  assert.equal(_test.isMeaningful('email_received', 'received'), true);
  assert.equal(_test.isMeaningful('meeting_finished', 'held'), true);
  assert.equal(_test.isMeaningful('agreement_signed', 'signed'), true);
});

test('stage and outcome values are normalized from legacy details', () => {
  assert.deepEqual(_test.stageFields({ details: { fromStage: 'Opened', toStage: 'Engaged' } }), {
    previousStage: 'Opened',
    nextStage: 'Engaged',
  });
  assert.equal(_test.outcomeFor('lead_lost', {}, {}), 'lost');
  assert.equal(_test.outcomeFor('call_finished', { details: { outcome: 'CONNECTED' } }, {}), 'connected');
});

