'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture, Timestamp } = require('./helpers/outreachMemory');
const workspace = load('../../lib/command/commandLeadWorkspace');
const api = load('../../routes/command/commandLeadWorkspace')._test;
const request = data => ({ data });
const leadPath = 'commandLeads/l1';
const ctx = async (f, input = {}) => f.context(request(input));
const listing = { serializeLead: (ref, d) => ({ ...d, refPath: ref.path }), matchesFilters: (d, i) =>
  (!i.search || d.displayName.toLowerCase().includes(i.search.toLowerCase())) && (!i.stage || d.stage.toLowerCase() === i.stage.toLowerCase()) };
function leads(f, count) {
  const base = f.db.store.get(leadPath);
  for (let n = 0; n < count; n++) f.db.store.set(`commandLeads/item${String(n).padStart(3, '0')}`, {
    ...base, displayName: `Lead ${n}`, updatedAt: Timestamp.fromMillis(100000 - n * 100),
  });
}
function action(f, id, due, extras = {}) {
  f.db.store.set(`commandActions/${id}`, { leadRef: f.leadRef, ownerUid: 'u1', assignedToUid: 'u1',
    title: id, actionType: 'Follow-up', status: 'open', createdAt: Timestamp.now(), dueAt: Timestamp.fromMillis(due), ...extras });
}
test('list uses scoped indexed reads, deduplicates and pages all same-timestamp leads', async () => {
  const f = fixture(); leads(f, 47);
  for (const [p, d] of f.db.store) if (p.startsWith('commandLeads/item')) d.updatedAt = Timestamp.fromMillis(100000);
  f.db.store.set('commandLeads/outsider', { ownerUid: 'other', updatedAt: Timestamp.now(), displayName: 'Hidden' });
  const found = []; let token = '';
  do {
    const result = await workspace.listLeads(await ctx(f, { pageSize: 7, pageToken: token }), listing);
    found.push(...result.records.map(r => r.refPath)); token = result.nextPageToken;
  } while (token);
  assert.equal(found.length, 47); assert.equal(new Set(found).size, 47);
  assert.equal(f.db.reads.some(r => r.col === 'commandLeads' && !r.filters.length), false);
});
test('filters are pushed into query and tokens reject changed account/filter', async () => {
  const f = fixture(); leads(f, 30);
  const input = { stage: 'new', pageSize: 2 };
  const first = await workspace.listLeads(await ctx(f, input), listing);
  assert.ok(f.db.reads.every(r => r.filters.some(x => x[0] === 'stage' && x[2] === 'New')));
  await assert.rejects(workspace.listLeads(await ctx(f, { ...input, stage: 'Engaged', pageToken: first.nextPageToken }), listing), /page token/);
  const other = await ctx(f, { ...input, pageToken: first.nextPageToken }); other.uid = 'other';
  await assert.rejects(workspace.listLeads(other, listing), /page token/);
});
test('sparse search is bounded and continuation reaches later matches', async () => {
  const f = fixture(); leads(f, 150);
  const input = { pageSize: 1, search: 'Lead 149' };
  const first = await workspace.listLeads(await ctx(f, input), listing);
  assert.equal(first.records.length, 0); assert.equal(first.scanLimited, true); assert.ok(first.nextPageToken);
  const second = await workspace.listLeads(await ctx(f, { ...input, pageToken: first.nextPageToken }), listing);
  assert.equal(second.records[0].displayName, 'Lead 149');
  assert.ok(first.scannedRecords <= 200);
});
test('team scope excludes mine and hides records outside current access', async () => {
  const f = fixture(); leads(f, 4);
  f.db.store.set('commandLeads/team', { status: 'active', archived: false, ownerUid: 'other', viewerUids: ['u1'], displayName: 'Team', updatedAt: Timestamp.now() });
  const result = await workspace.listLeads(await ctx(f, { scope: 'team' }), listing);
  assert.deepEqual(result.records.map(r => r.displayName), ['Team']);
  await assert.rejects(workspace.listLeads(await ctx(f, { scope: 'all' }), listing), /scope/);
});
test('overview supplies contact details without loading history or agreements and resolves remaining work', async () => {
  const f = fixture(); action(f, 'done', 1, { status: 'completed' }); action(f, 'remaining', 2);
  f.db.store.get(leadPath).nextActionRef = f.db.doc('commandActions/done');
  const result = await api.overviewService(request({ leadRefPath: leadPath }), f);
  assert.equal(result.contacts[0].phone, '4035551234'); assert.equal(result.nextAction.title, 'remaining');
  assert.equal(result.nextActionComplete, true);
  assert.equal(f.db.reads.some(r => ['commandConnections', 'commandAgreements', 'commandNotes'].includes(r.col)), false);
});
test('overview never presents a partial action scan as no work', async () => {
  const f = fixture(); for (let n = 0; n < 201; n++) action(f, `a${n}`, n);
  const result = await api.overviewService(request({ leadRefPath: leadPath }), f);
  assert.equal(result.nextActionComplete, false); assert.equal(result.nextAction, null);
});
test('Work includes permitted work assigned to another rep, not unrelated work', async () => {
  const f = fixture(); action(f, 'shared', 10, { ownerUid: 'other', assignedToUid: 'other', viewerUids: ['u1'] });
  action(f, 'hidden', 20, { ownerUid: 'other', assignedToUid: 'other' });
  action(f, 'unrelated', 30, { leadRef: f.db.doc('commandLeads/other') });
  const r = await api.sectionService(request({ leadRefPath: leadPath, section: 'actions' }), f);
  assert.deepEqual(r.records.map(x => x.title), ['shared']);
  assert.ok(f.db.reads.every(r => r.filters.some(x => x[0] === 'leadRef')));
});
test('ExMail section cannot grant access solely through an assignedToUid', async () => {
  const f = fixture();
  for (const [id, acl] of [['allowed', { ownerUid: 'u1' }], ['hidden', { assignedToUid: 'u1' }]])
    f.db.store.set(`commandEmailThreads/${id}`, { leadRef: f.leadRef, lastMessageAt: Timestamp.now(), subject: id, ...acl });
  const r = await api.sectionService(request({ leadRefPath: leadPath, section: 'emails' }), f);
  assert.deepEqual(r.records.map(x => x.subject), ['allowed']);
});
test('notes are retry-safe, preserve authorship and retain edits as revisions', async () => {
  const f = fixture(), input = { leadRefPath: leadPath, clientRequestId: 'note1', body: 'First conversation' };
  const note = await api.saveNoteService(request(input), f);
  assert.equal((await api.saveNoteService(request(input), f)).duplicate, true);
  await assert.rejects(api.saveNoteService(request({ ...input, body: 'Different' }), f), /Request ID/);
  const updated = await api.saveNoteService(request({ leadRefPath: leadPath, noteRefPath: note.noteRefPath, expectedRevision: 1, body: 'Corrected conversation', pinned: true }), f);
  assert.equal(updated.revision, 2);
  assert.equal(f.db.store.get(`${api.revisionCollection(note.noteRefPath)}/1`).body, 'First conversation');
  assert.equal(f.db.store.get(note.noteRefPath).createdByName, 'Rep One');
  await assert.rejects(api.saveNoteService(request({ leadRefPath: leadPath, noteRefPath: note.noteRefPath, expectedRevision: 1, body: 'Stale' }), f), /changed/);
  assert.equal([...f.db.store.keys()].filter(p => p.startsWith('commandConnections/')).length, 1);
});
test('unrelated or unauthorized note mutations leave all data untouched', async () => {
  const f = fixture(); const n = await api.saveNoteService(request({ leadRefPath: leadPath, clientRequestId: 'x', body: 'Private' }), f);
  const before = f.db.store.get(n.noteRefPath).body;
  f.db.store.set('commandLeads/other', { ownerUid: 'u1' });
  await assert.rejects(api.saveNoteService(request({ leadRefPath: 'commandLeads/other', noteRefPath: n.noteRefPath, expectedRevision: 1, body: 'Bad' }), f), /belong/);
  f.db.store.get(leadPath).ownerUid = 'other'; f.db.store.get(leadPath).assignedToUid = 'other';
  await assert.rejects(api.saveNoteService(request({ leadRefPath: leadPath, noteRefPath: n.noteRefPath, expectedRevision: 1, body: 'Bad' }), f), /accessible/);
  assert.equal(f.db.store.get(n.noteRefPath).body, before);
});
test('notes section includes standalone, call and meeting notes without start-event duplicates', async () => {
  const f = fixture(); await api.saveNoteService(request({ leadRefPath: leadPath, clientRequestId: 'n', body: 'Standalone' }), f);
  for (const type of ['call_finished', 'call_started', 'meeting_held']) f.db.store.set(`commandConnections/${type}`, {
    leadRef: f.leadRef, ownerUid: 'u1', type, body: type, createdAt: Timestamp.now(),
  });
  const r = await api.sectionService(request({ leadRefPath: leadPath, section: 'notes' }), f);
  assert.equal(r.records.length, 3); assert.equal(r.records.some(x => x.type === 'call_started'), false);
});
test('action reconciliation is idempotent and selects another outstanding action', async () => {
  const f = fixture(); action(f, 'done', 1, { status: 'completed' }); action(f, 'next', 2);
  await api.refreshNextAction(f.db, f.leadRef); await api.refreshNextAction(f.db, f.leadRef);
  assert.equal(f.db.store.get(leadPath).nextActionRef.path, 'commandActions/next');
  f.db.store.get('commandActions/next').status = 'completed';
  await api.refreshNextAction(f.db, f.leadRef); assert.equal(f.db.store.get(leadPath).nextActionRef, null);
});
test('source mutation invalidates access even when a page token still exists', async () => {
  const f = fixture(); leads(f, 30);
  const r = await workspace.listLeads(await ctx(f, { pageSize: 1 }), listing);
  for (const [p, d] of f.db.store) if (p.startsWith('commandLeads/')) { d.ownerUid = 'other'; d.assignedToUid = 'other'; }
  const next = await workspace.listLeads(await ctx(f, { pageSize: 1, pageToken: r.nextPageToken }), listing);
  assert.equal(next.records.length, 0);
});

test('incomplete Person permits unrelated edits but rejects invalid supplied contact data', async () => {
  const update = load('../../lib/command/updateCommandPerson').updateCommandPersonService;
  const f = fixture();
  Object.assign(f.db.store.get(f.personRef.path), { firstName: '', fullName: 'Imported contact', email: '', phone: '' });
  const input = { auth: { uid: 'u1' }, data: { personId: 'p1', notes: 'Spoke to reception', position: 'Manager' } };
  await update(input, f);
  assert.equal(f.db.store.get(f.personRef.path).notes, 'Spoke to reception');
  assert.equal(f.db.store.get(f.personRef.path).fullName, 'Imported contact');
  await assert.rejects(update({ ...input, data: { personId: 'p1', phone: '123' } }, f), /invalid/);
  await assert.rejects(update({ ...input, data: { personId: 'p1', firstName: '' } }, f), /invalid/);
});
test('new owner can read and edit managed Lead notes after reassignment', async () => {
  const f = fixture(); const n = await api.saveNoteService(request({ leadRefPath: leadPath, clientRequestId: 'n', body: 'Handoff note' }), f);
  Object.assign(f.db.store.get(leadPath), { ownerUid: 'u2', assignedToUid: 'u2', viewerUids: [] });
  const other = { ...f, context: async r => ({ ...(await ctx(f, r.data)), uid: 'u2', actor: { userRef: f.db.doc('users/u2'), userData: { userType: 'rep', fullName: 'New owner' } } }) };
  const notes = await api.sectionService(request({ leadRefPath: leadPath, section: 'notes' }), other);
  assert.equal(notes.records.length, 1);
  await api.saveNoteService(request({ leadRefPath: leadPath, noteRefPath: n.noteRefPath, expectedRevision: 1, pinned: true }), other);
  assert.equal(f.db.store.get(n.noteRefPath).createdByName, 'Rep One');
});
test('inactive reps cannot read or write through the workspace endpoints', async () => {
  const f = fixture(); f.db.store.get('users/u1').active = false;
  await assert.rejects(api.overviewService(request({ leadRefPath: leadPath }), f), /Inactive/);
  await assert.rejects(api.saveNoteService(request({ leadRefPath: leadPath, clientRequestId: 'x', body: 'Bad' }), f), /Inactive/);
});

test('sent ExMail follow-up retains explicit Lead and participates in next-action selection', async () => {
  const handler = load('../../routes/command/commandEngagementLifecycle')._test.outboundEmailSentEngagementHandler;
  const f = fixture(), threadRef = f.db.doc('commandEmailThreads/t1');
  f.db.store.set(threadRef.path, { leadRef: f.leadRef, personRef: f.personRef, ownerUid: 'u1', ownerRef: f.db.doc('users/u1'), subject: 'Follow up' });
  const message = { direction: 'out', status: 'sent', createdByRef: f.db.doc('users/u1'), commandFollowUp: {
    dueAt: new Date(Date.now() + 86400000).toISOString(), title: 'Discuss proposal' } };
  await handler({ data: { before: { exists: true, data: () => ({ status: 'processing' }) }, after: {
    exists: true, id: 'm1', ref: { path: 'commandEmailThreads/t1/emailMessages/m1', parent: { parent: threadRef } }, data: () => message,
  } } }, f);
  assert.equal(f.db.store.get('commandActions/email_followup_m1').leadRef.path, leadPath);
  await api.refreshNextAction(f.db, f.leadRef);
  assert.equal(f.db.store.get(leadPath).nextActionTitle, 'Discuss proposal');
});
test('pinned notes and latest conversation are available separately from overview', async () => {
  const f = fixture(); await api.saveNoteService(request({ leadRefPath: leadPath, clientRequestId: 'pin', body: 'Remember the owner', pinned: true }), f);
  f.db.store.set('commandConnections/call', { leadRef: f.leadRef, ownerUid: 'u1', type: 'call_finished', body: 'Connected', createdAt: Timestamp.now() });
  const r = await api.highlightsService(request({ leadRefPath: leadPath }), f);
  assert.equal(r.pinnedNotes.length, 1); assert.equal(r.latestConversation.body, 'Connected');
  assert.equal(r.conversationScanComplete, true);
});
test('note history returns the original content and current content', async () => {
  const f = fixture(); const n = await api.saveNoteService(request({ leadRefPath: leadPath, clientRequestId: 'h', body: 'Original' }), f);
  await api.saveNoteService(request({ leadRefPath: leadPath, noteRefPath: n.noteRefPath, expectedRevision: 1, body: 'Revised' }), f);
  const history = await api.noteHistoryService(request({ leadRefPath: leadPath, noteRefPath: n.noteRefPath }), f);
  assert.equal(history.current.body, 'Revised'); assert.equal(history.records[0].body, 'Original');
});


test('action editor rechecks current work after a trigger/concurrent edit instead of restoring stale summary', async () => {
  const update = load('../../routes/command/commandActionLifecycle').updateCommandActionService;
  const f = fixture(); action(f, 'edited', 100);
  f.db.store.get(leadPath).nextActionRef = f.db.doc('commandActions/edited');
  const originalDoc = f.db.doc;
  f.db.doc = path => {
    const ref = originalDoc(path);
    if (path === 'commandActions/edited') {
      const originalUpdate = ref.update;
      ref.update = async data => {
        await originalUpdate(data);
        f.db.store.get(path).dueAt = Timestamp.fromMillis(5);
        await api.refreshNextAction(f.db, f.leadRef);
      };
    }
    return ref;
  };
  await update(request({ actionRefPath: 'commandActions/edited', title: 'Edited title' }), f);
  const lead = f.db.store.get(leadPath);
  assert.equal(lead.nextActionTitle, 'Edited title');
  assert.equal(lead.nextActionAt.toMillis(), 5);
});

test('redelivered sent-email event preserves completed follow-up and manual edits', async () => {
  const handler = load('../../routes/command/commandEngagementLifecycle')._test.outboundEmailSentEngagementHandler;
  const f = fixture(), threadRef = f.db.doc('commandEmailThreads/t1');
  f.db.store.set(threadRef.path, { leadRef: f.leadRef, ownerUid: 'u1', ownerRef: f.db.doc('users/u1') });
  const event = { data: { before: { exists: true, data: () => ({ status: 'processing' }) }, after: {
    exists: true, id: 'retry', ref: { path: threadRef.path + '/emailMessages/retry', parent: { parent: threadRef } },
    data: () => ({ direction: 'out', status: 'sent', createdByRef: f.db.doc('users/u1'), commandFollowUp: {
      dueAt: new Date(Date.now() + 86400000).toISOString(), title: 'Original title' } }),
  } } };
  await handler(event, f);
  const saved = f.db.store.get('commandActions/email_followup_retry');
  saved.status = 'completed'; saved.title = 'Rep edited title'; saved.completionNotes = 'Done';
  await handler(event, f);
  assert.equal(f.db.store.get('commandActions/email_followup_retry'), saved);
  assert.equal(saved.status, 'completed'); assert.equal(saved.title, 'Rep edited title');
});


test('team paging retains access through numeric legacy team IDs', async () => {
  const f = fixture();
  for (const [id, repId] of [['number', 1], ['string', '1'], ['hidden', 2]])
    f.db.store.set('commandLeads/' + id, { status: 'active', archived: false, ownerUid: 'other', teamRepIds: [repId], displayName: id, updatedAt: Timestamp.now() });
  const r = await workspace.listLeads(await ctx(f, { scope: 'team' }), listing);
  assert.deepEqual(r.records.map(x => x.displayName).sort(), ['number', 'string']);
});

test('activity serializer keeps outcome context and completion notes without private payloads', async () => {
  const f = fixture();
  action(f, 'done', 1, { status: 'completed', completionNotes: 'Decision maker asked for Friday',
    completedAt: Timestamp.fromMillis(10), signingToken: 'private', details: { mainBlocker: 'timing', blockerNotes: 'Next quarter', secret: 'private' } });
  const r = await api.sectionService(request({ leadRefPath: leadPath, section: 'actions' }), f);
  assert.equal(r.records[0].notes, 'Decision maker asked for Friday');
  assert.equal(r.records[0].mainBlocker, 'timing');
  assert.equal(r.records[0].completedAt, new Date(10).toISOString());
  assert.equal(JSON.stringify(r).includes('private'), false);
});

