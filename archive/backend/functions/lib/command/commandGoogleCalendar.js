'use strict';

const { google } = require('googleapis');
const { defineSecret, defineString } = require('firebase-functions/params');

const COMMAND_CALENDAR_ID = defineString('COMMAND_CALENDAR_ID', {
  default: 'curator@experiencecalgary.ca',
});
const COMMAND_CALENDAR_OAUTH_CLIENT_ID = defineSecret('COMMAND_CALENDAR_OAUTH_CLIENT_ID');
const COMMAND_CALENDAR_OAUTH_CLIENT_SECRET = defineSecret('COMMAND_CALENDAR_OAUTH_CLIENT_SECRET');
const COMMAND_CALENDAR_OAUTH_REFRESH_TOKEN = defineSecret('COMMAND_CALENDAR_OAUTH_REFRESH_TOKEN');

const calendarSecrets = [
  COMMAND_CALENDAR_OAUTH_CLIENT_ID,
  COMMAND_CALENDAR_OAUTH_CLIENT_SECRET,
  COMMAND_CALENDAR_OAUTH_REFRESH_TOKEN,
];

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function calendarId() {
  const value = clean(COMMAND_CALENDAR_ID.value());
  if (!value) {
    throw new Error('COMMAND_CALENDAR_ID is not configured.');
  }
  return value;
}

function secretValue(secret, name) {
  const value = clean(secret.value());
  if (!value) {
    throw new Error(`${name} is not configured.`);
  }
  return value;
}

async function authClient() {
  const auth = new google.auth.OAuth2(
    secretValue(COMMAND_CALENDAR_OAUTH_CLIENT_ID, 'COMMAND_CALENDAR_OAUTH_CLIENT_ID'),
    secretValue(COMMAND_CALENDAR_OAUTH_CLIENT_SECRET, 'COMMAND_CALENDAR_OAUTH_CLIENT_SECRET')
  );
  auth.setCredentials({
    refresh_token: secretValue(
      COMMAND_CALENDAR_OAUTH_REFRESH_TOKEN,
      'COMMAND_CALENDAR_OAUTH_REFRESH_TOKEN'
    ),
  });
  return auth;
}

async function client() {
  return google.calendar({ version: 'v3', auth: await authClient() });
}

function eventResource(input) {
  const virtual = input.locationType === 'virtual';
  const resource = {
    summary: input.title,
    description: input.agenda || '',
    start: { dateTime: input.startAt, timeZone: input.timeZone },
    end: { dateTime: input.endAt, timeZone: input.timeZone },
    attendees: input.attendees,
    guestsCanInviteOthers: false,
    guestsCanModify: false,
    guestsCanSeeOtherGuests: true,
  };
  if (virtual) {
    resource.conferenceData = {
      createRequest: {
        requestId: input.requestId,
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    };
  } else {
    resource.location = input.location;
  }
  return resource;
}

function meetingLink(event = {}) {
  return clean(event.hangoutLink) ||
    (event.conferenceData?.entryPoints || [])
      .find((entry) => entry.entryPointType === 'video')?.uri || '';
}

function meetingCode(value) {
  const raw = clean(value);
  const match = raw.match(/(?:(?:meet\.google\.com\/)|(?:spaces\/))?([a-z]{3}-[a-z]{4}-[a-z]{3})(?:\?.*)?$/i);
  return match ? match[1].toLowerCase() : '';
}

async function configureMeetArtifacts(link, options = {}) {
  const code = meetingCode(link);
  if (!code) throw new Error('The Google Meet code could not be resolved.');
  const meet = google.meet({ version: 'v2', auth: await authClient() });
  const name = `spaces/${code}`;
  const requestBody = {
    config: {
      attendanceReportGenerationType: options.attendance === false
        ? 'DO_NOT_GENERATE'
        : 'GENERATE_REPORT',
      artifactConfig: {
        transcriptionConfig: {
          autoTranscriptionGeneration: options.transcription === false ? 'OFF' : 'ON',
        },
        smartNotesConfig: {
          autoSmartNotesGeneration: options.smartNotes === false ? 'OFF' : 'ON',
        },
        recordingConfig: { autoRecordingGeneration: 'OFF' },
      },
    },
  };
  const response = await meet.spaces.patch({
    name,
    updateMask: 'config.attendanceReportGenerationType,config.artifactConfig',
    requestBody,
  });
  const space = response.data || {};
  return { meetSpaceName: clean(space.name) || name, meetingCode: code, config: space.config || requestBody.config };
}

async function conferenceRecordsForSpace(spaceName) {
  const meet = google.meet({ version: 'v2', auth: await authClient() });
  const response = await meet.conferenceRecords.list({
    filter: `space.meeting_code = "${meetingCode(spaceName)}"`,
    pageSize: 25,
  });
  return { meet, records: response.data?.conferenceRecords || [] };
}

async function listAll(method, args, field) {
  const rows = []; let pageToken;
  do {
    const response = await method({ ...args, pageSize: 100, ...(pageToken ? { pageToken } : {}) });
    rows.push(...(response.data?.[field] || []));
    pageToken = clean(response.data?.nextPageToken);
  } while (pageToken);
  return rows;
}

// Smart Notes reached the Meet REST API before the generated googleapis v2
// resource exposed conferenceRecords.smartNotes. Use the same authenticated
// client directly so one missing generated helper cannot break all artifacts.
async function listSmartNotes(parent) {
  const auth = await authClient();
  const rows = []; let pageToken;
  do {
    const response = await auth.request({
      url: `https://meet.googleapis.com/v2/${parent}/smartNotes`,
      method: 'GET',
      params: { pageSize: 100, ...(pageToken ? { pageToken } : {}) },
    });
    rows.push(...(response.data?.smartNotes || []));
    pageToken = clean(response.data?.nextPageToken);
  } while (pageToken);
  return rows;
}

async function getMeetArtifacts(spaceName) {
  const { meet, records } = await conferenceRecordsForSpace(spaceName);
  const record = [...records].sort((a, b) => new Date(b.endTime || b.startTime || 0) - new Date(a.endTime || a.startTime || 0))[0];
  if (!record?.name) return { conferenceRecordName: '', complete: false, transcripts: [], smartNotes: [], recordings: [] };
  const warnings = [];
  async function optional(label, work) {
    try { return await work(); }
    catch (error) { warnings.push(`${label}: ${clean(error.message) || 'unavailable'}`); return []; }
  }
  // Transcript retrieval is the core requirement and remains retryable on an
  // API failure. Smart Notes, recordings, and attendance enrich the result but
  // must never prevent a valid transcript from being saved.
  const transcripts = await listAll(args => meet.conferenceRecords.transcripts.list(args), { parent: record.name }, 'transcripts');
  const [smartNotes, recordings, participants] = await Promise.all([
    optional('smart_notes', () => listSmartNotes(record.name)),
    optional('recordings', () => listAll(args => meet.conferenceRecords.recordings.list(args), { parent: record.name }, 'recordings')),
    optional('participants', () => listAll(args => meet.conferenceRecords.participants.list(args), { parent: record.name }, 'participants')),
  ]);
  const transcriptEntries = [];
  for (const transcript of transcripts) {
    if (!transcript.name) continue;
    const entries = await listAll(
      args => meet.conferenceRecords.transcripts.entries.list(args),
      { parent: transcript.name },
      'transcriptEntries'
    );
    transcriptEntries.push(...entries);
  }
  const participantSessions = [];
  for (const participant of participants) {
    if (!participant.name) continue;
    const sessions = await optional('participant_sessions', () => listAll(
      args => meet.conferenceRecords.participants.participantSessions.list(args),
      { parent: participant.name },
      'participantSessions'
    ));
    participantSessions.push(...sessions.map(session => ({ ...session, participant: participant.name })));
  }
  return {
    conferenceRecordName: record.name,
    complete: Boolean(record.endTime),
    startTime: record.startTime || null,
    endTime: record.endTime || null,
    transcripts,
    transcriptEntries,
    smartNotes,
    recordings,
    participants,
    participantSessions,
    warnings,
  };
}

async function waitForConference(calendar, event) {
  if (meetingLink(event)) return event;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    const response = await calendar.events.get({
      calendarId: calendarId(),
      eventId: event.id,
      conferenceDataVersion: 1,
    });
    event = response.data || event;
    if (meetingLink(event)) return event;
  }
  throw new Error('Google created the event but did not finish generating its Meet link.');
}

async function createCalendarEvent(input) {
  const calendar = await client();
  const response = await calendar.events.insert({
    calendarId: calendarId(),
    conferenceDataVersion: input.locationType === 'virtual' ? 1 : 0,
    sendUpdates: 'all',
    requestBody: eventResource(input),
  });
  let event = response.data || {};
  if (input.locationType === 'virtual') {
    event = await waitForConference(calendar, event);
  }
  return {
    id: clean(event.id),
    htmlLink: clean(event.htmlLink),
    meetingLink: meetingLink(event),
  };
}

async function updateCalendarEvent(eventId, input) {
  const calendar = await client();
  const response = await calendar.events.patch({
    calendarId: calendarId(),
    eventId,
    conferenceDataVersion: input.locationType === 'virtual' ? 1 : 0,
    sendUpdates: 'all',
    requestBody: eventResource(input),
  });
  let event = response.data || {};
  if (input.locationType === 'virtual') {
    event = await waitForConference(calendar, event);
  }
  return {
    id: clean(event.id),
    htmlLink: clean(event.htmlLink),
    meetingLink: meetingLink(event),
  };
}

async function cancelCalendarEvent(eventId) {
  const calendar = await client();
  await calendar.events.delete({
    calendarId: calendarId(),
    eventId,
    sendUpdates: 'all',
  });
}

module.exports = {
  calendarSecrets,
  authClient,
  createCalendarEvent,
  updateCalendarEvent,
  cancelCalendarEvent,
  configureMeetArtifacts,
  getMeetArtifacts,
  _test: { eventResource, meetingLink, meetingCode, listAll },
};
