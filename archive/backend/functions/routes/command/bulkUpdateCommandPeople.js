'use strict';

const { onCall } = require('firebase-functions/v2/https');
const {
  bulkUpdateCommandPeopleService,
} = require('../../lib/command/bulkUpdateCommandPeople');

exports.bulkUpdateCommandPeople = onCall(
  {
    region: 'us-central1',
    cors: true,
    timeoutSeconds: 120,
    memory: '512MiB',
  },
  bulkUpdateCommandPeopleService
);
