'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const admin = require('firebase-admin');
const presentation = require('../routes/command/commandPartnerPresentation')._test;

test('uses the exact 11 Partner Reveal slides in order', () => {
  assert.deepEqual(presentation.SLIDES, [
    'opening', 'partnership_glance', 'experience_calgary', 'opportunity',
    'signal_decay', 'vip_revival', 'partner_advantage', 'thirty_day_story',
    'complete_partnership', 'partnership_options', 'invitation',
  ]);
});

test('validates slide indexes and matching keys', () => {
  assert.deepEqual(presentation.slide(3, 'opportunity'), { index: 3, key: 'opportunity' });
  assert.throws(() => presentation.slide(11), /pageIndex/);
  assert.throws(() => presentation.slide(3, 'opening'), /pageKey/);
});

test('client event identifiers are deterministic and opaque', () => {
  assert.equal(presentation.eventId('event-1'), presentation.eventId('event-1'));
  assert.notEqual(presentation.eventId('event-1'), presentation.eventId('event-2'));
  assert.equal(presentation.eventId('event-1').length, 64);
});

test('closing a page accumulates active time without losing earlier visits', () => {
  const start = admin.firestore.Timestamp.fromMillis(1000);
  const finish = admin.firestore.Timestamp.fromMillis(6500);
  const result = presentation.closeCurrentPage({
    currentPageIndex: 2,
    currentPageEnteredAt: start,
    pageDurationsSeconds: { experience_calgary: 4 },
    activeDurationSeconds: 4,
  }, finish);
  assert.equal(result.data.pageDurationsSeconds.experience_calgary, 10);
  assert.equal(result.data.activeDurationSeconds, 10);
  assert.equal(result.closed.key, 'experience_calgary');
});

test('caps abandoned page timers so stale browser sessions do not poison analytics', () => {
  const start = admin.firestore.Timestamp.fromMillis(0);
  const finish = admin.firestore.Timestamp.fromMillis((presentation.MAX_PAGE_SECONDS + 600) * 1000);
  const result = presentation.closeCurrentPage({ currentPageIndex: 0, currentPageEnteredAt: start }, finish);
  assert.equal(result.closed.durationSeconds, presentation.MAX_PAGE_SECONDS);
  assert.equal(result.closed.durationCapped, true);
  assert.equal(result.data.timingAnomalyCount, 1);
});

test('requires an active Partnership Meeting during transactional writes', () => {
  assert.doesNotThrow(() => presentation.assertActivePartnershipMeeting({
    actionType: 'meeting', meetingType: 'partnership', meetingStatus: 'in_progress',
  }));
  assert.throws(() => presentation.assertActivePartnershipMeeting({
    actionType: 'meeting', meetingType: 'partnership', meetingStatus: 'completed',
  }), /must still be in progress/);
});

test('rejects a Meeting whose Lead context changed during a presentation', () => {
  const expected = {
    leadRef: { path: 'commandLeads/lead-1' },
    organizationRef: { path: 'commandOrganizations/org-1' },
    personRef: { path: 'commandPeople/person-1' },
  };
  assert.doesNotThrow(() => presentation.assertMeetingContextUnchanged(expected, expected));
  assert.throws(() => presentation.assertMeetingContextUnchanged({
    ...expected, personRef: { path: 'commandPeople/person-2' },
  }, expected), /context changed/);
});
