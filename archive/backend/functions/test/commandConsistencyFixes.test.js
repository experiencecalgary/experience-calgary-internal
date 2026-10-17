'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { _test: actorTest } = require('../routes/command/commandConnectionActorRepair');

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('historical Connection repair only targets missing or system-fallback actor names', () => {
  assert.equal(actorTest.displayName({ fullName: 'Louise Rheaume' }), 'Louise Rheaume');
  assert.equal(actorTest.needsRepair({ createdByName: 'Experience Command' }), true);
  assert.equal(actorTest.needsRepair({ createdByName: '' }), true);
  assert.equal(actorTest.needsRepair({ createdByName: 'Louise Rheaume' }), false);
});

test('new ExMail Connections write the real actor and access metadata at the source', () => {
  const send = source('lib/commandEmail/sendCommandEmail.js');
  const reply = source('lib/commandEmail/replyCommandEmail.js');
  const receive = source('lib/commandEmail/receiveCommandEmail.js');
  assert.equal(send.includes('createdByName: actor.name'), true);
  assert.equal(send.includes('viewerUids,'), true);
  assert.equal(reply.includes('createdByName: actor.name'), true);
  assert.equal(reply.includes('viewerUids: Array.isArray(thread.viewerUids)'), true);
  assert.equal(receive.includes('createdByName: inboundSenderName'), true);
  assert.equal(receive.includes('viewerUids: Array.isArray(thread.viewerUids)'), true);
});

test('email engagement has one CRM activity writer, one inbound notification writer, and only advances after sent', () => {
  const engagement = source('routes/command/commandEngagementLifecycle.js');
  assert.equal(engagement.includes('const key = `email:${threadRef.id}:${snap.id}`'), false);
  assert.equal(engagement.includes('commandEmailEngagement = onDocumentCreated'), true);
  assert.equal(engagement.includes('async function inboundEmailEngagementHandler() {\n  return null;'), true);
  assert.equal(engagement.includes('commandEmailSentEngagement = onDocumentUpdated'), true);
  assert.equal(engagement.includes("clean(message.status).toLowerCase() !== 'sent'"), true);
  assert.equal(engagement.includes("clean(previous.status).toLowerCase() === 'sent'"), true);
  const notificationAutomation = source('routes/notificationAutomationExtensions.js');
  assert.equal(notificationAutomation.includes("exports.inboundEmailNotification = onDocumentWritten"), true);
});

test('Action documents carry complete creator metadata for every PR-touched Action creation path', () => {
  const createAction = source('routes/command/createCommandAction.js');
  const actionLifecycle = source('routes/command/commandActionLifecycle.js');
  const engagement = source('routes/command/commandEngagementLifecycle.js');
  assert.equal(createAction.includes('createdByUid: uid'), true);
  assert.equal(createAction.includes('createdByName: actorName(userData)'), true);
  assert.equal(actionLifecycle.includes('createdByUid: ctx.uid, createdByName: actorName(ctx.actor)'), true);
  assert.equal(engagement.includes('createdByUid: ctx.uid, createdByName: actorName(ctx.actor)'), true);
  assert.equal(engagement.includes("createdByName: clean(message.createdByName || thread.ownerName) || 'Experience Command'"), true);
});

test('Platform Admin lifecycle access matches global Action and Meeting listing access', () => {
  const action = source('routes/command/commandActionLifecycle.js');
  const meeting = source('routes/command/commandMeetingLifecycle.js');
  assert.equal(action.includes('isPlatformAdminUser(actorData)'), true);
  assert.equal(meeting.includes('isPlatformAdminUser(actorData)'), true);
});

test('notification destination access is resolved directly and keeps chat membership separate', () => {
  const notifications = source('routes/command/commandNotifications.js');
  assert.equal(notifications.includes("new Set(['person', 'organization', 'action', 'meeting'])"), true);
  assert.equal(notifications.includes("destination.kind === 'connections_chat'"), true);
  assert.equal(notifications.includes('isPlatformAdminUser'), true);
});

test('team chat notification code stays separate from Command CRM Connections', () => {
  const chat = source('lib/chatNotificationMigration.js');
  assert.equal(chat.includes('commandConnections'), false);
});
