'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture } = require('./helpers/outreachMemory');
const board = load('../../lib/command/commandLeadFlowBoard');
const { state } = load('../../lib/command/commandLeadWorkState');
test('no-action derives from complete linked-work metadata, not leftover pointer text', () => {
  assert.equal(state({ version: 1, complete: true, entries: [] }).noAction, true);
  assert.equal(state(null).noAction, false);
});
test('search includes lead and related identities', async () => {
  const f = fixture(), ctx = await f.context({ data: {} });
  const filters = { scope: 'mine', leadType: 'all', search: 'madeleine' };
  assert.equal(board.matches(ctx, { ...f.db.store.get(f.leadRef.path), primaryContactName: 'Madeleine' }, filters), true);
  assert.equal(board.matches(ctx, f.db.store.get(f.leadRef.path), filters), false);
});
test('unsupported stage tokens are rejected rather than coerced to offset zero', () => {
  assert.throws(() => board.decode('42', 'New'), /Refresh/);
});
test('unknown work is excluded from no-action filter', () => {
  assert.equal(board.attentionMatches(state(null), 'no_action'), false);
});
test('non-admin cannot request global scope', async () => {
  const f = fixture();
  assert.throws(() => board.filters({ uid: 'u1', actor: { userData: f.db.store.get('users/u1') }, input: { scope: 'all' } }), /scope/);
});
