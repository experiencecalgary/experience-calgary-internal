'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture, Timestamp } = require('./helpers/outreachMemory');
const calls = load('../../routes/command/commandOutreachCalls');
const queue = load('../../routes/command/commandCallQueueV2');
const contextApi = load('../../routes/command/commandOutreachContext');
const { resolveEmailLead } = load('../../lib/commandEmail/commandEmailLeadLink');
const request = data => ({ data });
async function start(f, data = {}) { return calls.startService(request({ leadRefPath: f.leadRef.path, clientRequestId: 'request1', ...data }), f); }

test('selected contact and dialed number survive primary contact changes', async () => {
  const f = fixture(); const other = f.db.doc('commandPeople/p2');
  f.db.store.set(other.path, { ownerUid: 'u1', fullName: 'Actual Contact', phone: '4035559999' });
  f.db.store.get(f.leadRef.path).connectedPersonRefs.push(other);
  const result = await start(f, { contactRefPath: other.path });
  assert.equal(result.dialedPhone, '4035559999');
  await calls.finishService(request({ callRefPath: result.callRefPath, outcome: 'connected', notes: 'Asked for a quote' }), f);
  const event = f.db.store.get('commandConnections/lead_call_finished_' + result.callRefPath.split('/')[1]);
  assert.equal(event.personRef.path, other.path);
  assert.equal(event.personName, 'Actual Contact');
});
test('reloading with another request ID resumes the unfinished call', async () => {
  const f = fixture(); const a = await start(f); const b = await start(f, { clientRequestId: 'request2' });
  assert.equal(a.callRefPath, b.callRefPath); assert.equal(b.resumed, true);
});
test('unrelated contacts, stale numbers and do-not-call leads cannot be dialed', async () => {
  const f = fixture();
  await assert.rejects(start(f, { contactRefPath: 'commandPeople/unrelated' }), /callable contact/);
  await assert.rejects(start(f, { phone: '4035551111' }), /changed/);
  f.db.store.get(f.leadRef.path).doNotCall = true;
  await assert.rejects(start(f), /callable contact/);
});
test('no-answer needs no note; duplicate finish cannot increment or create another follow-up', async () => {
  const f = fixture(); const a = await start(f);
  const input = { callRefPath: a.callRefPath, outcome: 'no_answer', nextStep: { mode: 'create', title: 'Retry', dueAt: new Date(Date.now() + 3600000).toISOString() } };
  const first = await calls.finishService(request(input), f);
  const retry = await calls.finishService(request(input), f);
  assert.equal(retry.duplicate, true); assert.equal(first.nextActionRefPath, retry.nextActionRefPath);
  assert.equal(f.db.store.get(f.leadRef.path).callAttemptCount, 1);
  assert.equal([...f.db.store.keys()].filter(p => p.startsWith('commandActions/')).length, 1);
});
test('call cancellation does not count an attempt or advance stage', async () => {
  const f = fixture(); const a = await start(f);
  await calls.finishService(request({ callRefPath: a.callRefPath, outcome: 'not_placed' }), f);
  assert.equal(f.db.store.get(a.callRefPath).status, 'cancelled');
  assert.equal(f.db.store.get(f.leadRef.path).callAttemptCount, undefined);
  assert.equal(f.db.store.get(f.leadRef.path).stage, 'New');
});
test('bad action relationship rolls the whole finish back', async () => {
  const f = fixture(); const a = await start(f);
  f.db.store.set('commandActions/bad', { leadRef: f.db.doc('commandLeads/elsewhere'), status: 'open', ownerUid: 'u1', actionType: 'Call' });
  await assert.rejects(calls.finishService(request({ callRefPath: a.callRefPath, outcome: 'no_answer', completeActionRefPath: 'commandActions/bad' }), f), /belong/);
  assert.equal(f.db.store.get(a.callRefPath).status, 'in_progress');
  assert.equal(f.db.store.get(f.leadRef.path).callAttemptCount, undefined);
});
test('completes the existing action and creates exactly one linked follow-up', async () => {
  const f = fixture(), action = f.db.doc('commandActions/a1');
  f.db.store.set(action.path, { leadRef: f.leadRef, ownerUid: 'u1', status: 'open', actionType: 'Call', title: 'Due call' });
  f.db.store.get(f.leadRef.path).nextActionRef = action;
  const a = await start(f);
  const result = await calls.finishService(request({ callRefPath: a.callRefPath, outcome: 'voicemail', completeActionRefPath: action.path,
    nextStep: { mode: 'create', title: 'Callback', dueAt: new Date(Date.now() + 3600000).toISOString() } }), f);
  assert.equal(f.db.store.get(action.path).status, 'completed');
  assert.equal(f.db.store.get(f.leadRef.path).nextActionRef.path, result.nextActionRefPath);
  assert.equal(f.db.store.get(f.leadRef.path).stage, 'Opened'); // preserve existing business rule
});
test('wrong-number flags the dialed number and removes it from callable selection', async () => {
  const f = fixture(), a = await start(f);
  await calls.finishService(request({ callRefPath: a.callRefPath, outcome: 'wrong_number' }), f);
  assert.equal(f.db.store.get(f.personRef.path).phoneStatus, 'wrong_number');
  await assert.rejects(start(f, { clientRequestId: 'retry' }), /callable contact/);
});
test('mark-ended freezes duration before notes are saved', async () => {
  const f = fixture(), a = await start(f);
  f.db.store.get(a.callRefPath).callStartedAt = Timestamp.fromMillis(Date.now() - 60000);
  await calls.markEndedService(request({ callRefPath: a.callRefPath }), f);
  const ended = f.db.store.get(a.callRefPath).callEndedAt;
  await calls.markEndedService(request({ callRefPath: a.callRefPath }), f);
  assert.equal(f.db.store.get(a.callRefPath).callEndedAt, ended);
  await calls.finishService(request({ callRefPath: a.callRefPath, outcome: 'no_answer' }), f);
  assert.equal(f.db.store.get(a.callRefPath).durationSource, 'rep_marked_end');
  assert.equal(f.db.store.get(a.callRefPath).durationSeconds, 60);
});
test('queue pagination does not skip leads when earlier calls disappear', async () => {
  const f = fixture();
  for (let i = 2; i <= 4; i++) f.db.store.set(`commandLeads/l${i}`, { ...f.db.store.get(f.leadRef.path), displayName: `Lead ${i}` });
  const input = { pageSize: 2, excludeCalledToday: true };
  const first = await queue.listCommandCallQueueService(request(input), f);
  assert.equal(first.records.length, 2);
  for (const row of first.records) f.db.store.get(row.refPath).lastCallAt = Timestamp.now();
  const second = await queue.listCommandCallQueueService(request({ ...input, pageToken: first.nextPageToken }), f);
  assert.equal(second.records.length, 2);
  assert.equal(second.records.some(r => first.records.some(p => p.id === r.id)), false);
  assert.equal(f.db.reads.some(r => r.col === 'commandLeads' && !r.filters.length), false);
  assert.equal(f.db.reads.some(r => r.col === 'commandActions' && !r.filters.some(x => x[0] === 'leadRef')), false);
});
test('today retry is per-rep, deduplicated, excludes cancelled and defaults to unanswered', async () => {
  const f = fixture();
  for (const [id, outcome, uid, status] of [['a', 'no_answer', 'u1', 'completed'], ['b', 'voicemail', 'u1', 'completed'], ['c', 'connected', 'u2', 'completed'], ['d', 'not_placed', 'u1', 'cancelled']]) {
    f.db.store.set(`commandCalls/${id}`, { leadRef: f.leadRef, outcome, createdByUid: uid, status, callFinishedAt: Timestamp.now() });
  }
  const result = await queue.listCommandCallQueueService(request({ queueMode: 'today_retry' }), f);
  assert.equal(result.records.length, 1); assert.equal(result.records[0].todayAttemptCount, 2);
});
test('manual queue preserves chosen order and permits same-day retry', async () => {
  const f = fixture(); f.db.store.set('commandLeads/l2', { ...f.db.store.get(f.leadRef.path), lastCallAt: Timestamp.now() });
  const result = await queue.listCommandCallQueueService(request({ queueMode: 'selected', excludeCalledToday: true, selectedLeadRefPaths: ['commandLeads/l2', 'commandLeads/l1'] }), f);
  assert.equal(result.records.map(r => r.id).join(','), 'l2,l1');
});
test('context returns website and an unfinished call without exposing unrelated contacts', async () => {
  const f = fixture(); const org = f.db.doc('commandOrganizations/o1');
  f.db.store.set(org.path, { ownerUid: 'u1', organization: 'Business', website: 'https://example.com' });
  f.db.store.get(f.leadRef.path).subjectOrganizationRef = org;
  const a = await start(f);
  const result = await contextApi._test.contextService(request({ leadRefPath: f.leadRef.path }), f);
  assert.equal(result.organization.website, 'https://example.com');
  assert.equal(result.pendingCall.callRefPath, a.callRefPath);
});
test('queue progress rejects stale writes', async () => {
  const f = fixture(); const q = await queue.listCommandCallQueueService(request({}), f);
  const input = { queueId: q.queueId, leadRefPath: f.leadRef.path, state: 'skipped', expectedRevision: 0 };
  await contextApi._test.progressService(request(input), f);
  await assert.rejects(contextApi._test.progressService(request(input), f), /progress changed/);
});
test('email lead link requires access and a matching relationship', async () => {
  const f = fixture(), ctx = await f.context(request({}));
  assert.equal((await resolveEmailLead(f.db, { ...ctx.actor, uid: ctx.uid }, { leadRefPath: f.leadRef.path }, { personRef: f.personRef })).path, f.leadRef.path);
  await assert.rejects(resolveEmailLead(f.db, { ...ctx.actor, uid: ctx.uid }, { leadRefPath: f.leadRef.path }, { personRef: f.db.doc('commandPeople/other') }), /belong/);
});

test('queue cursor cannot be reused by another rep or with changed filters', async () => {
  const f = fixture(); f.db.store.set('commandLeads/l2', { ...f.db.store.get(f.leadRef.path) });
  const q = await queue.listCommandCallQueueService(request({ pageSize: 1 }), f);
  await assert.rejects(queue.listCommandCallQueueService(request({ pageSize: 1, pageToken: q.nextPageToken, search: 'changed' }), f), /account and filters/);
  const outsider = { context: async req => ({ ...(await f.context(req)), uid: 'u2' }) };
  await assert.rejects(queue.listCommandCallQueueService(request({ pageSize: 1, pageToken: q.nextPageToken }), outsider), /account and filters/);
});
test('snapshot revalidates withdrawn lead access', async () => {
  const f = fixture(); f.db.store.set('commandLeads/l2', { ...f.db.store.get(f.leadRef.path) });
  const q = await queue.listCommandCallQueueService(request({ pageSize: 1 }), f);
  const other = [...f.db.store.entries()].find(([p]) => p.startsWith('commandLeads/') && p !== q.records[0].refPath);
  other[1].ownerUid = 'u2'; other[1].assignedToUid = 'u2';
  const next = await queue.listCommandCallQueueService(request({ pageSize: 1, pageToken: q.nextPageToken }), f);
  assert.equal(next.records.length, 0);
});
test('a retry of a resumed start stays attached to the same completed call', async () => {
  const f = fixture(); const a = await start(f); await start(f, { clientRequestId: 'resume' });
  await calls.finishService(request({ callRefPath: a.callRefPath, outcome: 'no_answer' }), f);
  const retry = await start(f, { clientRequestId: 'resume' });
  assert.equal(retry.callRefPath, a.callRefPath);
  assert.equal([...f.db.store.keys()].filter(p => p.startsWith('commandCalls/')).length, 1);
});
test('reschedule updates the existing action without adding a duplicate', async () => {
  const f = fixture(), action = f.db.doc('commandActions/a1');
  f.db.store.set(action.path, { leadRef: f.leadRef, ownerUid: 'u1', status: 'open', actionType: 'Call', title: 'Call' });
  f.db.store.get(f.leadRef.path).nextActionRef = action;
  const a = await start(f), dueAt = new Date(Date.now() + 7200000).toISOString();
  await calls.finishService(request({ callRefPath: a.callRefPath, outcome: 'connected', disposition: 'callback_requested', notes: 'Requested a later call', nextStep: { mode: 'reschedule', actionRefPath: action.path, title: 'Requested callback', dueAt } }), f);
  assert.equal(f.db.store.get(action.path).dueAt.toDate().toISOString(), dueAt);
  assert.equal(f.db.store.get(action.path).status, 'open');
  assert.equal([...f.db.store.keys()].filter(p => p.startsWith('commandActions/')).length, 1);
});
test('wrong-number outcome does not overwrite a corrected number', async () => {
  const f = fixture(), a = await start(f);
  f.db.store.get(f.personRef.path).phone = '4035559876';
  await calls.finishService(request({ callRefPath: a.callRefPath, outcome: 'wrong_number' }), f);
  assert.equal(f.db.store.get(f.personRef.path).phoneStatus, undefined);
});
test('do-not-call disposition restricts future calls without marking the Lead lost', async () => {
  const f = fixture(), a = await start(f);
  await calls.finishService(request({ callRefPath: a.callRefPath, outcome: 'connected', disposition: 'do_not_call', notes: 'Asked not to receive calls' }), f);
  assert.equal(f.db.store.get(f.leadRef.path).doNotCall, true);
  assert.equal(f.db.store.get(f.leadRef.path).status, 'active');
  await assert.rejects(start(f, { clientRequestId: 'another' }), /callable contact/);
});
test('atomic call save marks queue progress worked', async () => {
  const f = fixture(), q = await queue.listCommandCallQueueService(request({}), f), a = await start(f);
  await calls.finishService(request({ callRefPath: a.callRefPath, outcome: 'no_answer', queueId: q.queueId }), f);
  const progress = await contextApi._test.progressService(request({ queueId: q.queueId, readOnly: true }), f);
  assert.equal(progress.progress[f.leadRef.path], 'worked');
  assert.equal(progress.revision, 1);
});

test('resume skips completed and skipped queue entries', async () => {
  const f = fixture(); f.db.store.set('commandLeads/l2', { ...f.db.store.get(f.leadRef.path) });
  const q = await queue.listCommandCallQueueService(request({}), f);
  await contextApi._test.progressService(request({ queueId: q.queueId, expectedRevision: 0, leadRefPath: q.records[0].refPath, state: 'skipped', currentLeadRefPath: q.records[0].refPath }), f);
  const resumed = await queue.listCommandCallQueueService(request({ resumeQueueId: q.queueId }), f);
  assert.equal(resumed.records.length, 1);
  assert.equal(resumed.records[0].refPath, q.records[1].refPath);
});
test('business fallback cannot bypass a restricted hidden contact', async () => {
  const f = fixture(); const org = f.db.doc('commandOrganizations/o1');
  f.db.store.set(org.path, { ownerUid: 'u1', organization: 'Business', phone: '4035557890' });
  f.db.store.get(f.leadRef.path).subjectOrganizationRef = org;
  Object.assign(f.db.store.get(f.personRef.path), { ownerUid: 'u2', doNotCall: true });
  await assert.rejects(start(f, { contactRefPath: org.path }), /callable contact/);
  const result = await contextApi._test.contextService(request({ leadRefPath: f.leadRef.path }), f);
  assert.equal(result.contacts.length, 1);
  assert.equal(result.contacts[0].canCall, false);
});

test('Calgary retry day respects daylight-saving transitions', () => {
  const { localDayBounds } = load('../../lib/command/commandReportingUtils');
  const spring = localDayBounds('2026-03-08'), fall = localDayBounds('2026-11-01');
  assert.equal((spring.end.toMillis() - spring.start.toMillis()) / 3600000, 23);
  assert.equal((fall.end.toMillis() - fall.start.toMillis()) / 3600000, 25);
});

test('a committed start request remains replayable after wrong-number flagging', async () => {
  const f = fixture(), a = await start(f);
  await calls.finishService(request({ callRefPath: a.callRefPath, outcome: 'wrong_number' }), f);
  const replay = await start(f);
  assert.equal(replay.callRefPath, a.callRefPath);
  assert.equal(replay.duplicate, true);
  await assert.rejects(start(f, { clientRequestId: 'new-attempt' }), /callable contact/);
});
test('an expired and removed queue does not prevent saving a recovered call', async () => {
  const f = fixture(), q = await queue.listCommandCallQueueService(request({}), f), a = await start(f);
  f.db.store.delete(`commandOutreachQueues/${q.queueId}`);
  const result = await calls.finishService(request({ callRefPath: a.callRefPath, outcome: 'no_answer', queueId: q.queueId }), f);
  assert.equal(result.ok, true);
  assert.equal(f.db.store.get(a.callRefPath).status, 'completed');
  assert.equal(f.db.store.has(`commandOutreachQueues/${q.queueId}`), false);
});

test('Person Lead email permits its connected contact’s existing employer without relinking the Lead', async () => {
  const f = fixture(), ctx = await f.context(request({})), org = f.db.doc('commandOrganizations/employer');
  f.db.store.set(org.path, { ownerUid: 'u1', organization: 'Employer' });
  f.db.store.get(f.personRef.path).organizationRef = org;
  const result = await resolveEmailLead(f.db, { ...ctx.actor, uid: ctx.uid }, { leadRefPath: f.leadRef.path }, { personRef: f.personRef, organizationRef: org });
  assert.equal(result.path, f.leadRef.path);
  assert.equal(f.db.store.get(f.leadRef.path).subjectOrganizationRef, undefined);
  await assert.rejects(resolveEmailLead(f.db, { ...ctx.actor, uid: ctx.uid }, { leadRefPath: f.leadRef.path }, { personRef: f.personRef, organizationRef: f.db.doc('commandOrganizations/unrelated') }), /belong/);
});
