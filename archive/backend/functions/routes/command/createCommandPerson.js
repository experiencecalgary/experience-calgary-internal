'use strict';

const { onCall } = require('firebase-functions/v2/https');
const {
  createCommandPersonService,
} = require('../../lib/command/createCommandPerson');

exports.createCommandPerson = onCall(
  {
    region: 'us-central1',
    cors: true,
  },
  createCommandPersonService
);
