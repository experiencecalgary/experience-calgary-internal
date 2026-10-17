'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const calendar = require('../lib/command/commandGoogleCalendar')._test;
const meeting = require('../routes/command/commandMeetingLifecycle');
const artifacts = require('../routes/command/commandMeetingArtifacts')._test;

test('extracts a Google Meet code from URLs and space names', () => {
  assert.equal(calendar.meetingCode('https://meet.google.com/abc-defg-hij'), 'abc-defg-hij');
  assert.equal(calendar.meetingCode('spaces/abc-defg-hij'), 'abc-defg-hij');
  assert.equal(calendar.meetingCode('invalid'), '');
});

test('installed Meet client exposes the artifact helpers used directly', () => {
  const { google } = require('googleapis');
  const client = google.meet({ version: 'v2' });
  assert.equal(typeof client.spaces.patch, 'function');
  assert.equal(typeof client.conferenceRecords.transcripts.list, 'function');
  assert.equal(typeof client.conferenceRecords.transcripts.entries.list, 'function');
  assert.equal(typeof client.conferenceRecords.recordings.list, 'function');
  assert.equal(typeof client.conferenceRecords.participants.participantSessions.list, 'function');
});

test('infers safe meeting types while supporting explicit classifications', () => {
  assert.equal(meeting.meetingType({}, true, false), 'sales');
  assert.equal(meeting.meetingType({}, false, true), 'partnership');
  assert.equal(meeting.meetingType({ meetingType: 'internal' }, false, false), 'internal');
  assert.equal(meeting.meetingType({}, false, false), 'general');
});

test('chunks transcript entries deterministically', () => {
  const rows = Array.from({ length: 205 }, (_, index) => ({ text: String(index) }));
  const result = artifacts.chunks(rows, 100);
  assert.deepEqual(result.map(chunk => chunk.length), [100, 100, 5]);
});

test('normalizes transcript entries to Firestore-safe fields', () => {
  assert.deepEqual(artifacts.transcriptEntry({ name: 'entry/1', participant: 'people/1', text: 'Hello' }), {
    name: 'entry/1', participant: 'people/1', text: 'Hello', languageCode: '', startTime: null, endTime: null,
  });
});
