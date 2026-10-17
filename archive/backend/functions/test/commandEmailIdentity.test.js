'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeEmail,
  normalizeAdditionalEmails,
  recordEmails,
  sameRef,
  identityRef,
  inspectEmailIdentityConflicts,
} = require('../lib/command/commandEmailIdentity');

test('normalizeEmail trims and lowercases an address', () => {
  assert.equal(
    normalizeEmail('  Brittany@CSC.COM  '),
    'brittany@csc.com'
  );
});

test('additional emails are normalized, deduplicated, and exclude primary', () => {
  assert.deepEqual(
    normalizeAdditionalEmails(
      [
        'BRITTANY@CSC.COM',
        ' second@csc.com ',
        'SECOND@CSC.COM',
        '',
      ],
      'brittany@csc.com'
    ),
    ['second@csc.com']
  );
});

test('invalid additional email fails closed', () => {
  assert.throws(
    () => normalizeAdditionalEmails(['not-an-email'], 'primary@example.com'),
    /Invalid additional email address/
  );
});

test('more than ten additional emails is rejected', () => {
  const emails = Array.from(
    { length: 11 },
    (_, index) => `person${index}@example.com`
  );
  assert.throws(
    () => normalizeAdditionalEmails(emails, 'primary@example.com'),
    /at most 10 additional/
  );
});

test('recordEmails supports legacy and normalized fields', () => {
  assert.deepEqual(
    recordEmails({
      email: 'Primary@Example.com',
      additionalEmails: ['Second@Example.com', 'primary@example.com'],
    }),
    ['primary@example.com', 'second@example.com']
  );
});

test('sameRef compares Firestore-style references by path', () => {
  assert.equal(
    sameRef(
      { path: 'commandPeople/person-a' },
      { path: 'commandPeople/person-a' }
    ),
    true
  );
  assert.equal(
    sameRef(
      { path: 'commandPeople/person-a' },
      { path: 'commandPeople/person-b' }
    ),
    false
  );
});


function fakeFirestore() {
  const records = new Map();
  const db = {
    collection(name) {
      return {
        doc(id) {
          return { id, path: `${name}/${id}` };
        },
      };
    },
    async getAll(...refs) {
      return refs.map((ref) => ({
        ref,
        exists: records.has(ref.path),
        data: () => records.get(ref.path),
      }));
    },
  };
  return { db, records };
}

test('person validation allows an organization email only for the connected organization', async () => {
  const { db, records } = fakeFirestore();
  const organizationRef = { path: 'commandOrganizations/org-a' };
  records.set(identityRef(db, 'shared@example.com').path, { organizationRef });

  assert.deepEqual(
    await inspectEmailIdentityConflicts(db, {
      recordType: 'person',
      emails: ['shared@example.com'],
      relatedOrganizationRef: organizationRef,
    }),
    []
  );

  const conflicts = await inspectEmailIdentityConflicts(db, {
    recordType: 'person',
    emails: ['shared@example.com'],
    relatedOrganizationRef: { path: 'commandOrganizations/org-b' },
  });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].conflictType, 'organization');
});

test('organization validation allows a person email only when that person is connected', async () => {
  const { db, records } = fakeFirestore();
  const organizationRef = { path: 'commandOrganizations/org-a' };
  const personRef = { path: 'commandPeople/person-a' };
  records.set(identityRef(db, 'shared@example.com').path, { personRef });
  records.set(personRef.path, { organizationRef });

  assert.deepEqual(
    await inspectEmailIdentityConflicts(db, {
      recordType: 'organization',
      emails: ['shared@example.com'],
      recordRef: organizationRef,
    }),
    []
  );

  const conflicts = await inspectEmailIdentityConflicts(db, {
    recordType: 'organization',
    emails: ['shared@example.com'],
  });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].conflictType, 'person');
});

test('validation reports same-type email ownership conflicts', async () => {
  const { db, records } = fakeFirestore();
  records.set(identityRef(db, 'owned@example.com').path, {
    personRef: { path: 'commandPeople/person-a' },
  });

  const conflicts = await inspectEmailIdentityConflicts(db, {
    recordType: 'person',
    emails: ['owned@example.com'],
  });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].personPath, 'commandPeople/person-a');
});
