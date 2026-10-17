'use strict';

const { onCall } = require('firebase-functions/v2/https');
const {
  cancelCommandExchangeService,
} = require('../../lib/command/commandExchangeLifecycle');

exports.cancelCommandExchange = onCall(
  {
    region: 'us-central1',
    cors: true,
  },
  cancelCommandExchangeService
);
