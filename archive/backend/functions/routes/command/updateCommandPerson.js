'use strict';

const { onCall } = require('firebase-functions/v2/https');
const {
  updateCommandPersonService,
} = require('../../lib/command/updateCommandPerson');

exports.updateCommandPerson = onCall(
  {
    region: 'us-central1',
    cors: true,
  },
  updateCommandPersonService
);
