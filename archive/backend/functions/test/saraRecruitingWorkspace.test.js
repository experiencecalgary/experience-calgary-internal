'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const original = Module._load;

Module._load = function(request, parent, isMain) {
  if (request === 'firebase-admin') return { firestore:Object.assign(() => ({}), { FieldValue:{ serverTimestamp:() => ({ serverTimestamp:true }) } }) };
  if (request === 'firebase-functions/v2/https') return { HttpsError:class extends Error { constructor(code, message) { super(message); this.code = code; } } };
  if (request.endsWith('saraCore')) return {
    clean:(value, max = 4000) => typeof value === 'string' ? value.trim().slice(0, max) : '',
    normalizePhone:value => value,
    COLLECTIONS:{ interviews:'saraInterviews', candidates:'saraCandidates', slots:'saraInterviewSlots' },
  };
  if (request.endsWith('saraService')) return { callableValue:value => value };
  if (request.includes('commandPersonUtils')) return { requireAuth:() => '', requireCommandAccess:async () => ({}), isPlatformAdminUser:() => false };
  return original.apply(this, arguments);
};

const workspace = require('../lib/sara/saraRecruitingWorkspace');

test('session identity is stable for a rep and exact start time', () => {
  const row = { assignedInterviewerUid:'rep-1', startAt:'2026-09-21T17:00:00.000Z' };
  assert.equal(workspace._test.sessionIdFor(row), workspace._test.sessionIdFor({ ...row, status:'completed' }));
  assert.notEqual(workspace._test.sessionIdFor(row), workspace._test.sessionIdFor({ ...row, assignedInterviewerUid:'rep-2' }));
});

test('invalid session rows never collide', () => {
  assert.equal(workspace._test.sessionIdFor({ startAt:'2026-09-21T17:00:00.000Z' }), '');
  assert.equal(workspace._test.sessionIdFor({ assignedInterviewerUid:'rep-1' }), '');
});

test('draft answers retain supported scalar values and reject nested data', () => {
  assert.deepEqual(workspace._test.cleanAnswers({ notes:' Ready ', score:4, proceed:true, nested:{ unsafe:true } }), {
    notes:'Ready', score:4, proceed:true,
  });
});

test('session identity supports Firestore timestamp values', () => {
  const timestamp = { toDate:() => new Date('2026-09-21T17:00:00.000Z') };
  assert.equal(
    workspace._test.sessionIdFor({ assignedInterviewerUid:'rep-1', startAt:timestamp }),
    workspace._test.sessionIdFor({ assignedInterviewerUid:'rep-1', startAt:'2026-09-21T17:00:00.000Z' }),
  );
});
