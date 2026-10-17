'use strict';

const { onCall } = require('firebase-functions/v2/https');
const {
  createCommandOrganizationService,
} = require('../../lib/command/createCommandOrganization');

exports.createCommandOrganization = onCall(
  {
    region: 'us-central1',
    cors: true,
  },
  createCommandOrganizationService
);
