'use strict';

const { onCall } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const {
  listCommandEmailThreadsPageService,
} = require('../../lib/command/commandEmailThreadListing');

const ALGOLIA_APP_ID = defineSecret('ALGOLIA_APP_ID');
const ALGOLIA_ADMIN_API_KEY = defineSecret('ALGOLIA_ADMIN_API_KEY');

exports.listCommandEmailThreadsPage = onCall(
  {
    region: 'us-central1',
    cors: true,
    secrets: [ALGOLIA_APP_ID, ALGOLIA_ADMIN_API_KEY],
  },
  (request) =>
    listCommandEmailThreadsPageService(request, {
      appId: ALGOLIA_APP_ID.value(),
      adminKey: ALGOLIA_ADMIN_API_KEY.value(),
    })
);
