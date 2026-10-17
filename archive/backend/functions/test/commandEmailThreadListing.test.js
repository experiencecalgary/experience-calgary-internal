'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildInboxFilters,
  decodePageToken,
  encodePageToken,
  queryFingerprint,
} = require('../lib/command/commandEmailThreadListing');

test('builds My inbox filters', () => {
  assert.equal(
    buildInboxFilters('user-1', 'my', false),
    'viewerUids:"user-1" AND archived:false AND ownerUid:"user-1"'
  );
});

test('builds unread Team inbox filters', () => {
  assert.equal(
    buildInboxFilters('user-1', 'team', true),
    'viewerUids:"user-1" AND archived:false AND NOT ownerUid:"user-1" AND unreadBy:"user-1"'
  );
});

test('page tokens are bound to the active inbox filters', () => {
  const myFingerprint = queryFingerprint({
    searchQuery: 'calgary',
    mailboxView: 'my',
    unreadOnly: false,
  });
  const token = encodePageToken(2, myFingerprint);
  assert.equal(decodePageToken(token, myFingerprint), 2);

  const teamFingerprint = queryFingerprint({
    searchQuery: 'calgary',
    mailboxView: 'team',
    unreadOnly: false,
  });
  assert.throws(() => decodePageToken(token, teamFingerprint));
});
