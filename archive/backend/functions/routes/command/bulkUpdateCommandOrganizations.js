'use strict';

const { onCall } = require('firebase-functions/v2/https');
const {
  bulkUpdateCommandOrganizationsService,
} = require('../../lib/command/bulkUpdateCommandOrganizations');

exports.bulkUpdateCommandOrganizations = onCall(
  {
    region: 'us-central1',
    cors: true,
    timeoutSeconds: 120,
    memory: '512MiB',
  },
  bulkUpdateCommandOrganizationsService
);
