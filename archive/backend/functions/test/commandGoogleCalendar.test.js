'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../lib/command/commandGoogleCalendar');

test('virtual events request a unique Google Meet conference', () => {
  const event = _test.eventResource({
    title: 'Strategy Meeting',
    agenda: 'Review next steps',
    startAt: '2026-08-04T20:00:00.000Z',
    endAt: '2026-08-04T20:30:00.000Z',
    timeZone: 'America/Edmonton',
    locationType: 'virtual',
    location: '',
    attendees: [{ email: 'guest@example.com' }],
    requestId: 'action-123',
  });
  assert.equal(event.summary, 'Strategy Meeting');
  assert.equal(event.conferenceData.createRequest.requestId, 'action-123');
  assert.equal(event.conferenceData.createRequest.conferenceSolutionKey.type, 'hangoutsMeet');
  assert.equal(event.location, undefined);
});

test('in-person events use a location and omit conference creation', () => {
  const event = _test.eventResource({
    title: 'Office Meeting',
    agenda: '',
    startAt: '2026-08-04T20:00:00.000Z',
    endAt: '2026-08-04T20:30:00.000Z',
    timeZone: 'America/Edmonton',
    locationType: 'in_person',
    location: '123 Main Street, Calgary',
    attendees: [],
    requestId: 'action-456',
  });
  assert.equal(event.location, '123 Main Street, Calgary');
  assert.equal(event.conferenceData, undefined);
});

test('Meet link extraction supports both Calendar response shapes', () => {
  assert.equal(_test.meetingLink({ hangoutLink: 'https://meet.google.com/abc-defg-hij' }), 'https://meet.google.com/abc-defg-hij');
  assert.equal(_test.meetingLink({ conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/xyz' }] } }), 'https://meet.google.com/xyz');
});
