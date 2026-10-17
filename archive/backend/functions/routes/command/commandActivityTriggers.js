'use strict';

const admin = require('firebase-admin');
const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

async function writeConnection(id, sourceRef, data, type, summary) {
  const db = admin.firestore();
  const ref = db.collection('commandConnections').doc(id);
  await ref.set({
    type,
    summary,
    body: clean(data.description || data.body || data.notes),
    sourceRef,
    ...(data.leadRef ? { leadRef: data.leadRef } : {}),
    personRef: data.personRef || null,
    personName: clean(data.personName),
    organizationRef: data.organizationRef || null,
    organizationName: clean(data.organizationName),
    ownerUid: data.ownerUid || null,
    ownerRef: data.ownerRef || data.createdByRef || null,
    ownerName: clean(data.ownerName || data.createdByName),
    createdByRef: data.createdByRef || null,
    createdByUid: clean(data.createdByUid) || clean(data.createdByRef?.id),
    createdByName: clean(data.createdByName) || clean(data.ownerName) || 'Experience Command',
    recordType: data.personRef ? 'person' : (data.organizationRef ? 'organization' : 'general'),
    recordName: clean(data.personName) || clean(data.organizationName) || clean(data.title),
    viewerUids: Array.isArray(data.viewerUids) ? data.viewerUids : [],
    teamRepIds: Array.isArray(data.teamRepIds) ? data.teamRepIds : [],
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: false });
}

exports.commandActionCreated = onDocumentCreated(
  { region: 'us-central1', document: 'commandActions/{actionId}' },
  async (event) => {
    const data = event.data?.data() || {};
    if (clean(data.actionType).toLowerCase() === 'meeting') return;
    await writeConnection(
      `action_created_${event.params.actionId}`,
      event.data.ref,
      data,
      'action_created',
      clean(data.title) ? `Action created: ${clean(data.title)}` : 'Action created'
    );
  }
);

// Kept exported as a no-op so deployments stop the legacy duplicate writer
// without requiring a destructive function deletion. Action lifecycle callables
// are the single authoritative completion writer.
exports.commandActionCompleted = onDocumentUpdated(
  { region: 'us-central1', document: 'commandActions/{actionId}' },
  async () => null
);

exports.commandMeetingCreated = onDocumentCreated(
  { region: 'us-central1', document: 'commandMeetings/{meetingId}' },
  async (event) => {
    const data = event.data?.data() || {};
    await writeConnection(
      `meeting_created_${event.params.meetingId}`,
      event.data.ref,
      data,
      'meeting_scheduled',
      clean(data.title) ? `Meeting scheduled: ${clean(data.title)}` : 'Meeting created'
    );
  }
);

exports.commandNoteCreated = onDocumentCreated(
  { region: 'us-central1', document: 'commandNotes/{noteId}' },
  async (event) => {
    const data = event.data?.data() || {};
    await writeConnection(
      `note_created_${event.params.noteId}`,
      event.data.ref,
      data,
      'note',
      clean(data.title) || 'Note added'
    );
  }
);

// Kept exported as a no-op. logCommandCallOutcome writes the authoritative
// call Connection in the same batch as the commandCalls document.
exports.commandCallCreated = onDocumentCreated(
  { region: 'us-central1', document: 'commandCalls/{callId}' },
  async () => null
);

