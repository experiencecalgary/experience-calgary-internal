'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { _test } = require('../lib/command/commandLeadLists');

test('legacy CRM records remain accessible without List fields', () => {
  assert.equal(_test.canAccess({ ownerUid: 'rep-a' }, 'rep-a', '100'), true);
  assert.equal(_test.canAccess({ viewerUids: ['rep-a'] }, 'rep-a', '100'), true);
  assert.equal(_test.canAccess({ teamRepIds: ['100'] }, 'rep-a', '100'), true);
});

test('platform admin can manage Lists and records across the sales force', () => {
  assert.equal(_test.canAccess({}, 'admin', '', true), true);
});

test('List inputs are normalized and bounded', () => {
  assert.equal(_test.validateName('  Guest   List Exposure  '), 'Guest List Exposure');
  assert.equal(_test.validateDescription('  dealerships  '), 'dealerships');
  assert.equal(_test.validateColor('#d4af37'), '#D4AF37');
  assert.throws(() => _test.validateName(''));
  assert.throws(() => _test.validateColor('gold'));
});

test('bulk List assignment accepts only the selected CRM record type', () => {
  assert.deepEqual(
    _test.validateRecordPaths('people', ['commandPeople/a', 'commandPeople/a', 'commandPeople/b']),
    ['commandPeople/a', 'commandPeople/b']
  );
  assert.throws(() => _test.validateRecordPaths('people', ['commandOrganizations/a']));
  assert.throws(() => _test.validateRecordPaths('organizations', []));
});


test('search index reconfiguration preserves the List facet', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(
    path.join(__dirname, '../lib/command/commandSearch.js'),
    'utf8'
  );
  assert.match(source, /filterOnly\(leadListId\)/);
});

test('List rename propagation advances beyond the first 400 records', async () => {
  const people = Array.from({ length: 401 }, (_, index) => ({
    id: `person-${String(index).padStart(3, '0')}`,
    dataValue: { leadListName: 'Old Name' },
  }));
  const collections = {
    commandPeople: people,
    commandOrganizations: [],
    commandLeads: [{ id: 'lead-001', dataValue: { leadListName: 'Old Name' } }],
  };
  const updated = [];
  const db = {
    collection(name) {
      let afterId = '';
      return {
        where() {
          return this;
        },
        orderBy() {
          return this;
        },
        limit() {
          return this;
        },
        startAfter(cursor) {
          afterId = cursor.id;
          return this;
        },
        async get() {
          const source = collections[name].filter((item) => item.id > afterId).slice(0, 400);
          return {
            docs: source.map((item) => ({
              id: item.id,
              ref: { id: item.id },
              data: () => item.dataValue,
            })),
          };
        },
      };
    },
    batch() {
      const writes = [];
      return {
        update(ref, value) {
          writes.push({ ref, value });
        },
        async commit() {
          updated.push(...writes);
        },
      };
    },
  };
  const count = await _test.propagateListName(db, 'list-1', 'New Name', { id: 'rep-1' });
  assert.equal(count, 402);
  assert.equal(updated.length, 402);
});


test('List-scoped text search does not require Algolia configuration', async () => {
  const { _test: listingTest } = require('../lib/command/commandRecordListing');
  const docs = [
    {
      id: 'a',
      ref: { path: 'commandPeople/a' },
      data: () => ({
        fullName: 'Laura Smith',
        email: 'laura@example.com',
        ownerUid: 'rep-1',
        archived: false,
        updatedAt: 2,
      }),
    },
    {
      id: 'b',
      ref: { path: 'commandPeople/b' },
      data: () => ({
        fullName: 'Bryce Jones',
        organizationName: 'Clear Nordic Spa',
        ownerUid: 'rep-1',
        archived: false,
        updatedAt: 1,
      }),
    },
  ];
  const db = {
    collection() {
      return {
        where() {
          return { async get() { return { docs }; } };
        },
      };
    },
  };
  const page = await listingTest.listLeadListRecordPage({
    db,
    uid: 'rep-1',
    userData: { repId: '100' },
    definition: { collection: 'commandPeople' },
    recordType: 'people',
    filters: { leadListId: 'list-1', archived: false },
    sortField: 'updatedAt',
    sortDirection: 'desc',
    pageSize: 25,
    pageToken: '',
    searchQuery: 'nordic',
  });
  assert.equal(page.totalRecords, 1);
  assert.equal(page.records[0].id, 'b');
});
