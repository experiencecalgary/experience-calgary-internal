'use strict';

const admin = require('firebase-admin');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { requireAuth, requireCommandAccess, isPlatformAdminUser } = require('../../lib/command/commandPersonUtils');
const { buildCommandAccessMetadata } = require('../../lib/command/commandAccessMetadata');
const { canAssignCommandAction } = require('../../lib/command/commandActionAssignment');

const COLLECTION = 'commandActions';
const allowedPriorities = new Set(['Low', 'Medium', 'High']);
const allowedRelatedTypes = new Set(['Person', 'Organization', 'General']);
const callable = (handler) => onCall({ region: 'us-central1', cors: true, timeoutSeconds: 120, memory: '512MiB' }, handler);
const clean = (v) => typeof v === 'string' ? v.trim() : '';
const choice = (v, values) => [...values].find(x => x.toLowerCase() === clean(v).toLowerCase()) || '';
const actorName = actor => clean(actor?.userData?.fullName) ||
  [clean(actor?.userData?.firstName), clean(actor?.userData?.lastName)].filter(Boolean).join(' ') ||
  clean(actor?.userData?.displayName) || clean(actor?.userData?.name) ||
  clean(actor?.userData?.email) || 'Experience Command';

function path(value, collection, name, required = false) {
  const raw = clean(value);
  if (!raw && !required) return '';
  const parts = raw.split('/').filter(Boolean);
  if (parts.length !== 2 || parts[0] !== collection) throw new HttpsError('invalid-argument', `${name} must use ${collection}/{documentId}.`);
  return parts.join('/');
}

function timestamp(value, name) {
  if (value instanceof admin.firestore.Timestamp) return value;
  if (value && Number.isFinite(value.seconds)) return new admin.firestore.Timestamp(value.seconds, Number(value.nanoseconds) || 0);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new HttpsError('invalid-argument', `${name} must be a valid date and time.`);
  return admin.firestore.Timestamp.fromDate(date);
}

function dateKey(value) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Edmonton', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(value.toDate()).filter(x => x.type !== 'literal');
  const map = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function visible(uid, data, actorData) {
  if (isPlatformAdminUser(actorData)) return true;
  return data.ownerUid === uid || data.assignedToUid === uid || (Array.isArray(data.viewerUids) && data.viewerUids.includes(uid));
}

async function context(request) {
  const db = admin.firestore();
  const uid = requireAuth(request);
  const actor = await requireCommandAccess(db, uid);
  return { db, uid, actor, input: request.data || {} };
}

async function action(ctx) {
  const ref = ctx.db.doc(path(ctx.input.actionRefPath, COLLECTION, 'actionRefPath', true));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Action not found.');
  const data = snap.data() || {};
  if (!visible(ctx.uid, data, ctx.actor.userData)) throw new HttpsError('permission-denied', 'You do not have access to this Action.');
  if (clean(data.actionType).toLowerCase() === 'meeting') throw new HttpsError('failed-precondition', 'Meetings must use the dedicated meeting lifecycle.');
  return { ref, data };
}

async function assignee(ctx, rawPath) {
  const ref = ctx.db.doc(path(rawPath, 'users', 'assignedToRefPath', true));
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.active === false || snap.data()?.userType !== 'rep') throw new HttpsError('failed-precondition', 'The assignee must be an active representative.');
  if (!canAssignCommandAction({ actorUid: ctx.uid, actorData: ctx.actor.userData, assigneeUid: ref.id, assigneeData: snap.data() })) throw new HttpsError('permission-denied', 'You can assign only to yourself or an active representative on your team.');
  return { ref, data: snap.data() };
}

async function connection(ctx, type, target, summary, details = {}) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  const personName = clean(target.data.personName);
  const organizationName = clean(target.data.organizationName);
  await ctx.db.collection('commandConnections').add({
    type, summary, body: clean(details.notes || details.reason), details,
    actionRef: target.ref, sourceRef: target.ref,
    ...(target.data.leadRef ? { leadRef: target.data.leadRef } : {}),
    personRef: target.data.personRef || null, personName,
    organizationRef: target.data.organizationRef || null, organizationName,
    recordType: target.data.personRef ? 'person' : (target.data.organizationRef ? 'organization' : 'general'),
    recordName: personName || organizationName || clean(target.data.title),
    ownerRef: target.data.ownerRef || ctx.actor.userRef,
    ownerUid: target.data.ownerUid || ctx.uid, ownerName: clean(target.data.ownerName),
    teamRepIds: target.data.teamRepIds || [], viewerUids: target.data.viewerUids || [ctx.uid],
    createdAt: now, createdByRef: ctx.actor.userRef, createdByUid: ctx.uid,
    createdByName: actorName(ctx.actor),
  });
}

async function syncLeadNextAction(ctx, target) {
  if (!target.data.leadRef) return;
  // A trigger may already have reconciled this action, or another action may
  // have changed while the callable was running. Always read current work.
  await require('../../lib/command/commandLeadWorkspace').refreshNextAction(ctx.db, target.data.leadRef);
}

async function updateService(request, deps = {}) {
  const ctx = deps.context ? await deps.context(request) : await context(request); const target = await action(ctx);
  if (target.data.status !== 'open') throw new HttpsError('failed-precondition', 'Only open Actions can be edited.');
  const updates = {}; const changed = [];
  for (const key of ['title', 'description', 'actionType']) if (Object.hasOwn(ctx.input, key)) { const value = clean(ctx.input[key]); if (!value) throw new HttpsError('invalid-argument', `${key} cannot be empty.`); if (key === 'actionType' && value.toLowerCase() === 'meeting') throw new HttpsError('failed-precondition', 'Use createCommandMeeting to create a Meeting.'); updates[key] = value; changed.push(key); }
  if (Object.hasOwn(ctx.input, 'priority')) { const value = choice(ctx.input.priority, allowedPriorities); if (!value) throw new HttpsError('invalid-argument', 'Priority must be Low, Medium, or High.'); updates.priority = value; changed.push('priority'); }
  if (Object.hasOwn(ctx.input, 'dueAt')) { updates.dueAt = timestamp(ctx.input.dueAt, 'dueAt'); updates.dueDateKey = dateKey(updates.dueAt); changed.push('dueAt'); }
  if (Object.hasOwn(ctx.input, 'assignedToRefPath')) { const selected = await assignee(ctx, ctx.input.assignedToRefPath); const access = await buildCommandAccessMetadata(ctx.db, { actorRef: ctx.actor.userRef, ownerRef: target.data.ownerRef || ctx.actor.userRef, assignedToRef: selected.ref }); Object.assign(updates, access); changed.push('assignedTo'); }
  if (!changed.length) throw new HttpsError('invalid-argument', 'No editable Action fields were supplied.');
  updates.updatedAt = admin.firestore.FieldValue.serverTimestamp(); updates.updatedByRef = ctx.actor.userRef;
  await target.ref.update(updates);
  await syncLeadNextAction(ctx, target);
  await connection(ctx, 'action_updated', target, `Updated Action: ${updates.title || target.data.title}`, { changedFields: changed });
  return { ok: true, result: 'success', actionRefPath: target.ref.path, changedFields: changed };
}

async function createFollowUp(ctx, target) {
  if (!ctx.input.createFollowUp) return '';
  const dueAt = timestamp(ctx.input.followUpDueAt, 'followUpDueAt');
  const ref = ctx.db.collection(COLLECTION).doc(); const now = admin.firestore.FieldValue.serverTimestamp();
  await ref.create({ title: clean(ctx.input.followUpTitle) || `Follow up: ${clean(target.data.title)}`, description: '', actionType: clean(ctx.input.followUpType) || 'Follow-up', priority: 'Medium', status: 'open', dueAt, dueDateKey: dateKey(dueAt), relatedType: target.data.relatedType || 'General', personRef: target.data.personRef || null, personName: target.data.personName || '', organizationRef: target.data.organizationRef || null, organizationName: target.data.organizationName || '', ...(target.data.leadRef ? { leadRef: target.data.leadRef } : {}), ownerRef: target.data.ownerRef, ownerUid: target.data.ownerUid, ownerName: target.data.ownerName || '', assignedToRef: target.data.assignedToRef, assignedToUid: target.data.assignedToUid, assignedToName: target.data.assignedToName || '', teamRepIds: target.data.teamRepIds || [], viewerUids: target.data.viewerUids || [], createdAt: now, updatedAt: now, createdByRef: ctx.actor.userRef, createdByUid: ctx.uid, createdByName: actorName(ctx.actor), updatedByRef: ctx.actor.userRef, sourceActionRef: target.ref });
  return ref.path;
}

async function completeService(request, deps = {}) {
  const ctx = deps.context ? await deps.context(request) : await context(request);
  const actionRef = ctx.db.doc(path(ctx.input.actionRefPath, COLLECTION, 'actionRefPath', true));
  const completionRef = ctx.db.collection('commandConnections').doc(`action_completed_${actionRef.id}`);
  const followUpRef = ctx.input.createFollowUp
    ? ctx.db.collection(COLLECTION).doc(`completion_followup_${actionRef.id}`)
    : null;
  const followUpDueAt = followUpRef
    ? timestamp(ctx.input.followUpDueAt, 'followUpDueAt')
    : null;

  const result = await ctx.db.runTransaction(async (transaction) => {
    const snap = await transaction.get(actionRef);
    if (!snap.exists) throw new HttpsError('not-found', 'Action not found.');
    const data = snap.data() || {};
    if (!visible(ctx.uid, data, ctx.actor.userData)) {
      throw new HttpsError('permission-denied', 'You do not have access to this Action.');
    }
    if (clean(data.actionType).toLowerCase() === 'meeting') {
      throw new HttpsError('failed-precondition', 'Meetings must use the dedicated meeting lifecycle.');
    }
    if (data.status === 'completed') {
      return {
        actionRefPath: actionRef.path,
        followUpRefPath: clean(data.completionFollowUpRefPath),
        duplicate: true,
      };
    }
    if (data.status !== 'open') {
      throw new HttpsError('failed-precondition', 'Only open Actions can be completed.');
    }

    const leadSnap = data.leadRef ? await transaction.get(data.leadRef) : null;

    const now = deps.serverTimestamp ? deps.serverTimestamp() : admin.firestore.FieldValue.serverTimestamp();
    let followUpRefPath = '';
    if (followUpRef) {
      followUpRefPath = followUpRef.path;
      transaction.set(followUpRef, {
        title: clean(ctx.input.followUpTitle) || `Follow up: ${clean(data.title)}`,
        description: '',
        actionType: clean(ctx.input.followUpType) || 'Follow-up',
        priority: 'Medium',
        status: 'open',
        dueAt: followUpDueAt,
        dueDateKey: dateKey(followUpDueAt),
        relatedType: data.relatedType || 'General',
        personRef: data.personRef || null,
        personName: data.personName || '',
        organizationRef: data.organizationRef || null,
        organizationName: data.organizationName || '',
        ...(data.leadRef ? { leadRef: data.leadRef } : {}),
        ownerRef: data.ownerRef,
        ownerUid: data.ownerUid,
        ownerName: data.ownerName || '',
        assignedToRef: data.assignedToRef,
        assignedToUid: data.assignedToUid,
        assignedToName: data.assignedToName || '',
        teamRepIds: data.teamRepIds || [],
        viewerUids: data.viewerUids || [],
        createdAt: now,
        updatedAt: now,
        createdByRef: ctx.actor.userRef,
        createdByUid: ctx.uid,
        createdByName: actorName(ctx.actor),
        updatedByRef: ctx.actor.userRef,
        sourceActionRef: actionRef,
      }, { merge: false });
    }

    transaction.update(actionRef, {
      status: 'completed',
      completionNotes: clean(ctx.input.completionNotes),
      completionFollowUpRefPath: followUpRefPath,
      completedAt: now,
      completedByRef: ctx.actor.userRef,
      updatedAt: now,
      updatedByRef: ctx.actor.userRef,
    });
    transaction.set(completionRef, {
      type: 'action_completed',
      summary: `Completed Action: ${clean(data.title)}`,
      body: '',
      details: { followUpRefPath },
      actionRef,
      sourceRef: actionRef,
      ...(data.leadRef ? { leadRef: data.leadRef } : {}),
      personRef: data.personRef || null,
      personName: clean(data.personName),
      organizationRef: data.organizationRef || null,
      organizationName: clean(data.organizationName),
      recordType: data.personRef ? 'person' : (data.organizationRef ? 'organization' : 'general'),
      recordName: clean(data.personName) || clean(data.organizationName) || clean(data.title),
      ownerRef: data.ownerRef || ctx.actor.userRef,
      ownerUid: data.ownerUid || ctx.uid,
      ownerName: clean(data.ownerName),
      teamRepIds: data.teamRepIds || [],
      viewerUids: data.viewerUids || [ctx.uid],
      createdAt: now,
      createdByRef: ctx.actor.userRef,
      createdByUid: ctx.uid,
      createdByName: actorName(ctx.actor),
      deduplicationKey: `action_completed:${actionRef.id}`,
    }, { merge: false });

    if (data.leadRef && leadSnap?.exists) {
      if (followUpRef) transaction.update(data.leadRef, { nextActionRef: followUpRef, nextActionTitle: clean(ctx.input.followUpTitle) || `Follow up: ${clean(data.title)}`, nextActionType: clean(ctx.input.followUpType) || 'Follow-up', nextActionAt: followUpDueAt, updatedAt: now, updatedByRef: ctx.actor.userRef });
      else if (leadSnap.data()?.nextActionRef?.path === actionRef.path) transaction.update(data.leadRef, { nextActionRef: admin.firestore.FieldValue.delete(), nextActionTitle: '', nextActionType: '', nextActionAt: admin.firestore.FieldValue.delete(), updatedAt: now, updatedByRef: ctx.actor.userRef });
    }

    return { actionRefPath: actionRef.path, followUpRefPath, duplicate: false };
  });

  return { ok: true, result: 'success', ...result };
}

async function cancelService(request) {
  const ctx = await context(request); const target = await action(ctx); const reason = clean(ctx.input.reason);
  if (target.data.status !== 'open') throw new HttpsError('failed-precondition', 'Only open Actions can be cancelled.');
  if (!reason) throw new HttpsError('invalid-argument', 'A cancellation reason is required.');
  const now = admin.firestore.FieldValue.serverTimestamp(); await target.ref.update({ status: 'cancelled', cancellationReason: reason, cancelledAt: now, cancelledByRef: ctx.actor.userRef, updatedAt: now, updatedByRef: ctx.actor.userRef });
  await syncLeadNextAction(ctx, target);
  await connection(ctx, 'action_cancelled', target, `Cancelled Action: ${clean(target.data.title)}`, { reason });
  return { ok: true, result: 'success', actionRefPath: target.ref.path };
}

async function archiveService(request) {
  const ctx = await context(request); const target = await action(ctx); const now = admin.firestore.FieldValue.serverTimestamp();
  await target.ref.update({ archived: true, archivedAt: now, archivedByRef: ctx.actor.userRef, updatedAt: now, updatedByRef: ctx.actor.userRef });
  await syncLeadNextAction(ctx, target);
  return { ok: true, result: 'success', actionRefPath: target.ref.path };
}

exports.updateCommandActionService = updateService;
exports.completeCommandActionService = completeService;
exports.cancelCommandActionService = cancelService;
exports.archiveCommandActionService = archiveService;
exports.updateCommandAction = callable(updateService);
exports.completeCommandAction = callable(completeService);
exports.cancelCommandAction = callable(cancelService);
exports.archiveCommandAction = callable(archiveService);

