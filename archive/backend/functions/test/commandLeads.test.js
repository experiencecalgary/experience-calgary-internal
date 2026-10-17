'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { _test } = require('../routes/command/commandLeads');

test('Lead types are explicit and normalized', () => {
  assert.equal(_test.normalizeLeadType(' Person '), 'person');
  assert.equal(_test.normalizeLeadType('ORGANIZATION'), 'organization');
  assert.throws(() => _test.normalizeLeadType('contact'));
});

test('active and terminal stages are normalized', () => {
  assert.equal(_test.normalizeStage('closing'), 'Closing');
  assert.equal(_test.normalizeStage('WON'), 'Won');
  assert.throws(() => _test.normalizeStage('Maybe'));
});

test('Lead reference paths cannot cross collections', () => {
  assert.equal(
    _test.documentPath('commandPeople/person-1', 'commandPeople', 'person', true),
    'commandPeople/person-1'
  );
  assert.throws(() =>
    _test.documentPath('commandOrganizations/org-1', 'commandPeople', 'person', true)
  );
});

test('connected People are de-duplicated', () => {
  assert.deepEqual(
    _test.documentPaths(
      ['commandPeople/a', 'commandPeople/a', 'commandPeople/b'],
      'commandPeople',
      'people'
    ),
    ['commandPeople/a', 'commandPeople/b']
  );
});

test('Lead names follow the active subject', () => {
  assert.equal(
    _test.defaultLeadName('person', { data: { firstName: 'Jane', lastName: 'Doe' } }, null),
    'Jane Doe'
  );
  assert.equal(
    _test.defaultLeadName('organization', null, { data: { organization: 'Great Company' } }),
    'Great Company'
  );
});

test('access supports owner, assignee, viewer, team, and platform admin', () => {
  assert.equal(_test.canSee('u1', {}, { ownerUid: 'u1' }), true);
  assert.equal(_test.canSee('u1', {}, { assignedToUid: 'u1' }), true);
  assert.equal(_test.canSee('u1', {}, { viewerUids: ['u1'] }), true);
  assert.equal(_test.canSee('u1', { repId: 71 }, { teamRepIds: ['71'] }), true);
  assert.equal(_test.canSee('u1', { role: 'platform_admin' }, {}), true);
  assert.equal(_test.canSee('u1', { repId: 71 }, { ownerUid: 'u2' }), false);
});

test('Lead filters combine type, stage, assignment, List, and search', () => {
  const lead = {
    archived: false,
    leadType: 'organization',
    stage: 'Engaged',
    status: 'active',
    assignedToUid: 'rep-1',
    leadListId: 'list-1',
    displayName: 'Clear Nordic Spa',
    primaryContactName: 'Laura Smith',
  };
  assert.equal(_test.matchesFilters(lead, {
    leadType: 'organization',
    stage: 'engaged',
    assignedToUid: 'rep-1',
    leadListId: 'list-1',
    search: 'laura',
  }), true);
  assert.equal(_test.matchesFilters(lead, { search: 'roofing' }), false);
  assert.equal(_test.matchesFilters({ ...lead, archived: true }, {}), false);
  assert.equal(_test.matchesFilters({ ...lead, archived: true }, { archived: true }), true);
});

test('Lead status only accepts supported lifecycle values', () => {
  assert.equal(_test.normalizeStatus('ACTIVE'), 'active');
  assert.equal(_test.normalizeStatus('lost'), 'lost');
  assert.throws(() => _test.normalizeStatus('deleted'));
});

test('closed Leads cannot drift back into an active pipeline stage', () => {
  assert.doesNotThrow(() => _test.validateStageChange('active', 'Opened', 'Engaged'));
  assert.doesNotThrow(() => _test.validateStageChange('won', 'Won', 'Won'));
  assert.throws(() => _test.validateStageChange('active', 'Closing', 'Won'));
  assert.throws(() => _test.validateStageChange('won', 'Won', 'Engaged'));
  assert.throws(() => _test.validateStageChange('lost', 'Lost', 'New'));
});
