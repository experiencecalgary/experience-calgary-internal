'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isPlatformAdminUser,
} = require('../lib/command/commandPersonUtils');
const {
  canAssignCommandAction,
} = require('../lib/command/commandActionAssignment');
const {
  buildInboxFilters,
} = require('../lib/command/commandEmailThreadListing');
const {
  assertThreadReadAccess,
  assertThreadAccess,
} = require('../lib/commandEmail/emailAccess');
const {
  _test: engagementTestHelpers,
} = require('../routes/command/commandEngagementLifecycle');
const {
  _test: searchTestHelpers,
} = require('../lib/command/commandSearch');
const {
  DEFINITIONS,
  _test: recordListingTestHelpers,
} = require('../lib/command/commandRecordListing');

test('platform admin detection is explicit and case-insensitive', () => {
  assert.equal(isPlatformAdminUser({ role: 'platform_admin' }), true);
  assert.equal(isPlatformAdminUser({ role: 'PLATFORM_ADMIN' }), true);
  assert.equal(isPlatformAdminUser({ role: 'director' }), false);
  assert.equal(isPlatformAdminUser({ userType: 'admin' }), false);
});

test('platform admin can assign any active representative', () => {
  assert.equal(canAssignCommandAction({
    actorUid: 'admin-uid',
    actorData: { role: 'platform_admin', repId: 'ADMIN' },
    assigneeUid: 'rep-uid',
    assigneeData: { active: true, userType: 'rep', repId: 'REP1' },
  }), true);

  assert.equal(canAssignCommandAction({
    actorUid: 'admin-uid',
    actorData: { role: 'platform_admin', repId: 'ADMIN' },
    assigneeUid: 'inactive-uid',
    assigneeData: { active: false, userType: 'rep', repId: 'REP2' },
  }), false);
});

test('normal representative assignment hierarchy is unchanged', () => {
  assert.equal(canAssignCommandAction({
    actorUid: 'pd-uid',
    actorData: { role: 'program_director', repId: 'PD1' },
    assigneeUid: 'rep-uid',
    assigneeData: {
      active: true,
      userType: 'rep',
      programDirectorRepId: 'PD1',
    },
  }), true);

  assert.equal(canAssignCommandAction({
    actorUid: 'rep-a',
    actorData: { role: 'representative', repId: 'REP1' },
    assigneeUid: 'rep-b',
    assigneeData: { active: true, userType: 'rep', repId: 'REP2' },
  }), false);
});

test('platform admin team inbox omits hierarchy viewer filter', () => {
  const filters = buildInboxFilters(
    'admin-uid',
    'team',
    false,
    true
  );
  assert.equal(filters.includes('viewerUids:'), false);
  assert.match(filters, /archived:false/);
  assert.match(filters, /NOT ownerUid:"admin-uid"/);
});

test('platform admin Mine inbox stays personal', () => {
  const filters = buildInboxFilters('admin-uid', 'my', false, true);
  assert.match(filters, /viewerUids:"admin-uid"/);
  assert.match(filters, /ownerUid:"admin-uid"/);
});

test('platform admin team unread is rejected instead of returning false results', () => {
  assert.throws(
    () => buildInboxFilters('admin-uid', 'team', true, true),
    /Unread-only filtering is not supported/
  );
});

test('normal team inbox retains hierarchy viewer filter', () => {
  const filters = buildInboxFilters(
    'rep-uid',
    'team',
    false,
    false
  );
  assert.match(filters, /viewerUids:"rep-uid"/);
  assert.match(filters, /NOT ownerUid:"rep-uid"/);
});

test('platform admin global search is limited to team record types', () => {
  const admin = { role: 'platform_admin', repId: 'ADMIN' };
  for (const type of ['people', 'organizations', 'actions', 'connections']) {
    assert.equal(searchTestHelpers.filterFor(type, 'admin-uid', admin), 'archived:false');
  }
  for (const type of ['emailThreads', 'emailMessages', 'libraryFiles']) {
    const filters = searchTestHelpers.filterFor(type, 'admin-uid', admin);
    assert.match(filters, /ownerUid:"admin-uid" OR viewerUids:"admin-uid"/);
  }
});

test('generic listing bypass is limited to team record definitions', () => {
  const admin = { role: 'platform_admin' };
  for (const type of ['people', 'organizations', 'actions', 'connections']) {
    assert.equal(
      recordListingTestHelpers.platformAdminBypassesListingAccess(
        DEFINITIONS[type],
        admin
      ),
      true
    );
  }
  for (const type of ['emailThreads', 'libraryFiles', 'emailMessages']) {
    assert.equal(
      recordListingTestHelpers.platformAdminBypassesListingAccess(
        DEFINITIONS[type],
        admin
      ),
      false
    );
  }
});

test('platform admin may read unrelated ExMail threads', () => {
  assert.doesNotThrow(() => assertThreadReadAccess(
    {
      uid: 'admin-uid',
      repId: 'ADMIN',
      userData: { role: 'platform_admin' },
    },
    {
      ownerUid: 'other-rep',
      viewerUids: ['other-rep'],
      teamRepIds: ['REP2'],
    }
  ));
});

test('platform admin cannot mutate or reply to an unrelated ExMail thread', () => {
  assert.throws(() => assertThreadAccess(
    {
      uid: 'admin-uid',
      repId: 'ADMIN',
      userData: { role: 'platform_admin' },
    },
    {
      ownerUid: 'other-rep',
      viewerUids: ['other-rep'],
      teamRepIds: ['REP2'],
    }
  ));
});

test('normal representative cannot open an unrelated ExMail thread', () => {
  assert.throws(() => assertThreadAccess(
    {
      uid: 'rep-uid',
      repId: 'REP1',
      userData: { role: 'representative' },
    },
    {
      ownerUid: 'other-rep',
      viewerUids: ['other-rep'],
      teamRepIds: ['REP2'],
    }
  ));
});

test('platform admin sees unrelated Connections while regular reps do not', () => {
  const unrelated = {
    ownerUid: 'other-rep',
    assignedToUid: 'other-rep',
    viewerUids: ['other-rep'],
    teamRepIds: ['REP2'],
  };
  assert.equal(engagementTestHelpers.visible({
    uid: 'admin-uid',
    actor: { userData: { role: 'platform_admin', repId: 'ADMIN' } },
  }, unrelated), true);
  assert.equal(engagementTestHelpers.visible({
    uid: 'rep-uid',
    actor: { userData: { role: 'representative', repId: 'REP1' } },
  }, unrelated), false);
});
