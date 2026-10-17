'use strict';

const { onCall, onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret, defineString } = require('firebase-functions/params');
const services = require('../../lib/command/commandFinalBackend');
const { createCommandExchangeItemService } = require('../../lib/command/commandExchangeItems');

const callable = (handler) => onCall({ region: 'us-central1', cors: true }, handler);
const http = (handler) => onRequest({ region: 'us-central1', cors: true }, handler);
const OPENAI_API_KEY = defineSecret('OPENAI_API_KEY');
const COMMAND_CSV_IMPORT_OPENAI_MODEL = defineString('COMMAND_CSV_IMPORT_OPENAI_MODEL', {
  default: 'gpt-5-mini',
  description: 'OpenAI model used only to suggest CSV column mappings.',
});

exports.createCommandLibraryFile = callable(services.createCommandLibraryFileService);
exports.archiveCommandLibraryFile = callable(services.archiveCommandLibraryFileService);
exports.restoreCommandLibraryFile = callable(services.restoreCommandLibraryFileService);
exports.createCommandExchangeItem = callable(createCommandExchangeItemService);
exports.getCommandExchangeItemAccess = callable(services.getCommandExchangeItemAccessService);

exports.getPublicCommandExchange = http(services.getPublicCommandExchangeHandler);
exports.preparePublicCommandExchangeUpload = http(services.preparePublicCommandExchangeUploadHandler);
exports.submitPublicCommandExchange = http(services.submitPublicCommandExchangeHandler);
exports.getPublicCommandExchangeItemAccess = http(services.getPublicCommandExchangeItemAccessHandler);

exports.linkCommandEmailThreadToOrganization = callable(
  services.linkCommandEmailThreadToOrganizationService
);
exports.unlinkCommandEmailThread = callable(services.unlinkCommandEmailThreadService);
exports.searchCommandRecords = callable(services.searchCommandRecordsService);
exports.validateCommandCsvImport = onCall(
  { region: 'us-central1', cors: true, timeoutSeconds: 120, memory: '512MiB', secrets: [OPENAI_API_KEY] },
  request => services.validateCommandCsvImportService(request, {
    apiKey: OPENAI_API_KEY.value(),
    model: COMMAND_CSV_IMPORT_OPENAI_MODEL.value(),
  })
);
exports.commitCommandCsvImport = onCall(
  { region: 'us-central1', cors: true, timeoutSeconds: 540, memory: '1GiB' },
  services.commitCommandCsvImportService
);

exports.syncCommandUserTeamAccess = onSchedule(
  { region: 'us-central1', schedule: 'every day 02:15', timeZone: 'America/Edmonton' },
  services.syncCommandUserTeamAccessHandler
);
exports.expireCommandExchanges = onSchedule(
  { region: 'us-central1', schedule: 'every 60 minutes', timeZone: 'America/Edmonton' },
  services.expireCommandExchangesHandler
);
