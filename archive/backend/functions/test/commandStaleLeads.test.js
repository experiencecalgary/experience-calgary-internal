'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture, Timestamp } = require('./helpers/outreachMemory');
const service = load('../../lib/command/commandStaleLeads');
const leads = load('../../routes/command/commandLeads')._test;
const workspace = load('../../lib/command/commandLeadWorkspace');
const { visible } = load('../../lib/command/commandOutreachSupport');
const now = Date.now(), old = Timestamp.fromMillis(now - 40 * 86400000), recent = Timestamp.fromMillis(now - 86400000);
function setup() {
  const f = fixture(), d = f.db.store.get(f.leadRef.path);
  Object.assign(d, { createdAt: old, updatedAt: old, lastActivityAt: old });
  const userRef = f.db.doc('users/admin');
  f.db.store.set(userRef.path, { userType: 'rep', role: 'platform_admin', active: true, repId: '99', fullName: 'Admin' });
  return { ...f, d, ctx: { db: f.db, uid: 'admin', actor: { userRef, userData: f.db.store.get(userRef.path) }, input: {} } };
}
test('requires an old active assignment and reliable existing dates', () => {
  const { d } = setup();
  assert.equal(service.dormant(d, now), true);
  for (const patch of [{ status: 'won' }, { status: 'lost' }, { status: 'stale' }, { archived: true }, { assignedToUid: '' }, { updatedAt: null }, { createdAt: null }, { updatedAt: recent }, { lastActivityAt: recent }, { createdAt: recent }])
    assert.equal(service.dormant({ ...d, ...patch }, now), false, JSON.stringify(patch));
});
test('preview is read-only; movement preserves contacts, stage, list and previous rep in history', async () => {
  const { db, leadRef, d } = setup();
  d.leadListId = 'original-list';
  const before = { ...d };
  assert.equal((await service.inspect(db, leadRef, now, false)).eligible, true);
  assert.deepEqual(db.store.get(leadRef.path), before);
  await service.inspect(db, leadRef, now, true);
  const after = db.store.get(leadRef.path);
  assert.equal(after.status, 'stale'); assert.equal(after.assignedToUid, ''); assert.equal(after.assignedToRef, null);
  assert.equal(after.archived, false); assert.equal(after.stage, 'New'); assert.equal(after.leadListId, 'original-list');
  assert.equal(after.primaryContactRef.path, before.primaryContactRef.path);
  const events = [...db.store].filter(([p]) => p.startsWith('commandConnections/'));
  assert.equal(events.length, 1); assert.equal(events[0][1].details.previousAssignedToUid, 'u1');
  await service.inspect(db, leadRef, now, true);
  assert.equal([...db.store.keys()].filter(p => p.startsWith('commandConnections/')).length, 1);
});
test('live actions, meetings, calls, agreements and recent history protect a lead', async () => {
  for (const [collection, data] of [
    ['commandActions', { status: 'open' }], ['commandActions', { status: 'open', actionType: 'Meeting' }],
    ['commandCalls', { status: 'in_progress' }], ['commandAgreements', { status: 'pending' }],
    ['commandConnections', { createdAt: recent }],
  ]) {
    const { db, leadRef } = setup(); db.store.set(`${collection}/protected`, { ...data, leadRef });
    assert.equal((await service.inspect(db, leadRef, now, true)).eligible, false);
    assert.equal(db.store.get(leadRef.path).status, 'active');
  }
});
test('legacy contact-only open work also protects the lead', async () => {
  const { db, leadRef, personRef } = setup();
  db.store.set('commandActions/legacy', { status: 'open', personRef });
  assert.equal((await service.inspect(db, leadRef, now, true)).eligible, false);
});
test('fresh activity after candidate selection is rechecked before movement', async () => {
  const { db, leadRef, d } = setup();
  assert.equal(service.dormant(d, now), true); d.updatedAt = recent;
  assert.equal((await service.inspect(db, leadRef, now, true)).eligible, false);
});
test('all management operations deny non-admins; old owner cannot open stale lead', async () => {
  const { ctx, d } = setup(); ctx.actor.userData = { userType: 'rep', repId: '1' }; ctx.uid = 'u1';
  for (const fn of [service.preview, service.list, service.manage, service.settings]) await assert.rejects(fn(ctx), { code: 'permission-denied' });
  for (const data of [{ ...d, status: 'stale' }, { ...d, status: 'archived', archived: true, statusBeforeArchive: 'stale' }]) {
    assert.equal(leads.canSee('u1', {}, data), false); assert.equal(visible('u1', {}, data), false);
    assert.equal(leads.canSee('admin', { role: 'platform_admin' }, data), true);
  }
});
test('admin reassignment changes owner and assignee, restores active, and refreshes existing clock', async () => {
  const { ctx, db, leadRef } = setup(); await service.inspect(db, leadRef, now, true);
  db.store.set('users/newrep', { userType: 'rep', active: true, repId: '2', fullName: 'New Rep' });
  db.store.get('commandPeople/p1').viewerUids = ['newrep'];
  ctx.input = { operation: 'assign', assignedToRefPath: 'users/newrep', leadRefPaths: [leadRef.path] };
  assert.equal((await service.manage(ctx)).changed, 1);
  const d = db.store.get(leadRef.path);
  assert.equal(d.status, 'active'); assert.equal(d.ownerUid, 'newrep'); assert.equal(d.assignedToUid, 'newrep');
  assert.equal(service.dormant(d, now), false);
  assert.equal((await service.manage(ctx)).changed, 0);
});
test('archive preserves stale origin and refuses to change an already reassigned lead', async () => {
  const { ctx, db, leadRef } = setup(); await service.inspect(db, leadRef, now, true);
  ctx.input = { operation: 'archive', leadRefPaths: [leadRef.path] };
  assert.equal((await service.manage(ctx)).changed, 1);
  const d = db.store.get(leadRef.path); assert.equal(d.status, 'archived'); assert.equal(d.statusBeforeArchive, 'stale');
  assert.equal(leads.normalizeStatus(d.statusBeforeArchive), 'stale');
  assert.equal((await service.manage(ctx)).changed, 0);
});
test('inactive assignees are rejected', async () => {
  const { ctx, db, leadRef } = setup(); db.store.set('users/inactive', { userType: 'rep', active: false, repId: '2' });
  ctx.input = { operation: 'assign', assignedToRefPath: 'users/inactive', leadRefPaths: [leadRef.path] };
  await assert.rejects(service.manage(ctx), { code: 'failed-precondition' });
});
test('daily cleanup is disabled by default', async () => {
  const { db, leadRef } = setup(); assert.deepEqual(await service.scheduled(db), { enabled: false, moved: 0 });
  assert.equal(db.store.get(leadRef.path).status, 'active');
});
test('preview pages progress past protected candidates', async () => {
  const { db, leadRef, d } = setup();
  db.store.set('commandActions/block', { leadRef, status: 'open' });
  db.store.set('commandLeads/l2', { ...d });
  const first = await service.sweepPage(db, { now, limit: 1 }); assert.equal(first.eligible, 0); assert.ok(first.nextPageToken);
  const second = await service.sweepPage(db, { now, limit: 1, token: first.nextPageToken }); assert.equal(second.eligible, 1);
});
test('normal list excludes stale records at query time and preserves closed filters', async () => {
  const { ctx, db, d } = setup(); ctx.input = { scope: 'all' };
  db.store.set('commandLeads/stale', { ...d, status: 'stale' });
  db.store.set('commandLeads/won', { ...d, stage: 'Won', status: 'won' });
  let page = await workspace.listLeads(ctx, { serializeLead: leads.serializeLead, matchesFilters: leads.matchesFilters });
  assert.deepEqual(page.records.map(r => r.status).sort(), ['active', 'won']);
  assert.ok(db.reads.some(r => r.col === 'commandLeads' && r.filters.some(([f,o,v]) => f === 'status' && o === 'in' && !v.includes('stale'))));
  ctx.input.status = 'won'; page = await workspace.listLeads(ctx, { serializeLead: leads.serializeLead, matchesFilters: leads.matchesFilters });
  assert.equal(page.records.length, 1); assert.equal(page.records[0].status, 'won');
});

test('contact access failure leaves the lead in the pool and preserves shared contact ownership', async () => {
  const { ctx, db, leadRef, personRef } = setup(); await service.inspect(db, leadRef, now, true);
  db.store.set('users/newrep', { userType: 'rep', active: true, repId: '2', fullName: 'New Rep' });
  ctx.input = { operation: 'assign', assignedToRefPath: 'users/newrep', leadRefPaths: [leadRef.path] };
  const result = await service.manage(ctx);
  assert.equal(result.changed, 0); assert.match(result.results[0].reason, /linked contact/);
  assert.equal(db.store.get(leadRef.path).status, 'stale'); assert.equal(db.store.get(personRef.path).ownerUid, 'u1');
});
test('admin list shows former assignee and reason from existing history', async () => {
  const { ctx, db, leadRef, d } = setup(); d.assignedToName = 'Original Rep';
  await service.inspect(db, leadRef, now, true);
  const result = await service.list(ctx);
  assert.equal(result.records.length, 1); assert.equal(result.records[0].previousRepName, 'Original Rep');
  assert.equal(result.records[0].previousRepUid, 'u1'); assert.match(result.records[0].reason, /30 days/);
});

test('malformed relationship blocks automatic recovery rather than bypassing open-work checks', async () => {
  const { db, leadRef, d } = setup(); d.primaryContactRef = db.doc('unexpected/contact');
  const result = await service.inspect(db, leadRef, now, true);
  assert.equal(result.eligible, false); assert.match(result.reason, /Invalid contact/);
  assert.equal(db.store.get(leadRef.path).status, 'active');
});
test('access trigger and repair reconcile current assignment, never a captured old snapshot', async () => {
  const { db, leadRef } = setup();
  const sync = load('../../routes/command/commandAccessTriggers')._test.syncCurrentLeadAccess;
  const captured = await leadRef.get();
  await service.inspect(db, leadRef, now, true);
  await sync(db, captured.ref);
  assert.equal(db.store.get(leadRef.path).assignedToUid, '');
  const newRep = db.doc('users/new'); db.store.set(newRep.path, { userType: 'rep', active: true, repId: '3', fullName: 'New' });
  Object.assign(db.store.get(leadRef.path), { status: 'active', ownerRef: newRep, assignedToRef: newRep });
  await sync(db, captured.ref);
  assert.equal(db.store.get(leadRef.path).assignedToUid, 'new'); assert.equal(db.store.get(leadRef.path).ownerUid, 'new');
});
test('CSV import skips an existing stale Lead without exposing its reference', async () => {
  const { db, leadRef, personRef, d } = setup();
  d.subjectPersonRef = personRef; d.status = 'stale';
  const csv = load('../../lib/command/commandCsvImport')._test;
  const rows = [{ errors: [], warnings: [], normalized: { leadType: 'person', fullName: 'Pat', personEmail: 'pat@example.com', personPhone: '' } }];
  await csv.matchSmartRows(db, 'u1', { userType: 'rep', repId: '1' }, rows, 'different-import');
  assert.equal(rows[0].leadMatchStatus, 'existing'); assert.equal(rows[0].leadRefPath, '');
  assert.match(rows[0].warnings[0], /admin review/);
  assert.equal(db.store.get(leadRef.path).status, 'stale');
});
test('new lead worker sees old call history while private ExMail and unrelated work stay scoped', async () => {
  const { db, ctx, leadRef } = setup();
  const rep = { uid: 'u1', actor: { userRef: db.doc('users/u1'), userData: db.store.get('users/u1') }, db,
    input: { leadRefPath: leadRef.path, section: 'activity' } };
  db.store.set('commandConnections/oldcall', { leadRef, type: 'call_finished', summary: 'Spoke to client', ownerUid: 'previous', createdAt: old });
  db.store.set('commandConnections/privateemail', { leadRef, type: 'email_in', summary: 'Private email', ownerUid: 'previous', createdAt: old });
  let result = await workspace.section(rep);
  assert.deepEqual(result.records.map(r => r.refPath), ['commandConnections/oldcall']);
  db.store.set('commandActions/private', { leadRef, status: 'open', actionType: 'Follow-up', ownerUid: 'previous', createdAt: old });
  rep.input.section = 'actions'; result = await workspace.section(rep); assert.equal(result.records.length, 0);
});
test('enabled scheduler runs and preserves settings, then retries without duplicate movements', async () => {
  const { db, leadRef, ctx } = setup();
  // Faithful merge support for config writes; the shared memory helper's doc.set
  // intentionally has simpler semantics in older tests.
  const doc = db.doc;
  db.doc = path => { const ref = doc(path); return { ...ref, set: async (data, options) => db.runTransaction(tx => tx.set(ref, data, options)) }; };
  ctx.input = { enabled: true }; await service.settings(ctx, true);
  const result = await service.scheduled(db);
  assert.equal(result.moved, 1); assert.equal(db.store.get(leadRef.path).status, 'stale');
  assert.equal((await service.settings(ctx)).enabled, true);
  assert.equal((await service.scheduled(db)).moved, 0);
  ctx.input.enabled = false; await service.settings(ctx, true);
  assert.equal((await service.scheduled(db)).enabled, false);
});
