'use strict';

const { onCall } = require('firebase-functions/v2/https');
const { defineSecret, defineString } = require('firebase-functions/params');
const revival = require('../../lib/command/commandRevival');

const OPENAI_API_KEY = defineSecret('OPENAI_API_KEY');
const COMMAND_REVIVAL_OPENAI_MODEL = defineString('COMMAND_REVIVAL_OPENAI_MODEL', {
  default: 'gpt-5-mini',
  description: 'OpenAI model used for VIP Opportunity Revival structured extraction.',
});

const standardCallable = (handler) => onCall({
  region: 'us-central1',
  cors: true,
  timeoutSeconds: 120,
  memory: '512MiB',
}, handler);

const aiCallable = (handler) => onCall({
  region: 'us-central1',
  cors: true,
  timeoutSeconds: 120,
  memory: '512MiB',
  secrets: [OPENAI_API_KEY],
}, (request) => handler(request, {
  apiKey: OPENAI_API_KEY.value(),
  model: COMMAND_REVIVAL_OPENAI_MODEL.value(),
}));

exports.createCommandRevivalCampaign = standardCallable(revival.createCommandRevivalCampaignService);
exports.updateCommandRevivalCampaign = standardCallable(revival.updateCommandRevivalCampaignService);
exports.reassignCommandRevivalCampaign = standardCallable(revival.reassignCommandRevivalCampaignService);
exports.previewCommandRevivalImport = aiCallable(revival.previewCommandRevivalImportService);
exports.commitCommandRevivalImport = standardCallable(revival.commitCommandRevivalImportService);
exports.analyzeCommandRevivalOpportunities = aiCallable(revival.analyzeCommandRevivalOpportunitiesService);
exports.updateCommandRevivalOpportunity = standardCallable(revival.updateCommandRevivalOpportunityService);
exports.listCommandRevivalCampaigns = standardCallable(revival.listCommandRevivalCampaignsService);
exports.getCommandRevivalWorkspace = standardCallable(revival.getCommandRevivalWorkspaceService);

// Temporary FlutterFlow compatibility aliases. Remove after the three
// replacement widgets are live and no longer call the legacy names.
exports.activateCommandRevivalCampaign = standardCallable(revival.activateCommandRevivalCampaignService);
exports.reviewCommandRevivalOpportunity = standardCallable(revival.reviewCommandRevivalOpportunityService);
exports.getCommandRevivalCampaignSummary = standardCallable(revival.getCommandRevivalCampaignSummaryService);
