'use strict';

const { onCall } = require('firebase-functions/v2/https');
const {
  validateCommandPersonService,
} = require('../../lib/command/validateCommandPerson');

exports.validateCommandPerson = onCall(
  {
    region: 'us-central1',
    cors: true,
  },
  validateCommandPersonService
);
