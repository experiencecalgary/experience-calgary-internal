'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { completeCommandActionService } = require('../routes/command/commandActionLifecycle');

function memoryDb(seed = {}) {
  const store = new Map(Object.entries(seed));
  const snap = path => ({ exists: store.has(path), data: () => store.get(path) });
  const ref = path => ({ path, id: path.split('/').pop() });
  return {
    _store: store,
    doc: path => ref(path),
    collection: name => ({ doc: id => ref(`${name}/${id || 'generated'}`) }),
    runTransaction: async handler => handler({
      get: async item => snap(item.path),
      update: (item, patch) => store.set(item.path, { ...store.get(item.path), ...patch }),
      set: (item, value) => store.set(item.path, value),
    }),
  };
}

test('overdue Actions complete atomically and retries are idempotent', async () => {
  const db = memoryDb({
    'commandActions/a1': {
      status: 'open',
      actionType: 'Call',
      title: 'Call lead',
      dueAt: 'PAST_DUE',
      ownerUid: 'u1',
      assignedToUid: 'u1',
      viewerUids: ['u1'],
    },
  });
  const context = async request => ({
    db,
    uid: 'u1',
    actor: { userRef: { path: 'users/u1' }, userData: {} },
    input: request.data,
  });
  const request = { data: { actionRefPath: 'commandActions/a1', completionNotes: 'Done' } };
  const first = await completeCommandActionService(request, {
    context,
    serverTimestamp: () => 'SERVER_TIME',
  });
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, false);
  assert.equal(db._store.get('commandActions/a1').status, 'completed');
  assert.equal(db._store.get('commandConnections/action_completed_a1').type, 'action_completed');

  const retry = await completeCommandActionService(request, {
    context,
    serverTimestamp: () => 'RETRY_TIME',
  });
  assert.equal(retry.ok, true);
  assert.equal(retry.duplicate, true);
  assert.equal(db._store.get('commandActions/a1').completedAt, 'SERVER_TIME');
});
