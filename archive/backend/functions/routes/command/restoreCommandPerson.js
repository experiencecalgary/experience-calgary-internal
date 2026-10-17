'use strict';

const { onCall } = require('firebase-functions/v2/https');
const {
  createRestoreCommandRecordService,
} = require('../../lib/command/archiveRestoreCommandRecord');

exports.restoreCommandPerson = onCall(
  {
    region: 'us-central1',
    cors: true,
  },
  createRestoreCommandRecordService('person')
);
