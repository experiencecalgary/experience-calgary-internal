'use strict';

// Preserve every existing production export from index.js, then add isolated
// Experience Command extensions without rewriting the large production index.
const existingExports = require('./index');
const finalCommandBackend = require('./routes/command/finalCommandBackend');
const commandActivityTriggers = require('./routes/command/commandActivityTriggers');
const commandConnectionActorRepair = require('./routes/command/commandConnectionActorRepair');
const commandSearchAndListing = require('./routes/command/commandSearchAndListing');
const commandEmailThreadListing = require('./routes/command/commandEmailThreadListing');
const commandAlgoliaTriggers = require('./routes/command/commandAlgoliaTriggers');
const commandAccessTriggers = require('./routes/command/commandAccessTriggers');
const commandPeopleTestData = require('./routes/command/commandPeopleTestData');
const commandFlow = require('./routes/command/commandFlow');
const commandLeadFlow = require('./routes/command/commandLeadFlow');
const commandActionLifecycle = require('./routes/command/commandActionLifecycle');
const commandLeads = require('./routes/command/commandLeads');
const commandLeadPerformance = require('./routes/command/commandLeadPerformance');
const commandSalesPerformance = require('./routes/command/commandSalesPerformance');
const commandLeadMigration = require('./routes/command/commandLeadMigration');
const commandActionQueries = require('./routes/command/commandActionQueries');
const commandMeetingLifecycle = require('./routes/command/commandMeetingLifecycle');
const commandMeetingArtifacts = require('./routes/command/commandMeetingArtifacts');
const commandPartnerPresentation = require('./routes/command/commandPartnerPresentation');
const commandWebsiteBrand = require('./routes/command/commandWebsiteBrand');
const commandEngagementLifecycle = require('./routes/command/commandEngagementLifecycle');
const commandDashboardAutomation = require('./routes/command/commandDashboardAutomation');
const commandDailyOverview = require('./routes/command/commandDailyOverview');
const commandCallQueueV2 = require('./routes/command/commandCallQueueV2');
const commandWeeklyPlans = require('./routes/command/commandWeeklyPlans');
const commandRevival = require('./routes/command/commandRevival');
const commandAgreements = require('./routes/command/commandAgreements');
const notificationCampaigns = require('./routes/notificationCampaigns');
const customerNotifications = require('./routes/customerNotifications');
const notificationAutomationExtensions = require('./routes/notificationAutomationExtensions');
const guestList = require('./routes/guestList');
const firebaseAdmin = require('firebase-admin');
const firebaseLogger = require('firebase-functions/logger');

module.exports = existingExports;

module.exports.archiveCommandPerson =
  require('./routes/command/archiveCommandPerson').archiveCommandPerson;
module.exports.restoreCommandPerson =
  require('./routes/command/restoreCommandPerson').restoreCommandPerson;
module.exports.archiveCommandOrganization =
  require('./routes/command/archiveCommandOrganization').archiveCommandOrganization;
module.exports.restoreCommandOrganization =
  require('./routes/command/restoreCommandOrganization').restoreCommandOrganization;
module.exports.bulkUpdateCommandPeople =
  require('./routes/command/bulkUpdateCommandPeople').bulkUpdateCommandPeople;
module.exports.bulkUpdateCommandOrganizations =
  require('./routes/command/bulkUpdateCommandOrganizations').bulkUpdateCommandOrganizations;
module.exports.createCommandAction =
  require('./routes/command/createCommandAction').createCommandAction;
module.exports.setCommandPersonOrganization =
  require('./routes/command/setCommandPersonOrganization').setCommandPersonOrganization;
module.exports.backfillCommandContactIdentity =
  require('./routes/command/backfillCommandContactIdentity').backfillCommandContactIdentity;

module.exports.createCommandExchange =
  require('./routes/command/createCommandExchange').createCommandExchange;
module.exports.confirmCommandExchange =
  require('./routes/command/confirmCommandExchange').confirmCommandExchange;
module.exports.cancelCommandExchange =
  require('./routes/command/cancelCommandExchange').cancelCommandExchange;

// commandSearchAndListing intentionally overrides the legacy in-memory
// searchCommandRecords export with the Algolia-backed implementation.
Object.assign(
  module.exports,
  finalCommandBackend,
  commandActivityTriggers,
  commandConnectionActorRepair,
  commandSearchAndListing,
  commandEmailThreadListing,
  commandAlgoliaTriggers,
  commandAccessTriggers,
  commandPeopleTestData,
  commandFlow,
  commandLeadFlow,
  require('./routes/command/commandLeadFlowMaintenance'),
  commandActionLifecycle,
  commandLeads,
  require('./routes/command/commandStaleLeads'),
  commandLeadPerformance,
  commandSalesPerformance,
  commandLeadMigration,
  commandActionQueries,
  commandMeetingLifecycle,
  commandMeetingArtifacts,
  commandPartnerPresentation,
  commandWebsiteBrand,
  commandEngagementLifecycle,
  commandDashboardAutomation,
  commandDailyOverview,
  commandCallQueueV2,
  require('./routes/command/commandOutreachContext'),
  require('./routes/command/commandLeadWorkspace'),
  { markCommandLeadCallEnded: require('./routes/command/commandOutreachCalls').markCommandLeadCallEnded },
  commandWeeklyPlans,
  commandRevival,
  commandAgreements,
  notificationCampaigns,
  customerNotifications,
  notificationAutomationExtensions,
  guestList
);

// Standalone interview-booking assistant. It deliberately does not write to
// Command Leads, People, Actions, or Meetings.
Object.assign(module.exports, require('./routes/sara/saraFunctions'));

const chatNotifications = require('./lib/chatNotificationMigration')({
  db: firebaseAdmin.firestore(),
  admin: firebaseAdmin,
  logger: firebaseLogger,
});
module.exports.chatMessageNotifications = chatNotifications.chatMessageNotifications;
module.exports.retryPendingChatNotifications = chatNotifications.retryPendingChatNotifications;


