'use strict';

const { onCall } = require('firebase-functions/v2/https');
const {
  createCommandExchangeService,
} = require('../../lib/command/commandExchangeLifecycle');

exports.createCommandExchange = onCall(
  {
    region: 'us-central1',
    cors: true,
  },
  createCommandExchangeService
);
