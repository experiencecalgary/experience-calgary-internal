'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const revival = require('../lib/command/commandRevival');
const source = fs.readFileSync(path.join(__dirname, '../lib/command/commandRevival.js'), 'utf8');
const route = fs.readFileSync(path.join(__dirname, '../routes/command/commandRevival.js'), 'utf8');
const meeting = fs.readFileSync(path.join(__dirname, '../routes/command/commandMeetingLifecycle.js'), 'utf8');

test('exports the nine-function operational contract with temporary widget aliases', () => {
  for (const name of ['createCommandRevivalCampaign','updateCommandRevivalCampaign','reassignCommandRevivalCampaign','previewCommandRevivalImport','commitCommandRevivalImport','analyzeCommandRevivalOpportunities','updateCommandRevivalOpportunity','listCommandRevivalCampaigns','getCommandRevivalWorkspace']) {
    assert.match(route, new RegExp(`exports\\.${name}`));
  }
  for (const name of ['activateCommandRevivalCampaign','getCommandRevivalCampaignSummary','reviewCommandRevivalOpportunity']) {
    assert.match(route, new RegExp(`exports\\.${name}`));
  }
  assert.match(route, /Temporary FlutterFlow compatibility aliases/);
});

test('contains no financial management contract', () => {
  assert.match(source, /ignoredRetiredFields/);
  assert.match(source, /legacyStatus/);
  assert.match(source, /collectionStatus: 'retired'/);
  assert.doesNotMatch(source, /repEarningsForCampaignRevenue|activationFeeForApprovedCount/);
});

test('campaign lifecycle is operational and simple', () => {
  assert.equal(revival._test.CAMPAIGN_TRANSITIONS.draft.has('active'), true);
  assert.equal(revival._test.CAMPAIGN_TRANSITIONS.active.has('paused'), true);
  assert.equal(revival._test.CAMPAIGN_TRANSITIONS.paused.has('active'), true);
  assert.equal(revival._test.CAMPAIGN_TRANSITIONS.completed.size, 0);
  assert.match(source, /Approve at least one researched opportunity before starting/);
});

test('messy import aliases recognize practical CRM columns', () => {
  const mappings = revival._test.deterministicMappings(['Customer Name','Last Communication','Old Quote','CRM Notes']);
  assert.deepEqual(mappings.map((item) => item.targetField), ['fullName','lastInteraction','originalEstimatedValue','clientNotes']);
});

test('mapping supports standard, additional, notes, and ignore', () => {
  const mappings = revival._test.normalizeMappings(['Name','Old Rep','Estimator Notes','Internal ID'], [
    { sourceColumn: 'Name', action: 'standard', targetField: 'fullName' },
    { sourceColumn: 'Old Rep', action: 'additional', label: 'Original Sales Representative', includeInAi: true },
    { sourceColumn: 'Estimator Notes', action: 'notes' },
    { sourceColumn: 'Internal ID', action: 'ignore' },
  ]);
  assert.deepEqual(mappings.map((item) => item.action), ['standard','additional','notes','ignore']);
  assert.equal(mappings[1].label, 'Original Sales Representative');
});

test('mapping prevents duplicate standard destinations', () => {
  const mappings = revival._test.normalizeMappings(['Email 1','Email 2'], [
    { sourceColumn: 'Email 1', action: 'standard', targetField: 'email' },
    { sourceColumn: 'Email 2', action: 'standard', targetField: 'email' },
  ]);
  assert.equal(mappings[0].targetField, 'email');
  assert.equal(mappings[1].targetField, '');
});

test('imports preserve extra and original information', () => {
  assert.match(source, /additionalInformation/);
  assert.match(source, /originalImportedData/);
  assert.match(source, /includeInAi/);
  assert.match(source, /sourceData/);
});

test('AI recommendations are bounded, factual, and non-binding', () => {
  const brief = revival._test.validateRevivalBrief({
    opportunitySummary: 'Window quote', relationshipSummary: 'Spoke twice', stallSummary: 'Timing',
    reconnectAngle: 'Project timing changed', talkingPoints: [], sensitivities: [], missingInformation: [],
    researchQuestions: ['Is the project still planned?'], priority: 'hot', priorityReason: 'Recent specific quote', insufficientData: false,
  });
  assert.equal(brief.priority, 'hot');
  assert.match(source, /representative must independently verify/i);
  assert.match(source, /AI recommendations are internal guidance only/);
});

test('AI input redacts direct recipient identifiers', () => {
  const input = revival._test.aiOpportunityInput({ personName: 'Taylor Smith', clientNotes: 'Taylor Smith at taylor@example.com or 403-555-1212' });
  assert.doesNotMatch(JSON.stringify(input), /Taylor Smith|taylor@example\.com|403-555-1212/);
});

test('qualification remains human controlled and bookable', () => {
  const keys = ['priorRequest','twoWayConversation','specificOpportunity','contactAllowed','noDispute','notActive','worthwhile','accurateContact','truthfulReason','sponsorComfortable'];
  const answers = Object.fromEntries(keys.map((key) => [key, true]));
  const data = { previousService: 'Windows', reconnectReason: 'New product', deliveryAddress: '123 Test Ave' };
  assert.equal(revival._test.qualificationApprovalError(data, { answers, failedRules: [] }, { email: 'valid@example.com' }), '');
  assert.equal(revival._test.qualificationApprovalError(data, { answers, failedRules: [] }, { phone: '4035551212' }), '');
  assert.match(revival._test.qualificationApprovalError(data, { answers, failedRules: [] }, {}), /email address or phone/);
});

test('pipeline covers research through delivery and follow-up', () => {
  assert.equal(revival._test.ALLOWED_TRANSITIONS.research.has('approved'), true);
  assert.equal(revival._test.ALLOWED_TRANSITIONS.delivered.has('follow_up'), true);
  assert.equal(revival._test.ALLOWED_TRANSITIONS.follow_up.has('meeting_booked'), false);
  assert.match(source, /Complete the preparation checklist before marking this opportunity ready/);
  assert.match(source, /businessOutcome/);
  assert.match(meeting, /\['delivered', 'follow_up'\]\.includes\(opportunity\.status\)/);
  assert.match(meeting, /status: 'follow_up'.*meetingActionRef: admin\.firestore\.FieldValue\.delete/);
  assert.doesNotMatch(source, /meeting_booked|meeting_held/);
  assert.match(source, /Qualification is locked after fulfilment begins/);
  assert.match(source, /Reverse approval by setting both opportunity status and qualification status to rejected/);
  assert.match(meeting, /meetingActionRef: admin\.firestore\.FieldValue\.delete\(\)/);
  assert.match(meeting, /revivalCampaignRef: target\.data\.revivalCampaignRef/);
  assert.match(meeting, /revivalOpportunityRef: target\.data\.revivalOpportunityRef/);
});

test('critical opportunity and Meeting outcomes reject stale concurrent writes', () => {
  assert.match(source, /This opportunity changed\. Refresh and try again/);
  assert.match(source, /runTransaction\(async \(transaction\)/);
  assert.match(meeting, /This Meeting changed\. Refresh and try again/);
  assert.match(meeting, /This Revival opportunity changed\. Refresh and try again/);
  assert.match(meeting, /opportunitySnap\.data\(\)\?\.meetingActionRef\?\.path !== target\.ref\.path/);
  assert.match(meeting, /function prepareFollowUp/);
  assert.match(meeting, /transaction\.create\(actionRef, data\)/);
  assert.match(meeting, /A Meeting is already booked for this Revival opportunity/);
  assert.doesNotMatch(meeting, /reserveRevivalMeeting|releaseRevivalMeetingReservation/);
  assert.match(source, /const wasApproved = opportunity\.data\.qualification\?\.status === 'approved'/);
  assert.doesNotMatch(source, /approvedCount: admin\.firestore\.FieldValue\.increment/);
});

test('campaign transfer remains isolated and safe', () => {
  assert.match(source, /Use reassignCommandRevivalCampaign to transfer the entire campaign/);
  assert.match(source, /active Revival import to finish before reassigning/);
  assert.match(source, /updatedPersonCount/);
  assert.match(source, /Array\.isArray\(person\.viewerUids\)/);
});

test('imports are isolated, bounded, resumable, and serialized', () => {
  assert.match(source, /const IMPORTS = 'commandRevivalImports'/);
  assert.match(source, /const MAX_ROWS = 50/);
  assert.match(source, /const MAX_CAMPAIGN_OPPORTUNITIES = 100/);
  assert.match(source, /activeRevivalImportBatchId/);
  assert.match(source, /submittedCount: finalOpportunitySnap\.size/);
  assert.match(source, /status: 'failed'/);
  assert.match(source, /activeRevivalImportBatchId: admin\.firestore\.FieldValue\.delete/);
  assert.match(source, /the short lease remains the final recovery fallback/);
  assert.equal(revival._test.exceedsCampaignOpportunityLimit(50, 50), false);
  assert.equal(revival._test.exceedsCampaignOpportunityLimit(51, 50), true);
});

test('scoped campaign and workspace reads are callable', () => {
  assert.match(source, /where\('viewerUids', 'array-contains', ctx\.uid\)/);
  assert.match(source, /where\('teamRepIds', 'array-contains', repId\)/);
  assert.match(source, /summary: \{/);
  assert.match(source, /actions,/);
  assert.match(source, /activity,/);
  assert.match(source, /approved: opportunities\.filter/);
  assert.match(source, /qualifiedMeetings: meetings\.filter/);
  assert.match(source, /where\('revivalCampaignRef', '==', campaign\.ref\)/);
});

test('Revival Meeting finalization leaves ordinary Meeting access unchanged', () => {
  assert.match(meeting, /if \(!campaignPath && !opportunityPath\) return null/);
  assert.match(meeting, /Inactive representatives cannot manage VIP Revival Meetings/);
  assert.doesNotMatch(meeting, /Inactive representatives cannot manage Meetings\./);
  assert.match(meeting, /if \(revival\) \{/);
  assert.match(meeting, /transaction\.update\(revival\.opportunityRef/);
  assert.match(meeting, /else \{\s+const batch = ctx\.db\.batch\(\)/);
});

test('Firestore rules isolate Revival reads and imports', () => {
  const rules = fs.readFileSync(path.join(__dirname, '../../firestore.rules'), 'utf8');
  assert.match(rules, /commandRevivalImports/);
  assert.match(rules, /canReadRevivalDocument/);
  assert.match(rules, /allow write: if false/);
  assert.doesNotMatch(rules, /commandCsvImports/);
});

test('required Revival indexes exist without exact duplicates', () => {
  const indexes = JSON.parse(fs.readFileSync(path.join(__dirname, '../../firestore.indexes.json'), 'utf8')).indexes;
  const keys = indexes.map((item) => JSON.stringify(item));
  assert.equal(new Set(keys).size, keys.length);
  for (const fieldPath of ['viewerUids','teamRepIds']) assert.ok(indexes.some((index) => index.collectionGroup === 'commandRevivalCampaigns' && index.fields.some((field) => field.fieldPath === fieldPath && field.arrayConfig === 'CONTAINS')));
});

test('production entrypoint assembles Revival routes', () => {
  assert.match(fs.readFileSync(path.join(__dirname, '../entrypoint.js'), 'utf8'), /commandRevival/);
});
