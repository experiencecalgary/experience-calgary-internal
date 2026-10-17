'use strict';

const { onCall } = require('firebase-functions/v2/https');
const {
  updateCommandOrganizationService,
} = require('../../lib/command/updateCommandOrganization');

exports.updateCommandOrganization = onCall(
  {
    region: 'us-central1',
    cors: true,
  },
  updateCommandOrganizationService
);
