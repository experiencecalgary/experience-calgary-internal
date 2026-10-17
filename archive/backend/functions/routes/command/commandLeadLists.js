'use strict';

const { onCall } = require('firebase-functions/v2/https');
const services = require('../../lib/command/commandLeadLists');

const options = {
  region: 'us-central1',
  cors: true,
  timeoutSeconds: 120,
  memory: '512MiB',
};

exports.createCommandLeadList = onCall(options, services.createCommandLeadListService);
exports.listCommandLeadLists = onCall(options, services.listCommandLeadListsService);
exports.updateCommandLeadList = onCall(options, services.updateCommandLeadListService);
exports.archiveCommandLeadList = onCall(options, services.archiveCommandLeadListService);
exports.assignCommandLeadList = onCall(options, services.assignCommandLeadListService);
