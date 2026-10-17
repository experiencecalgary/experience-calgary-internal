'use strict';

const { onCall } = require('firebase-functions/v2/https');
const {
  validateCommandOrganizationService,
} = require('../../lib/command/validateCommandOrganization');

exports.validateCommandOrganization = onCall(
  {
    region: 'us-central1',
    cors: true,
  },
  validateCommandOrganizationService
);
