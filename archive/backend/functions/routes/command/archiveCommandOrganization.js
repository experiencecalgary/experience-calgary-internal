'use strict';

const { onCall } = require('firebase-functions/v2/https');
const {
  createArchiveCommandRecordService,
} = require('../../lib/command/archiveRestoreCommandRecord');

exports.archiveCommandOrganization = onCall(
  {
    region: 'us-central1',
    cors: true,
  },
  createArchiveCommandRecordService('organization')
);
