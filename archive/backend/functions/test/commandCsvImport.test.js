'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'firebase-admin') return { firestore: () => ({}) };
  if (request === 'firebase-functions/v2/https') {
    return { HttpsError: class HttpsError extends Error { constructor(code, message, details) { super(message); this.code = code; this.details = details; } } };
  }
  if (request.endsWith('/commandPersonUtils') || request === './commandPersonUtils') {
    return { requireAuth() {}, requireCommandAccess() {}, isPlatformAdminUser(data = {}) { return data.role === 'platform_admin'; } };
  }
  if (request.endsWith('/commandAccessMetadata') || request === './commandAccessMetadata') {
    return { buildCommandAccessMetadata() {} };
  }
  if (request.endsWith('/commandLeadLists') || request === './commandLeadLists') {
    return { resolveCommandLeadList() {} };
  }
  if (request.endsWith('/commandEmailIdentity') || request === './commandEmailIdentity') {
    return { identityRef() {}, sameRef() { return false; } };
  }
  return originalLoad(request, parent, isMain);
};
const { _test } = require('../lib/command/commandCsvImport');
Module._load = originalLoad;

test('known loose headers map deterministically', () => {
  const mappings = _test.deterministicSmartMappings(['Contact Name', 'Company Name', 'Mobile', 'Deal Value']);
  assert.deepEqual(mappings.map(item => item.targetField), ['fullName', 'organizationName', 'personPhone', 'estimatedValue']);
});

test('confirmed mappings cannot target the same field twice', () => {
  const mappings = _test.normalizeSmartMappings(['Email', 'Backup Email'], [
    { sourceColumn: 'Email', action: 'standard', targetField: 'personEmail' },
    { sourceColumn: 'Backup Email', action: 'standard', targetField: 'personEmail' },
  ]);
  assert.equal(mappings[0].targetField, 'personEmail');
  assert.equal(mappings[1].targetField, '');
  assert.equal(mappings[1].action, 'ignore');
});

test('company-only generic contact details become Organization details', () => {
  const headers = ['Company', 'Email', 'Phone'];
  const mappings = _test.deterministicSmartMappings(headers);
  const [row] = _test.smartRows(headers, [{ Company: 'North Star', Email: 'hello@north.ca', Phone: '403 555 1212' }], mappings);
  assert.equal(row.normalized.leadType, 'organization');
  assert.equal(row.normalized.organizationEmail, 'hello@north.ca');
  assert.equal(row.normalized.organizationPhone, '4035551212');
  assert.equal(row.normalized.personEmail, '');
  assert.deepEqual(row.errors, []);
});

test('mixed Person and Organization rows produce Organization Leads by default', () => {
  const headers = ['Contact Name', 'Company', 'Email'];
  const mappings = _test.deterministicSmartMappings(headers);
  const [row] = _test.smartRows(headers, [{ 'Contact Name': 'Jane Doe', Company: 'North Star', Email: 'jane@north.ca' }], mappings);
  assert.equal(row.normalized.leadType, 'organization');
  assert.equal(row.normalized.fullName, 'Jane Doe');
  assert.equal(row.normalized.personEmail, 'jane@north.ca');
  assert.deepEqual(row.errors, []);
});

test('Person Lead requires a Person and every row requires a contact method', () => {
  const headers = ['Company', 'Lead Type'];
  const mappings = _test.deterministicSmartMappings(headers);
  const [row] = _test.smartRows(headers, [{ Company: 'North Star', 'Lead Type': 'person' }], mappings);
  assert.ok(row.errors.includes('Enter at least one phone number or email address.'));
  assert.ok(row.errors.includes('A Person Lead requires a Person name.'));
});

test('preview and created document identifiers are stable', () => {
  const mappings = _test.deterministicSmartMappings(['Company', 'Email']);
  assert.equal(_test.smartHash('u1', ['Company', 'Email'], [{ Company: 'A', Email: 'a@a.ca' }], mappings), _test.smartHash('u1', ['Company', 'Email'], [{ Company: 'A', Email: 'a@a.ca' }], mappings));
  assert.equal(_test.importedLeadId('batch', 'organization:a'), _test.importedLeadId('batch', 'organization:a'));
  assert.notEqual(_test.importedPersonId('batch', 'email:a@a.ca'), _test.importedPersonId('batch', 'email:b@b.ca'));
});

test('import matching visibility follows Command access metadata', () => {
  assert.equal(_test.canSee('u1', {}, { ownerUid: 'u1' }), true);
  assert.equal(_test.canSee('u1', { repId: 71 }, { teamRepIds: ['71'] }), true);
  assert.equal(_test.canSee('u1', { repId: 71 }, { ownerUid: 'u2', teamRepIds: ['72'] }), false);
  assert.equal(_test.canSee('u1', { role: 'platform_admin' }, {}), true);
});

test('phone validation stays consistent with Command contact rules', () => {
  const headers = ['Contact Name', 'Phone'];
  const mappings = _test.deterministicSmartMappings(headers);
  const [row] = _test.smartRows(headers, [{ 'Contact Name': 'Jane Doe', Phone: '555-1212' }], mappings);
  assert.ok(row.errors.includes('Person phone numbers must contain exactly 10 digits.'));
});
