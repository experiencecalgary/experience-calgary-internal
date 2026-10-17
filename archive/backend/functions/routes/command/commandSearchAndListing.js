'use strict';

const { onCall } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { searchCommandRecordsService, configureCommandSearchIndexesService } = require('../../lib/command/commandSearch');
const { listCommandRecordsPageService } = require('../../lib/command/commandRecordListing');

const ALGOLIA_APP_ID = defineSecret('ALGOLIA_APP_ID');
const ALGOLIA_ADMIN_API_KEY = defineSecret('ALGOLIA_ADMIN_API_KEY');

const callable = (handler, options = {}) => onCall(
  { region: 'us-central1', cors: true, ...options },
  handler
);

function algoliaCredentials() {
  return {
    appId: ALGOLIA_APP_ID.value(),
    adminKey: ALGOLIA_ADMIN_API_KEY.value(),
  };
}

exports.searchCommandRecords = callable(
  (request) => searchCommandRecordsService(request, algoliaCredentials()),
  { secrets: [ALGOLIA_APP_ID, ALGOLIA_ADMIN_API_KEY] }
);

exports.configureCommandSearchIndexes = callable(
  (request) => configureCommandSearchIndexesService(request, algoliaCredentials()),
  { secrets: [ALGOLIA_APP_ID, ALGOLIA_ADMIN_API_KEY] }
);

exports.listCommandRecordsPage = callable(
  (request) => listCommandRecordsPageService(request, algoliaCredentials()),
  { secrets: [ALGOLIA_APP_ID, ALGOLIA_ADMIN_API_KEY] }
);
