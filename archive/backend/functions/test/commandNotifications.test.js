'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const notifications = require('../routes/command/commandNotifications')._test;

test('maps every supported notification family to its workspace category', () => {
  assert.equal(notifications.categoryFor('action_overdue'), 'actions');
  assert.equal(notifications.categoryFor('meeting_rescheduled'), 'meetings');
  assert.equal(notifications.categoryFor('stale_lead'), 'flow');
  assert.equal(notifications.categoryFor('daily_command_summary'), 'flow');
  assert.equal(notifications.categoryFor('weekly_plan_reminder'), 'announcements');
  assert.equal(notifications.categoryFor('email_in'), 'exmail');
  assert.equal(notifications.categoryFor('future_type'), 'other');
});

test('notification cursors round trip and reject malformed values', () => {
  const cursor = notifications.encodeCursor({ id: 'notice_1', data: () => ({ createdAt: { toMillis: () => 123456 } }) });
  assert.deepEqual(notifications.decodeCursor(cursor), { ms: 123456, id: 'notice_1' });
  assert.throws(() => notifications.decodeCursor('not-a-cursor'));
});

test('device ids are deterministic and do not expose FCM tokens', () => {
  const token = 'token-value-that-is-long-enough-for-testing';
  const id = notifications.deviceId(token);
  assert.equal(id, notifications.deviceId(token));
  assert.equal(id.length, 64);
  assert.equal(id.includes(token), false);
});


test('builds FlutterFlow push payloads for every Command destination', () => {
  const cases = [
    ['action', 'commandActions/action_1', 'CommandCenterActions', 'initialActionRefPath', '/commandCenterActions?initialActionRefPath=commandActions%2Faction_1'],
    ['meeting', 'commandActions/meeting_1', 'CommandCenterActions', 'initialActionRefPath', '/commandCenterActions?initialActionRefPath=commandActions%2Fmeeting_1'],
    ['person', 'commandPeople/person_1', 'CommandCenterPeopleContact', 'personRef', '/commandCenterPeopleContact?personRef=person_1'],
    ['organization', 'commandOrganizations/org_1', 'commandCenterOrganizationContact', 'organizationRef', '/commandCenterOrganizationContact?organizationRef=org_1'],
    ['exmail', 'commandEmailThreads/thread_1', 'CommandCenterExMailMessages', 'exMailThreadRef', '/commandCenterExMailMessages?exMailThreadRef=thread_1'],
  ];

  for (const [kind, path, page, parameter, webLink] of cases) {
    const id = path.split('/').pop();
    const route = notifications.flutterFlowRouteFor({ kind, ref: { path, id } });
    assert.equal(route.initialPageName, page);
    assert.deepEqual(JSON.parse(route.parameterData), { [parameter]: path });
    assert.equal(route.webLink, webLink);
  }
});

test('falls back safely to the Notifications page without a destination', () => {
  assert.deepEqual(notifications.flutterFlowRouteFor({ kind: 'none', ref: null }), {
    initialPageName: 'CommandCenterNotifications',
    parameterData: '{}',
    webLink: '/commandCenterNotifications',
  });
});


test('daily summaries and weekly plans use direct workspace destinations', () => {
  assert.deepEqual(
    notifications.flutterFlowRouteFor({ kind: 'command_dashboard', ref: null }),
    { initialPageName: 'CommandCenterDashboard', parameterData: '{}', webLink: '/commandCenterDashboard' }
  );
  assert.deepEqual(
    notifications.flutterFlowRouteFor({ kind: 'weekly_plan', ref: null }),
    { initialPageName: 'repMyWeeklyPlan', parameterData: '{}', webLink: '/repMyWeeklyPlan' }
  );
});


test('reference-free workspace destinations remain available in the in-app inbox', () => {
  assert.equal(notifications.destinationAvailableWithoutRef('command_dashboard'), true);
  assert.equal(notifications.destinationAvailableWithoutRef('weekly_plan'), true);
  assert.equal(notifications.destinationAvailableWithoutRef('none'), false);
});
