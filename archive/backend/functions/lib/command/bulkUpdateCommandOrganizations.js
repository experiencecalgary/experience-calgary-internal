'use strict';

const admin = require('firebase-admin');
const { assignmentActor, assertRecordAssignment, assignmentEvent } = require('./commandRecordAssignment');

const { HttpsError } = require('firebase-functions/v2/https');
const {
  ALLOWED_STAGES,
  requireAuth,
  requireCommandAccess,
} = require('./commandPersonUtils');
const { buildCommandAccessMetadata } = require('./commandAccessMetadata');

const ORGANIZATIONS_COLLECTION = 'commandOrganizations';
const ALLOWED_OPERATIONS = new Set(['assign', 'change_stage', 'archive', 'update_estimated_value']);
const MAX_RECORDS = 100;

function validateOrganizationRefPaths(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpsError('invalid-argument', 'organizationRefPaths must contain at least one organization reference path.');
  }
  const uniquePaths = [...new Set(value.map((path) => typeof path === 'string' ? path.trim() : ''))];
  if (uniquePaths.some((path) => {
    const parts = path.split('/').filter(Boolean);
    return parts.length !== 2 || parts[0] !== ORGANIZATIONS_COLLECTION;
  })) {
    throw new HttpsError('invalid-argument', 'Every organization reference must use commandOrganizations/{documentId}.');
  }
  if (uniquePaths.length > MAX_RECORDS) {
    throw new HttpsError('invalid-argument', `A maximum of ${MAX_RECORDS} organizations can be updated at once.`);
  }
  return uniquePaths;
}

function canUpdateOrganization(data, uid, actorRepId) {
  return data.ownerUid === uid ||
    (Array.isArray(data.viewerUids) && data.viewerUids.includes(uid)) ||
    (actorRepId && Array.isArray(data.teamRepIds) && data.teamRepIds.includes(actorRepId));
}

async function resolveAssignedUser(db, path) {
  const assignedPath = typeof path === 'string' ? path.trim() : '';
  const parts = assignedPath.split('/').filter(Boolean);
  if (parts.length !== 2 || parts[0] !== 'users') {
    throw new HttpsError('invalid-argument', 'assignedToRefPath must use users/{documentId}.');
  }
  const ref = db.doc(parts.join('/'));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('invalid-argument', 'The selected assigned representative does not exist.');
  const user = snap.data() || {};
  if (user.active === false) throw new HttpsError('failed-precondition', 'The selected assigned user is inactive.');
  if (!String(user.repId ?? '').trim()) {
    throw new HttpsError('failed-precondition', 'The selected assigned user does not have a valid rep ID.');
  }
  return ref;
}

async function bulkUpdateCommandOrganizationsService(request) {
  const db = admin.firestore();
  const uid = requireAuth(request);
  const { userRef, userData } = await requireCommandAccess(db, uid);
  const operation = typeof request.data?.operation === 'string' ? request.data.operation.trim() : '';
  if (!ALLOWED_OPERATIONS.has(operation)) {
    throw new HttpsError('invalid-argument', 'operation must be assign, change_stage, archive, or update_estimated_value.');
  }

  const paths = validateOrganizationRefPaths(request.data?.organizationRefPaths);
  const refs = paths.map((path) => db.doc(path));
  const snapshots = await db.getAll(...refs);
  const missingPaths = snapshots.filter((snap) => !snap.exists).map((snap) => snap.ref.path);
  if (missingPaths.length) {
    throw new HttpsError('not-found', 'One or more selected organizations no longer exist.', { missingPaths });
  }

  const actorRepId = typeof userData.repId === 'string' ? userData.repId.trim() : '';
  const deniedPaths = snapshots
    .filter((snap) => operation !== 'assign' && !canUpdateOrganization(snap.data() || {}, uid, actorRepId))
    .map((snap) => snap.ref.path);
  if (deniedPaths.length) {
    throw new HttpsError('permission-denied', 'You do not have access to update every selected organization.', { deniedPaths });
  }

  let assignedToRef = null;
  let stage = '';
  let estimatedValue;
  if (operation === 'assign') assignedToRef = await resolveAssignedUser(db, request.data?.assignedToRefPath);
  if (operation === 'change_stage') {
    stage = typeof request.data?.stage === 'string' ? request.data.stage.trim() : '';
    if (!ALLOWED_STAGES.has(stage)) {
      throw new HttpsError('invalid-argument', `Stage must be one of: ${Array.from(ALLOWED_STAGES).join(', ')}.`);
    }
  }

  if (operation === 'update_estimated_value') {
    const rawValue = request.data?.estimatedValue;
    if (rawValue === null || rawValue === '') {
      estimatedValue = null;
    } else {
      estimatedValue = Number(rawValue);
      if (!Number.isFinite(estimatedValue) || estimatedValue < 0) {
        throw new HttpsError(
          'invalid-argument',
          'Estimated value must be a positive number or zero.'
        );
      }
    }
  }

  if (operation === 'assign') {
    const authority = await assignmentActor(db, uid, userData);
    for (const snap of snapshots) await assertRecordAssignment(db, authority, snap.data() || {}, assignedToRef);
  }

  const accessByPath = new Map();
  if (operation === 'assign') {
    for (const snap of snapshots) {
      const current = snap.data() || {};
      const access = await buildCommandAccessMetadata(db, {
        actorRef: userRef,
        ownerRef: current.ownerRef || userRef,
        assignedToRef,
      });
      accessByPath.set(snap.ref.path, access);
    }
  }

  const batch = db.batch();
  const now = admin.firestore.FieldValue.serverTimestamp();
  let updatedCount = 0;
  let unchangedCount = 0;

  for (const snap of snapshots) {
    const current = snap.data() || {};
    let updates;
    if (operation === 'assign') {
      const access = accessByPath.get(snap.ref.path);
      updates = {
        ownerRef: access.ownerRef,
        ownerUid: access.ownerUid,
        ownerName: access.ownerName,
        assignedToRef: access.assignedToRef,
        assignedToUid: access.assignedToUid,
        assignedToName: access.assignedToName,
        teamRepIds: access.teamRepIds,
        viewerUids: access.viewerUids,
        accessUpdatedAt: now,
        updatedAt: now,
        updatedByRef: userRef,
      };
    } else if (operation === 'change_stage') {
      if (current.stage === stage) { unchangedCount += 1; continue; }
      updates = { stage, updatedAt: now, updatedByRef: userRef };
    } else if (operation === 'update_estimated_value') {
      const currentValue = Number.isFinite(Number(current.estimatedValue))
        ? Number(current.estimatedValue)
        : null;
      if (currentValue === estimatedValue) { unchangedCount += 1; continue; }
      updates = {
        estimatedValue: estimatedValue === null
          ? admin.firestore.FieldValue.delete()
          : estimatedValue,
        updatedAt: now,
        updatedByRef: userRef,
      };
    } else {
      if (current.archived === true) { unchangedCount += 1; continue; }
      updates = {
        archived: true,
        archivedAt: now,
        archivedByRef: userRef,
        restoredAt: admin.firestore.FieldValue.delete(),
        restoredByRef: admin.firestore.FieldValue.delete(),
        updatedAt: now,
        updatedByRef: userRef,
      };
    }
    if (operation === 'assign') {
      batch.update(snap.ref, updates, { lastUpdateTime: snap.updateTime });
    } else {
      batch.update(snap.ref, updates);
    }
    if (operation === 'assign' && current.assignedToUid !== updates.assignedToUid) {
      batch.create(db.collection('commandConnections').doc(), assignmentEvent(userRef, snap.ref, current, { ...current, ...updates }, now));
    }
    updatedCount += 1;
  }

  if (updatedCount > 0) await batch.commit();
  return {
    ok: true,
    operation,
    requestedCount: paths.length,
    updatedCount,
    unchangedCount,
    organizationPaths: paths,
  };
}

module.exports = { bulkUpdateCommandOrganizationsService };

