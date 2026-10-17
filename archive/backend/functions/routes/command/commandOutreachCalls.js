'use strict';

const crypto = require('crypto');
const admin = require('firebase-admin');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { commandActorContext } = require('../../lib/command/commandReportingUtils');
const { isPlatformAdminUser } = require('../../lib/command/commandPersonUtils');
const { clean, refPath, ms, documentPath, readLead, readContacts, restricted, callablePhone, contactName, futureTime, visible, connectedPaths } = require('../../lib/command/commandOutreachSupport');
const OUTCOMES = ['connected', 'voicemail', 'no_answer', 'wrong_number', 'not_interested', 'not_placed'];
const DISPOSITIONS = ['', 'interested', 'callback_requested', 'not_interested', 'do_not_call'];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const name = ctx => contactName(ctx.actor.userData) || 'Representative';
function ownerCanFinish(ctx, call) {
  if (call.createdByUid !== ctx.uid && !isPlatformAdminUser(ctx.actor.userData)) throw new HttpsError('permission-denied', 'Only the calling representative can finish this call.');
}
function contextFields(lead, contact) {
  return { leadRef: lead.ref, leadName: clean(lead.data.displayName),
    personRef: contact?.ref.path.startsWith('commandPeople/') ? contact.ref : null,
    personName: contact?.ref.path.startsWith('commandPeople/') ? contactName(contact.data()) : '',
    organizationRef: lead.data.subjectOrganizationRef || null, organizationName: clean(lead.data.subjectOrganizationName),
    contactRef: contact?.ref || null, contactRecordType: contact?.ref.path.startsWith('commandPeople/') ? 'person' : 'organization',
    contactName: contact ? contactName(contact.data()) : '', dialedPhone: contact ? clean(contact.data().phone) : '',
    ownerRef: lead.data.ownerRef || null, ownerUid: clean(lead.data.ownerUid), ownerName: clean(lead.data.ownerName),
    assignedToRef: lead.data.assignedToRef || null, assignedToUid: clean(lead.data.assignedToUid), assignedToName: clean(lead.data.assignedToName),
    viewerUids: lead.data.viewerUids || [], teamRepIds: lead.data.teamRepIds || [] };
}
async function startService(request, deps = {}) {
  const ctx = await (deps.context || commandActorContext)(request);
  const lead = await readLead(ctx, ctx.input.leadRefPath);
  const id = clean(ctx.input.clientRequestId);
  if (!id || id.length > 200) throw new HttpsError('invalid-argument', 'clientRequestId is required (maximum 200 characters).');
  const requestRef = ctx.db.doc(`commandActivityRequests/${ctx.uid}_lead_call_start_${hash(id)}`);
  const slotRef = ctx.db.doc(`commandActivityRequests/${ctx.uid}_active_call_${lead.ref.id}`);
  const contacts = await readContacts(ctx, lead.data);
  const requested = clean(ctx.input.contactRefPath);
  const allPersonRestricted = contacts.blockBusinessFallback;
  const eligible = contacts.filter(d => callablePhone(d.data()) && !(d.ref.path.startsWith('commandOrganizations/') && allPersonRestricted));
  const contact = requested ? contacts.find(d => d.ref.path === requested) : eligible[0];
  const callRef = ctx.db.doc(`commandCalls/${hash(`${ctx.uid}:${id}`)}`);
  return ctx.db.runTransaction(async tx => {
    const [prior, slot, currentLead, ...currentContacts] = await Promise.all([tx.get(requestRef), tx.get(slotRef), tx.get(lead.ref), ...(contacts.restrictionRefs || contacts.map(d => d.ref)).map(ref => tx.get(ref))]);
    if (prior.exists) {
      if (prior.data().result?.leadRefPath !== lead.ref.path) throw new HttpsError('invalid-argument', 'This request ID belongs to another Lead.');
      return { ok: true, duplicate: true, ...prior.data().result };
    }
    if (!currentLead.exists || currentLead.data().archived === true || currentLead.data().status !== 'active' || !visible(ctx.uid, ctx.actor.userData, currentLead.data())) throw new HttpsError('failed-precondition', 'Lead access or status changed. Refresh.');
    if (!contact || !eligible.includes(contact) || restricted(lead.data)) throw new HttpsError('failed-precondition', 'Choose an available callable contact connected to this Lead.');
    if (ctx.input.phone && clean(ctx.input.phone).replace(/\D/g, '') !== clean(contact.data().phone).replace(/\D/g, '')) throw new HttpsError('failed-precondition', 'The phone number changed. Refresh this contact before calling.');
    const selected = currentContacts.find(d => d.ref.path === contact.ref.path);
    if (!selected?.exists || !connectedPaths(currentLead.data()).includes(selected.ref.path) || selected.data().archived === true || !visible(ctx.uid, ctx.actor.userData, selected.data()) || !callablePhone(selected.data()) || restricted(currentLead.data()) ||
      (selected.ref.path.startsWith('commandOrganizations/') && currentContacts.some(d => d.exists && d.ref.path.startsWith('commandPeople/') && restricted(d.data()))) ||
      clean(selected.data().phone) !== clean(contact.data().phone)) throw new HttpsError('failed-precondition', 'Contact information changed. Refresh before calling.');
    // A single recoverable active call per rep/lead, including across browser reloads.
    if (slot.exists && slot.data().callRef) {
      const pending = await tx.get(slot.data().callRef);
      if (pending.exists && pending.data().status === 'in_progress') {
        if (requested && refPath(pending.data().contactRef) !== requested) throw new HttpsError('failed-precondition', 'Finish or cancel the existing call before changing contacts.');
        const result = { callRefPath: pending.ref.path, leadRefPath: lead.ref.path, dialedPhone: clean(pending.data().dialedPhone), contactRefPath: refPath(pending.data().contactRef) };
        tx.create(requestRef, { result, createdAt: admin.firestore.Timestamp.now() });
        return { ok: true, duplicate: true, resumed: true, ...result };
      }
    }
    const at = admin.firestore.Timestamp.now();
    const fields = contextFields({ ref: lead.ref, data: currentLead.data() }, selected);
    const result = { callRefPath: callRef.path, leadRefPath: lead.ref.path, contactRefPath: selected.ref.path, dialedPhone: fields.dialedPhone };
    const actor = { createdByRef: ctx.actor.userRef, createdByUid: ctx.uid, createdByName: name(ctx) };
    tx.create(callRef, { ...fields, ...actor, status: 'in_progress', callStartedAt: at, createdAt: at, updatedAt: at });
    tx.create(ctx.db.doc(`commandConnections/lead_call_started_${callRef.id}`), { ...fields, ...actor, type: 'call_started', summary: `Call started: ${fields.leadName}`, body: '', details: {}, sourceRef: callRef, callRef, createdAt: at });
    tx.set(slotRef, { callRef, updatedAt: at });
    tx.create(requestRef, { result, createdAt: at });
    return { ok: true, duplicate: false, ...result };
  });
}
function validateFinish(input) {
  const outcome = clean(input.outcome).toLowerCase(), disposition = clean(input.disposition).toLowerCase(), notes = clean(input.notes);
  if (!OUTCOMES.includes(outcome)) throw new HttpsError('invalid-argument', `outcome must be one of: ${OUTCOMES.join(', ')}.`);
  if (!DISPOSITIONS.includes(disposition) || (disposition && outcome !== 'connected')) throw new HttpsError('invalid-argument', 'A disposition is allowed only for a connected call.');
  if (['connected', 'not_interested'].includes(outcome) && !notes) throw new HttpsError('invalid-argument', 'Add a short note about the conversation.');
  if (notes.length > 5000) throw new HttpsError('invalid-argument', 'Notes must be 5,000 characters or fewer.');
  if (outcome === 'not_placed' && (input.nextStep || input.completeActionRefPath)) throw new HttpsError('invalid-argument', 'Cancel the call without completing outreach actions.');
  return { outcome, disposition, notes };
}
async function finishService(request, deps = {}) {
  const ctx = await (deps.context || commandActorContext)(request);
  const callRef = ctx.db.doc(documentPath(ctx.input.callRefPath, 'commandCalls'));
  const { outcome, disposition, notes } = validateFinish(ctx.input);
  const completeRef = ctx.input.completeActionRefPath ? ctx.db.doc(documentPath(ctx.input.completeActionRefPath, 'commandActions')) : null;
  const queueId = clean(ctx.input.queueId);
  if (queueId && !/^[A-Za-z0-9_-]{1,100}$/.test(queueId)) throw new HttpsError('invalid-argument', 'Invalid queue ID.');
  const queueRef = queueId ? ctx.db.doc(`commandOutreachQueues/${queueId}`) : null;
  const step = ctx.input.nextStep;
  if (step && (!['create', 'reschedule'].includes(step.mode) || !clean(step.title) || clean(step.title).length > 200)) throw new HttpsError('invalid-argument', 'Choose create/reschedule and a next-step title (maximum 200 characters).');
  const nextRef = step ? (step.mode === 'reschedule' ? ctx.db.doc(documentPath(step.actionRefPath, 'commandActions')) : ctx.db.doc(`commandActions/call_followup_${callRef.id}`)) : null;
  if (nextRef && completeRef?.path === nextRef.path) throw new HttpsError('invalid-argument', 'Reschedule or complete the existing action, not both.');
  return ctx.db.runTransaction(async tx => {
    const snap = await tx.get(callRef);
    if (!snap.exists) throw new HttpsError('not-found', 'Call not found.');
    const call = snap.data(); ownerCanFinish(ctx, call);
    if (['completed', 'cancelled'].includes(call.status)) return { ok: true, duplicate: true, callRefPath: callRef.path, leadRefPath: refPath(call.leadRef), durationSeconds: call.durationSeconds || 0, nextActionRefPath: refPath(call.savedNextActionRef) };
    if (call.status !== 'in_progress') throw new HttpsError('failed-precondition', 'This call is not in progress.');
    const [leadSnap, completed, rescheduled, contactSnap, queueSnap] = await Promise.all([
      tx.get(call.leadRef), completeRef ? tx.get(completeRef) : null,
      step?.mode === 'reschedule' ? tx.get(nextRef) : null, call.contactRef ? tx.get(call.contactRef) : null, queueRef ? tx.get(queueRef) : null,
    ]);
    if (!leadSnap.exists || !visible(ctx.uid, ctx.actor.userData, leadSnap.data())) throw new HttpsError('permission-denied', 'Lead access is no longer available.');
    const lead = leadSnap.data();
    if (queueSnap?.exists && (queueSnap.data().uid !== ctx.uid || !queueSnap.data().paths.includes(call.leadRef.path))) throw new HttpsError('permission-denied', 'This call does not belong to your queue.');
    if (step && (lead.archived === true || lead.status !== 'active')) throw new HttpsError('failed-precondition', 'Reopen the Lead before adding a next step.');
    for (const action of [completed, rescheduled].filter(Boolean)) {
      if (!action.exists || refPath(action.data().leadRef) !== call.leadRef.path || !visible(ctx.uid, ctx.actor.userData, action.data())) throw new HttpsError('permission-denied', 'The action must belong to this Lead and be accessible.');
      if (action.data().status !== 'open' || clean(action.data().actionType).toLowerCase() === 'meeting') throw new HttpsError('failed-precondition', 'Choose an open non-meeting action. Meetings use their own workflow.');
    }
    const dueAt = step ? futureTime(step.dueAt) : null;
    const dueDateKey = dueAt ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Edmonton', year: 'numeric', month: '2-digit', day: '2-digit' }).format(dueAt.toDate()) : '';
    const finished = admin.firestore.Timestamp.now();
    const ended = call.callEndedAt || finished;
    const durationSeconds = Math.max(0, Math.round(((ms(ended) || ms(finished)) - (ms(call.callStartedAt) || ms(finished))) / 1000));
    const cancelled = outcome === 'not_placed';
    const fields = { ...contextFields({ ref: call.leadRef, data: lead }, null),
      personRef: call.personRef || null, personName: clean(call.personName), contactRef: call.contactRef || null,
      contactRecordType: clean(call.contactRecordType), contactName: clean(call.contactName), dialedPhone: clean(call.dialedPhone),
      createdByRef: ctx.actor.userRef, createdByUid: ctx.uid, createdByName: name(ctx) };
    tx.update(callRef, { status: cancelled ? 'cancelled' : 'completed', outcome, disposition, notes, callFinishedAt: finished,
      durationSeconds: cancelled ? 0 : durationSeconds, durationSource: cancelled ? 'not_placed' : (call.callEndedAt ? 'rep_marked_end' : 'elapsed_until_save'),
      savedNextActionRef: nextRef || null, completedActionRef: completeRef || null, updatedAt: finished, completedByRef: ctx.actor.userRef });
    tx.set(ctx.db.doc(`commandConnections/lead_call_finished_${callRef.id}`), { ...fields,
      createdByRef: call.createdByRef || ctx.actor.userRef, createdByUid: call.createdByUid || ctx.uid, createdByName: clean(call.createdByName) || name(ctx),
      type: cancelled ? 'call_cancelled' : 'call_finished', summary: `Call ${outcome.replaceAll('_', ' ')}: ${fields.leadName}`,
      body: notes, details: { outcome, disposition, notes, durationSeconds: cancelled ? 0 : durationSeconds, hasExplicitStart: true,
        startedAt: call.callStartedAt, finishedAt: ended, durationSource: call.callEndedAt ? 'rep_marked_end' : 'elapsed_until_save' },
      sourceRef: callRef, callRef, createdAt: finished });
    const update = {};
    if (!cancelled) {
      Object.assign(update, { lastCallAt: finished, lastCallOutcome: outcome, lastCallRepUid: call.createdByUid,
        callAttemptCount: admin.firestore.FieldValue.increment(1), lastActivityAt: finished, lastActivityType: 'call_finished', lastActivityOutcome: outcome, updatedAt: finished, updatedByRef: ctx.actor.userRef });
      if (outcome === 'connected') update.lastMeaningfulConnectionAt = finished;
      if (lead.stage === 'New' && ['connected', 'voicemail'].includes(outcome)) {
        Object.assign(update, { stage: 'Opened', openedAt: finished, stageEnteredAt: finished });
        tx.set(ctx.db.doc(`commandConnections/lead_stage_from_call_${callRef.id}`), { ...fields, type: 'lead_stage_changed', summary: `${fields.leadName} moved to Opened`, body: '', details: { previousStage: 'New', stage: 'Opened', reason: 'call_outcome' }, sourceRef: callRef, callRef, createdAt: finished });
      }
    }
    // Only flag the number that was actually dialed; never overwrite a newly corrected number.
    if (contactSnap?.exists && clean(contactSnap.data().phone) === clean(call.dialedPhone) && visible(ctx.uid, ctx.actor.userData, contactSnap.data())) {
      if (outcome === 'wrong_number' && !restricted(contactSnap.data())) tx.update(contactSnap.ref, { phoneStatus: 'wrong_number', phoneStatusUpdatedAt: finished, updatedAt: finished, updatedByRef: ctx.actor.userRef });
    }
    if (disposition === 'do_not_call') Object.assign(update, { doNotCall: true, phoneStatus: 'do_not_call' });
    if (completeRef) {
      tx.update(completeRef, { status: 'completed', completionNotes: notes, completedAt: finished, completedByRef: ctx.actor.userRef, updatedAt: finished, completionFollowUpRefPath: nextRef?.path || '' });
      tx.set(ctx.db.doc(`commandConnections/action_completed_${completeRef.id}`), { ...fields, type: 'action_completed', summary: `Completed Action: ${clean(completed.data().title)}`, body: notes, actionRef: completeRef, sourceRef: completeRef, details: { followUpRefPath: nextRef?.path || '' }, createdAt: finished });
      if (refPath(lead.nextActionRef) === completeRef.path) Object.assign(update, { nextActionRef: admin.firestore.FieldValue.delete(), nextActionTitle: '', nextActionType: '', nextActionAt: admin.firestore.FieldValue.delete() });
    }
    if (nextRef) {
      if (step.mode === 'reschedule') tx.update(nextRef, { title: clean(step.title), dueAt, dueDateKey, updatedAt: finished, updatedByRef: ctx.actor.userRef });
      else tx.create(nextRef, { title: clean(step.title), description: notes, actionType: 'Follow-up', priority: 'Medium', status: 'open', dueAt, dueDateKey,
        relatedType: call.personRef ? 'Person' : (call.organizationRef ? 'Organization' : 'General'), ...fields,
        assignedToRef: ctx.actor.userRef, assignedToUid: ctx.uid, assignedToName: name(ctx),
        viewerUids: [...new Set([...(lead.viewerUids || []), ctx.uid])], sourceCallRef: callRef, createdAt: finished, updatedAt: finished });
      if (step.mode === 'create' || refPath(lead.nextActionRef) === nextRef.path) Object.assign(update, { nextActionRef: nextRef, nextActionTitle: clean(step.title), nextActionType: step.mode === 'create' ? 'Follow-up' : clean(rescheduled.data().actionType), nextActionAt: dueAt });
      if (step.mode === 'reschedule') tx.set(ctx.db.doc(`commandConnections/call_reschedule_${callRef.id}`), { ...fields, type: 'action_updated', summary: `Rescheduled: ${clean(step.title)}`, body: notes, actionRef: nextRef, sourceRef: nextRef, createdAt: finished });
    }
    if (queueSnap?.exists && !cancelled) tx.update(queueRef, { progress: { ...(queueSnap.data().progress || {}), [call.leadRef.path]: 'worked' }, revision: (Number(queueSnap.data().revision) || 0) + 1 });
    if (Object.keys(update).length) tx.update(call.leadRef, update);
    return { ok: true, duplicate: false, callRefPath: callRef.path, leadRefPath: call.leadRef.path, durationSeconds: cancelled ? 0 : durationSeconds, nextActionRefPath: nextRef?.path || '' };
  });
}
async function markEndedService(request, deps = {}) {
  const ctx = await (deps.context || commandActorContext)(request);
  const ref = ctx.db.doc(documentPath(ctx.input.callRefPath, 'commandCalls'));
  return ctx.db.runTransaction(async tx => {
    const snap = await tx.get(ref); if (!snap.exists) throw new HttpsError('not-found', 'Call not found.');
    const call = snap.data(); ownerCanFinish(ctx, call);
    if (call.status !== 'in_progress' || call.callEndedAt) return { ok: true, duplicate: true };
    tx.update(ref, { callEndedAt: admin.firestore.Timestamp.now(), durationSource: 'rep_marked_end' });
    return { ok: true, duplicate: false };
  });
}
exports.startService = startService;
exports.finishService = finishService;
exports.markEndedService = markEndedService;
exports.markCommandLeadCallEnded = onCall({ region: 'us-central1', cors: true }, markEndedService);
exports._test = { validateFinish, contextFields, ownerCanFinish };

