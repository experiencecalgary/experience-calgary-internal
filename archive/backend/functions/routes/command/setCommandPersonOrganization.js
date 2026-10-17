'use strict';

const { onCall } = require('firebase-functions/v2/https');
const {
  setCommandPersonOrganizationService,
} = require('../../lib/command/commandRelationships');

exports.setCommandPersonOrganization = onCall(
  {
    region: 'us-central1',
    cors: true,
  },
  setCommandPersonOrganizationService
);
