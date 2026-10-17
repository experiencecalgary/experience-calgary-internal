'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { meetingExternalEmail } = require('../routes/command/commandMeetingLifecycle');
const presentation = require('../routes/command/commandPartnerPresentation')._test;
const { chooseBestContact } = require('../routes/command/commandCallQueueV2')._test;
const { resolveTarget } = require('../lib/command/commandAgreements');

test('booking without a Person or usable email does not invite an external attendee', () => {
  assert.equal(meetingExternalEmail(null), '');
  assert.equal(meetingExternalEmail({ email: 'invalid' }), '');
  assert.equal(meetingExternalEmail({ email: 'contact@example.com' }, false), '');
  assert.equal(meetingExternalEmail({ email: 'contact@example.com' }), 'contact@example.com');
  assert.throws(() => meetingExternalEmail(null, true), /valid email/);
  assert.throws(() => meetingExternalEmail(null, 'false'), /boolean/);
});

test('organization-only presentation context and session retain Lead/Organization', async () => {
  const ref = (path, data) => ({ path, id: path.split('/')[1], get: async () => ({ exists: true, data: () => data }) });
  const leadRef = ref('commandLeads/l', { ownerUid: 'rep', displayName: 'Opportunity' });
  const orgRef = ref('commandOrganizations/o', { organization: 'Business' });
  const meeting = { ref: ref('commandActions/m', {}), data: { leadRef, organizationRef: orgRef } };
  const ctx = { uid: 'rep', actor: { userData: {}, userRef: ref('users/rep', {}) } };
  const related = await presentation.relatedContext(ctx, meeting);
  assert.equal(related.person, null);
  const session = presentation.baseSession(ctx, meeting, related.lead, related.organization, null, 'now');
  assert.equal(session.personRef, null);
  assert.equal(session.personName, '');
  assert.equal(session.leadRef.path, leadRef.path);
  assert.equal(session.organizationRef.path, orgRef.path);
  assert.equal(presentation.personPayload(null), null);
  await assert.rejects(presentation.relatedContext({ ...ctx, uid: 'other' }, meeting), /access/);
  await assert.rejects(presentation.relatedContext(ctx, { ...meeting, data: { ...meeting.data, personRef: ref('commandPeople/missing', {}) , leadRef: null } }), /Lead is missing/);
});

test('business contact fallback works without fabricating a Person reference', () => {
  const lead = { subjectOrganizationRef: { path: 'commandOrganizations/o' } };
  const organizations = new Map([['commandOrganizations/o', { name: 'Business', phone: '4035550101', email: 'office@example.com' }]]);
  const contact = chooseBestContact(lead, new Map(), organizations);
  assert.equal(contact.recordType, 'organization');
  assert.equal(contact.refPath, 'commandOrganizations/o');
  assert.equal(contact.canCall, true);
  assert.equal(chooseBestContact(lead, new Map()), null);
  organizations.get('commandOrganizations/o').doNotCall = true;
  assert.equal(chooseBestContact(lead, new Map(), organizations).canCall, false);
});

test('business fallback cannot bypass a linked Person or Lead do-not-call flag', () => {
  const lead = { subjectOrganizationRef: { path: 'commandOrganizations/o' }, primaryContactRef: { path: 'commandPeople/p' } };
  const people = new Map([['commandPeople/p', { phone: '4035550102', doNotCall: true }]]);
  const organizations = new Map([['commandOrganizations/o', { phone: '4035550101', email: 'office@example.com' }]]);
  assert.equal(chooseBestContact(lead, people, organizations).canCall, false);
  people.get('commandPeople/p').doNotCall = false;
  assert.equal(chooseBestContact(lead, people, organizations).recordType, 'person');
  assert.equal(chooseBestContact({ ...lead, doNotCall: true }, people, organizations).canCall, false);
});

test('agreement preview accepts incomplete contacts but send validation remains strict', async () => {
  const ctx = { db: { doc: path => ({ path, get: async () => ({ exists: true, data: () => ({ organization: 'Business' }) }) }) } };
  const input = { organizationRefPath: 'commandOrganizations/o' };
  const preview = await resolveTarget(ctx, input, { preview: true });
  assert.equal(preview.contactName, '');
  assert.equal(preview.email, '');
  await assert.rejects(resolveTarget(ctx, input), /signer\/contact name/);
  await assert.rejects(resolveTarget(ctx, { ...input, contactName: 'Owner' }), /email/);
  await assert.rejects(resolveTarget(ctx, { ...input, contactName: 'Owner', email: 'owner@example.com' }), /phone/);
  assert.equal((await resolveTarget(ctx, { ...input, contactName: 'Owner', email: 'owner@example.com', phone: '4035550101' })).email, 'owner@example.com');
  await assert.rejects(resolveTarget(ctx, {}, { preview: true }), /Select a Command/);
});

test('presentation permits organization-only partnership but rejects wrong type and missing Organization', async () => {
  let data = { actionType: 'meeting', meetingType: 'partnership', ownerUid: 'rep', leadRef: { path: 'commandLeads/l' }, organizationRef: { path: 'commandOrganizations/o' } };
  const ctx = { uid: 'rep', actor: { userData: {} }, input: { meetingRefPath: 'commandActions/m' }, db: { doc: path => ({ path, get: async () => ({ exists: true, data: () => data }) }) } };
  assert.equal((await presentation.readPresentationMeeting(ctx)).data.personRef, undefined);
  data = { ...data, meetingType: 'sales' };
  await assert.rejects(presentation.readPresentationMeeting(ctx), /Only Partnership/);
  data = { ...data, meetingType: 'partnership', organizationRef: null };
  await assert.rejects(presentation.readPresentationMeeting(ctx), /Lead and Organization/);
});

test('rescheduling preserves internal attendees alongside an external attendee', async () => {
  const { rescheduleAttendeeEmails } = require('../routes/command/commandMeetingLifecycle');
  const internal = { get: async () => ({ data: () => ({ email: 'rep@example.com' }) }) };
  assert.deepEqual(await rescheduleAttendeeEmails({ externalAttendeeEmail: 'customer@example.com', internalAttendeeRefs: [internal] }), ['customer@example.com', 'rep@example.com']);
  assert.deepEqual(await rescheduleAttendeeEmails({ externalAttendeeEmail: 'customer@example.com', internalAttendeeRefs: [internal] }, [{ email: 'newrep@example.com' }]), ['customer@example.com', 'newrep@example.com']);
});

test('rescheduling never reintroduces an explicitly disabled external invitation', async () => {
  const { rescheduleAttendeeEmails } = require('../routes/command/commandMeetingLifecycle');
  const personRef = { get: async () => { throw new Error('Must not resolve suppressed recipient'); } };
  assert.deepEqual(await rescheduleAttendeeEmails({ externalInvitationEnabled: false, externalAttendeeEmail: 'old@example.com', personRef }, [{ email: 'rep@example.com' }]), ['rep@example.com']);
  assert.deepEqual(await rescheduleAttendeeEmails({ personRef: { get: async () => ({ data: () => ({ email: 'legacy@example.com' }) }) } }, [{ email: 'rep@example.com' }]), ['legacy@example.com', 'rep@example.com']);
});
