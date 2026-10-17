'use strict';

const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const { buildAlgoliaRecord, getClient, saveRecord, deleteRecord } = require('../../lib/command/commandAlgolia');

const ALGOLIA_APP_ID = defineSecret('ALGOLIA_APP_ID');
const ALGOLIA_ADMIN_API_KEY = defineSecret('ALGOLIA_ADMIN_API_KEY');
const sharedOptions = { region: 'us-central1', secrets: [ALGOLIA_APP_ID, ALGOLIA_ADMIN_API_KEY] };

function client() {
  return getClient(ALGOLIA_APP_ID.value(), ALGOLIA_ADMIN_API_KEY.value());
}

function handler(type, idParam = 'recordId', inheritThread = false) {
  return async (event) => {
    const after = event.data?.after;
    const objectID = event.params[idParam];
    if (!after?.exists) {
      await deleteRecord(client(), type, objectID);
      return;
    }

    let data = after.data() || {};
    let parentPath = '';
    if (inheritThread) {
      const threadRef = after.ref.parent.parent;
      const threadSnap = await threadRef.get();
      const thread = threadSnap.data() || {};
      parentPath = threadRef.path;
      data = {
        ...data,
        threadId: event.params.threadId,
        ownerUid: data.ownerUid || thread.ownerUid || '',
        viewerUids: Array.isArray(data.viewerUids) && data.viewerUids.length ? data.viewerUids : thread.viewerUids || [],
        teamRepIds: Array.isArray(data.teamRepIds) && data.teamRepIds.length ? data.teamRepIds : thread.teamRepIds || [],
        archived: data.archived === true || thread.archived === true,
      };
    }

    await saveRecord(client(), type, buildAlgoliaRecord(type, objectID, after.ref.path, data, parentPath));
  };
}

exports.commandPersonAlgoliaSync = onDocumentWritten(
  { ...sharedOptions, document: 'commandPeople/{recordId}' },
  handler('people')
);
exports.commandOrganizationAlgoliaSync = onDocumentWritten(
  { ...sharedOptions, document: 'commandOrganizations/{recordId}' },
  handler('organizations')
);
exports.commandActionAlgoliaSync = onDocumentWritten(
  { ...sharedOptions, document: 'commandActions/{recordId}' },
  handler('actions')
);
exports.commandConnectionAlgoliaSync = onDocumentWritten(
  { ...sharedOptions, document: 'commandConnections/{recordId}' },
  handler('connections')
);
exports.commandEmailThreadAlgoliaSync = onDocumentWritten(
  { ...sharedOptions, document: 'commandEmailThreads/{recordId}' },
  handler('emailThreads')
);
exports.commandEmailMessageAlgoliaSync = onDocumentWritten(
  { ...sharedOptions, document: 'commandEmailThreads/{threadId}/emailMessages/{messageId}' },
  handler('emailMessages', 'messageId', true)
);
exports.commandLibraryFileAlgoliaSync = onDocumentWritten(
  { ...sharedOptions, document: 'commandLibraryFiles/{recordId}' },
  handler('libraryFiles')
);
