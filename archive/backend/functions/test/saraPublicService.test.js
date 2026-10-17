'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const original = Module._load;

Module._load = function(request, parent, isMain) {
  if (request === 'firebase-admin') return { firestore:Object.assign(() => ({}), { FieldValue:{ serverTimestamp:() => ({ serverTimestamp:true }) } }) };
  if (request === 'firebase-functions/v2/https') return { HttpsError:class extends Error { constructor(code, message) { super(message); this.code = code; } } };
  if (request.endsWith('saraTwilio')) return {};
  if (request.endsWith('saraService')) return {};
  if (request.includes('commandPersonUtils')) return { requireAuth:() => '', requireCommandAccess:async () => ({}), isPlatformAdminUser:() => false };
  return original.apply(this, arguments);
};

const core = require('../lib/sara/saraCore');
const publicService = require('../lib/sara/saraPublicService');

test('default public settings are valid and invitation contains booking link', () => {
  assert.doesNotThrow(() => core.assertValidSettings(core.DEFAULTS));
  assert.match(core.DEFAULTS.invitationMessage, /{{bookingPageUrl}}/);
});

test('phone normalization is stable', () => {
  assert.equal(core.normalizePhone('(403) 555-1212'), '+14035551212');
  assert.equal(core.normalizePhone('+1 403 555 1212'), '+14035551212');
});

test('public settings exclude internal configuration', () => {
  const page = publicService.publicSettings(core.DEFAULTS);
  assert.equal(page.positionName, core.DEFAULTS.positionName);
  assert.equal(Object.hasOwn(page, 'invitationMessage'), false);
  assert.equal(Object.hasOwn(page, 'defaultInterviewerUid'), false);
});

test('public form validation rejects markup and malformed email', () => {
  assert.equal(publicService._test.safeName(' Chris Smith '), 'Chris Smith');
  assert.throws(() => publicService._test.safeEmail('wrong@'), /valid email/);
});

test('rate keys do not expose phone or IP', () => {
  const key = publicService._test.rateKey('+14035551212', '127.0.0.1');
  assert.equal(key.length, 64);
  assert.equal(key.includes('4035551212'), false);
});


test('interview presentation URL is optional but must use HTTPS when supplied', () => {
  assert.doesNotThrow(() => core.assertValidSettings({ ...core.DEFAULTS, interviewPresentationUrl:'' }));
  assert.doesNotThrow(() => core.assertValidSettings({ ...core.DEFAULTS, interviewPresentationUrl:'https://command.experiencecalgary.ca/interviewPresentation' }));
  assert.throws(() => core.assertValidSettings({ ...core.DEFAULTS, interviewPresentationUrl:'http://example.com/presentation' }), /interviewPresentationUrl/);
});
