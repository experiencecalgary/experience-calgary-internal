'use strict';

const { onCall } = require('firebase-functions/v2/https');
const {
  backfillCommandContactIdentityService,
} = require('../../lib/command/backfillCommandContactIdentity');

exports.backfillCommandContactIdentity = onCall(
  {
    region: 'us-central1',
    cors: true,
    timeoutSeconds: 540,
    memory: '512MiB',
  },
  backfillCommandContactIdentityService
);
