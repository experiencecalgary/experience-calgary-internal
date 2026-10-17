'use strict';

const { onCall } = require('firebase-functions/v2/https');
const {
  confirmCommandExchangeService,
} = require('../../lib/command/commandExchangeLifecycle');

exports.confirmCommandExchange = onCall(
  {
    region: 'us-central1',
    cors: true,
  },
  confirmCommandExchangeService
);
