'use strict';

const admin = require('firebase-admin');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { requireAuth, requireCommandAccess, isPlatformAdminUser } = require('../../lib/command/commandPersonUtils');
const calendarService = require('../../lib/command/commandGoogleCalendar');

const clean = value => typeof value === 'string' ? value.trim() : '';
const refPath = value => clean(value?.path || value);

function visible(uid, actorData, data = {}) {
  if (isPlatformAdminUser(actorData)) return true;
  const repId = clean(String(actorData?.repId ?? ''));
  return data.ownerUid === uid || data.assignedToUid === uid ||
    (Array.isArray(data.viewerUids) && data.viewerUids.includes(uid)) ||
    (repId && Array.isArray(data.teamRepIds) && data.teamRepIds.map(String).includes(repId));
}

function meetingPath(value) {
  const parts = refPath(value).split('/').filter(Boolean);
  if (parts.length !== 2 || parts[0] !== 'commandActions') {
    throw new HttpsError('invalid-argument', 'meetingRefPath must use commandActions/{documentId}.');
  }
  return parts.join('/');
}

function scalar(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return JSON.parse(JSON.stringify(value));
}

function transcriptEntry(entry = {}) {
  return {
    name: clean(entry.name),
    participant: clean(entry.participant),
    text: clean(entry.text),
    languageCode: clean(entry.languageCode),
    startTime: scalar(entry.startTime),
    endTime: scalar(entry.endTime),
  };
}

function chunks(rows, size = 100) {
  const result = [];
  for (let index = 0; index < rows.length; index += size) result.push(rows.slice(index, index + size));
  return result;
}

function artifactLinks(items = []) {
  return items.map(item => ({
    name: clean(item.name),
    state: clean(item.state),
    document: clean(item.docsDestination?.document),
    exportUri: clean(item.exportUri),
  }));
}

async function syncMeeting(db, meetingRef, meeting, actorRef = null) {
  if (clean(meeting.actionType).toLowerCase() !== 'meeting') throw new HttpsError('failed-precondition', 'This Action is not a Meeting.');
  if (meeting.transcriptionRequested !== true) return { status: 'not_requested', transcriptEntries: 0 };
  const meetIdentity = clean(meeting.meetSpaceName) || clean(meeting.googleMeetCode) || clean(meeting.meetingLink);
  if (!meetIdentity) throw new HttpsError('failed-precondition', 'This Meeting does not have a Google Meet identity.');
  const now = admin.firestore.Timestamp.now();
  await meetingRef.set({ artifactSyncStatus: 'syncing', artifactSyncLastAttemptAt: now, artifactSyncAttempts: admin.firestore.FieldValue.increment(1), artifactSyncError: '', updatedAt: now }, { merge: true });
  try {
    const result = await calendarService.getMeetArtifacts(meetIdentity);
    if (!result.conferenceRecordName) {
      await meetingRef.set({ artifactSyncStatus: 'waiting', artifactSyncNextAttemptAt: admin.firestore.Timestamp.fromMillis(now.toMillis() + 15 * 60 * 1000), updatedAt: now }, { merge: true });
      return { status: 'waiting', transcriptEntries: 0 };
    }
    const artifactRef = db.collection('commandMeetingArtifacts').doc(meetingRef.id);
    const normalizedEntries = (result.transcriptEntries || []).map(transcriptEntry);
    const entryChunks = chunks(normalizedEntries);
    const batchWrites = [];
    for (let index = 0; index < entryChunks.length; index += 1) {
      batchWrites.push({
        ref: artifactRef.collection('transcriptChunks').doc(String(index).padStart(4, '0')),
        data: { index, entries: entryChunks[index], entryCount: entryChunks[index].length, meetingRef, updatedAt: now },
      });
    }
    for (let offset = 0; offset < batchWrites.length; offset += 400) {
      const batch = db.batch();
      for (const write of batchWrites.slice(offset, offset + 400)) batch.set(write.ref, write.data, { merge: true });
      await batch.commit();
    }
    const transcripts = artifactLinks(result.transcripts);
    const smartNotes = artifactLinks(result.smartNotes);
    const recordings = artifactLinks(result.recordings);
    const complete = result.complete === true && transcripts.length > 0;
    const metadata = {
      schemaVersion: 1,
      meetingRef,
      leadRef: meeting.leadRef || null,
      personRef: meeting.personRef || null,
      organizationRef: meeting.organizationRef || null,
      meetingType: clean(meeting.meetingType),
      presentationType: clean(meeting.presentationType),
      assignedToRef: meeting.assignedToRef || null,
      assignedToUid: clean(meeting.assignedToUid),
      ownerRef: meeting.ownerRef || null,
      ownerUid: clean(meeting.ownerUid),
      teamRepIds: meeting.teamRepIds || [],
      viewerUids: meeting.viewerUids || [],
      conferenceRecordName: result.conferenceRecordName,
      conferenceStartTime: scalar(result.startTime),
      conferenceEndTime: scalar(result.endTime),
      transcripts,
      smartNotes,
      recordings,
      participantCount: (result.participants || []).length,
      participants: (result.participants || []).map(item => scalar(item)),
      participantSessions: (result.participantSessions || []).map(item => scalar(item)),
      participantSessionCount: (result.participantSessions || []).length,
      syncWarnings: result.warnings || [],
      transcriptEntryCount: normalizedEntries.length,
      transcriptChunkCount: entryChunks.length,
      status: complete ? 'complete' : 'processing',
      syncedAt: now,
      updatedAt: now,
      ...(actorRef ? { syncedByRef: actorRef } : {}),
    };
    await artifactRef.set(metadata, { merge: true });
    await meetingRef.set({
      artifactRef,
      artifactSyncStatus: complete ? 'complete' : 'processing',
      transcriptStatus: transcripts.length ? 'available' : (complete ? 'unavailable' : 'processing'),
      smartNotesStatus: smartNotes.length ? 'available' : (complete ? 'unavailable' : 'processing'),
      attendanceStatus: result.participants?.length ? 'available' : (complete ? 'unavailable' : 'processing'),
      transcriptEntryCount: normalizedEntries.length,
      meetingParticipantCount: (result.participants || []).length,
      artifactSyncError: '',
      artifactSyncWarnings: result.warnings || [],
      artifactSyncedAt: now,
      ...(!complete ? { artifactSyncNextAttemptAt: admin.firestore.Timestamp.fromMillis(now.toMillis() + 15 * 60 * 1000) } : {}),
      updatedAt: now,
    }, { merge: true });
    return { status: complete ? 'complete' : 'processing', transcriptEntries: normalizedEntries.length, participants: (result.participants || []).length };
  } catch (error) {
    await meetingRef.set({ artifactSyncStatus: 'error', artifactSyncError: clean(error.message).slice(0, 1000), artifactSyncNextAttemptAt: admin.firestore.Timestamp.fromMillis(now.toMillis() + 30 * 60 * 1000), updatedAt: now }, { merge: true });
    throw error;
  }
}

async function syncCommandMeetingArtifactsService(request) {
  const db = admin.firestore();
  const uid = requireAuth(request);
  const actor = await requireCommandAccess(db, uid);
  const meetingRef = db.doc(meetingPath(request.data?.meetingRefPath));
  const snap = await meetingRef.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Meeting not found.');
  const meeting = snap.data() || {};
  if (!visible(uid, actor.userData, meeting)) throw new HttpsError('permission-denied', 'You do not have access to this Meeting.');
  try {
    return { ok: true, meetingRefPath: meetingRef.path, ...(await syncMeeting(db, meetingRef, meeting, actor.userRef)) };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    throw new HttpsError('unavailable', `Google Meet artifacts are not ready: ${clean(error.message) || 'Unknown Google error.'}`);
  }
}

async function syncPendingMeetings() {
  const db = admin.firestore();
  const snap = await db.collection('commandActions').where('artifactSyncStatus', 'in', ['pending', 'waiting', 'processing', 'error']).limit(50).get();
  const now = Date.now();
  let synced = 0; let failed = 0;
  for (const doc of snap.docs) {
    const meeting = doc.data() || {};
    const retryAt = meeting.artifactSyncNextAttemptAt?.toMillis?.() || 0;
    if (retryAt > now || meeting.transcriptionRequested !== true || clean(meeting.actionType).toLowerCase() !== 'meeting') continue;
    try { await syncMeeting(db, doc.ref, meeting); synced += 1; } catch (_) { failed += 1; }
  }
  return { scanned: snap.size, synced, failed };
}

exports.syncCommandMeetingArtifactsService = syncCommandMeetingArtifactsService;
exports.syncPendingMeetings = syncPendingMeetings;
exports.syncCommandMeetingArtifacts = onCall({ region: 'us-central1', cors: true, timeoutSeconds: 300, memory: '1GiB', secrets: calendarService.calendarSecrets }, syncCommandMeetingArtifactsService);
exports.syncPendingCommandMeetingArtifacts = onSchedule({ region: 'us-central1', schedule: 'every 15 minutes', timeoutSeconds: 540, memory: '1GiB', secrets: calendarService.calendarSecrets }, syncPendingMeetings);
exports._test = { meetingPath, transcriptEntry, chunks, artifactLinks };
