'use strict';

const admin = require('firebase-admin');
const { assignmentActor, assertRecordAssignment, assignmentEvent } = require('./commandRecordAssignment');
const { isPlatformAdminUser } = require('./commandPersonUtils');
const { HttpsError } = require('firebase-functions/v2/https');
const {
  PEOPLE_COLLECTION,
  sanitizePersonInput,
  validatePersonFields,
  requireAuth,
  requireCommandAccess,
  resolveReferences,
  findDuplicateMatches
} = require('./commandPersonUtils');
const { buildCommandAccessMetadata } = require('./commandAccessMetadata');
const { resolveCommandLeadList } = require('./commandLeadLists');
const {
  normalizeAdditionalEmails,
  recordEmails,
  syncEmailIdentityClaims,
  sameRef,
} = require('./commandEmailIdentity');

function referencePath(value) {
  if (typeof value === 'string') return value.trim();
  return typeof value?.path === 'string' ? value.path.trim() : '';
}

function canUpdatePerson(uid, repId, data = {}) {
  return data.ownerUid === uid ||
    (Array.isArray(data.viewerUids) && data.viewerUids.includes(uid)) ||
    (repId && Array.isArray(data.teamRepIds) &&
      data.teamRepIds.map(String).includes(repId));
}

async function updateCommandPersonService(request, deps = {}) {
  const db = deps.db || admin.firestore();
  const uid = requireAuth(request);
  const { userRef, userData } = await requireCommandAccess(db, uid);
  if (userData.active === false) throw new HttpsError('permission-denied', 'Inactive representatives cannot edit contacts.');

  const personId = typeof request.data?.personId === 'string' ? request.data.personId.trim() : '';
  if (!personId || personId.includes('/')) {
    throw new HttpsError('invalid-argument', 'A valid personId is required.');
  }

  const personRef = db.collection(PEOPLE_COLLECTION).doc(personId);
  const existingSnap = await personRef.get();
  if (!existingSnap.exists) throw new HttpsError('not-found', 'The contact does not exist.');
  const existing = existingSnap.data() || {};
  const actorRepId = userData.repId === null || userData.repId === undefined
    ? ''
    : String(userData.repId).trim();
  const assignmentRequested = request.data?.assignedToRefPath !== undefined || request.data?.assignedToRef !== undefined;
  const authority = assignmentRequested ? await assignmentActor(db, uid, userData) : null;
  if (!assignmentRequested && !isPlatformAdminUser(userData) && !canUpdatePerson(uid, actorRepId, existing)) {
    throw new HttpsError('permission-denied', 'You do not have access to update this contact.');
  }

  const mergedInput = {
    firstName: request.data?.firstName !== undefined ? request.data.firstName : existing.firstName,
    lastName: request.data?.lastName !== undefined ? request.data.lastName : existing.lastName,
    email: request.data?.email !== undefined ? request.data.email : existing.email,
    phone: request.data?.phone !== undefined ? request.data.phone : existing.phone,
    organizationName: request.data?.organizationName !== undefined ? request.data.organizationName : existing.organizationName,
    stage: request.data?.stage !== undefined ? request.data.stage : existing.stage,
    ownerRefPath: existing.ownerRef?.path || userRef.path,
    organizationRefPath: request.data?.organizationRefPath !== undefined
      ? referencePath(request.data.organizationRefPath)
      : request.data?.organizationRef !== undefined
        ? referencePath(request.data.organizationRef)
        : existing.organizationRef?.path,
  };

  const person = sanitizePersonInput(mergedInput);
  const additionalEmails = normalizeAdditionalEmails(
    request.data?.additionalEmails !== undefined
      ? request.data.additionalEmails
      : existing.additionalEmailsNormalized || existing.additionalEmails || [],
    person.emailNormalized
  );
  const errors = validatePersonFields(person);
  // Unchanged legacy omissions must not block a correction to another field.
  // Supplied fields still receive normal validation, including removing the last contact method.
  const previousErrors = validatePersonFields(sanitizePersonInput(existing));
  const errorInputs = { contact: ['email', 'phone'] };
  for (const key of Object.keys(errors)) {
    const touched = (errorInputs[key] || [key]).some(field => request.data?.[field] !== undefined);
    if (!touched && previousErrors[key] === errors[key]) delete errors[key];
  }
  if (Object.keys(errors).length > 0) {
    throw new HttpsError('invalid-argument', 'Contact information is invalid.', { errors });
  }

  const { ownerRef, organizationRef } = await resolveReferences(
    db,
    person,
    existing.ownerRef || userRef
  );

  let assignedToRef = existing.assignedToRef || existing.ownerRef || userRef;
  const assignedToInput = request.data?.assignedToRefPath !== undefined
    ? request.data.assignedToRefPath
    : request.data?.assignedToRef;
  if (assignedToInput !== undefined) {
    const assignedPath = referencePath(assignedToInput);
    if (!assignedPath) {
      assignedToRef = existing.ownerRef || userRef;
    } else {
      const parts = assignedPath.split('/').filter(Boolean);
      if (parts.length !== 2 || parts[0] !== 'users') {
        throw new HttpsError('invalid-argument', 'Invalid assignedToRefPath. Expected users/{documentId}.');
      }
      const candidateRef = db.doc(parts.join('/'));
      const candidateSnap = await candidateRef.get();
      if (!candidateSnap.exists) {
        throw new HttpsError('invalid-argument', 'The selected assigned representative does not exist.');
      }
      const candidate = candidateSnap.data() || {};
      if (candidate.active === false || candidate.userType !== 'rep') {
        throw new HttpsError('failed-precondition', 'The selected assigned user must be an active Experience Calgary representative.');
      }
      assignedToRef = candidateRef;
    }
  }

  if (assignmentRequested) await assertRecordAssignment(db, authority, existing, assignedToRef);
  const access = await buildCommandAccessMetadata(db, {
    actorRef: userRef,
    ownerRef,
    assignedToRef,
  });

  let leadList = null;
  if (request.data?.leadListId !== undefined && referencePath(request.data.leadListId)) {
    leadList = await resolveCommandLeadList(
      db,
      uid,
      userData,
      referencePath(request.data.leadListId)
    );
  }

  const matches = await findDuplicateMatches(db, person, personId);
  if (matches.length > 0) {
    throw new HttpsError(
      'already-exists',
      'Another contact already uses this email address or phone number.',
      { matches }
    );
  }

  const nameChanged = request.data?.firstName !== undefined || request.data?.lastName !== undefined;
  const fullName = !nameChanged && existing.fullName ? existing.fullName : [person.firstName, person.lastName].filter(Boolean).join(' ').trim();
  const now = admin.firestore.FieldValue.serverTimestamp();
  const nextEmails = [person.emailNormalized, ...additionalEmails].filter(Boolean);
  const updates = {
    firstName: person.firstName,
    lastName: person.lastName,
    fullName,
    fullNameNormalized: fullName.toLowerCase(),
    email: person.email,
    emailNormalized: person.emailNormalized,
    additionalEmails,
    additionalEmailsNormalized: additionalEmails,
    phone: person.phone,
    phoneNormalized: person.phoneNormalized,
    organizationRef: organizationRef || null,
    ownerRef: access.ownerRef,
    ownerUid: access.ownerUid,
    ownerName: access.ownerName,
    assignedToRef: access.assignedToRef,
    assignedToUid: access.assignedToUid,
    assignedToName: access.assignedToName,
    teamRepIds: access.teamRepIds,
    viewerUids: access.viewerUids,
    stage: person.stage,
    updatedAt: now,
    updatedByRef: userRef,
    ...(request.data?.leadListId === undefined ? {} : leadList ? { leadListId: leadList.ref.id, leadListName: leadList.data.name || '' } : { leadListId: admin.firestore.FieldValue.delete(), leadListName: admin.firestore.FieldValue.delete() }),
    organizationName: person.organizationName
      ? person.organizationName
      : admin.firestore.FieldValue.delete(),
  };

  for (const key of ['position', 'notes']) {
    if (request.data?.[key] !== undefined) {
      if (typeof request.data[key] !== 'string' || request.data[key].length > (key === 'notes' ? 5000 : 200)) throw new HttpsError('invalid-argument', `${key} is invalid or too long.`);
      updates[key] = request.data[key].trim();
    }
  }

  if (request.data?.archived !== undefined) {
    if (typeof request.data.archived !== 'boolean') {
      throw new HttpsError('invalid-argument', 'archived must be a boolean when supplied.');
    }
    updates.archived = request.data.archived;
  }

  await db.runTransaction(async (transaction) => {
    const currentSnapshot = await transaction.get(personRef);
    if (!currentSnapshot.exists) throw new HttpsError('not-found', 'The contact does not exist.');
    const current = currentSnapshot.data() || {};
    if (currentSnapshot.updateTime && existingSnap.updateTime && !currentSnapshot.updateTime.isEqual(existingSnap.updateTime)) throw new HttpsError('aborted', 'This record changed while saving. Reload before retrying.');
    if (request.data?.expectedUpdatedAt && current.updatedAt?.toDate?.().toISOString() !== request.data.expectedUpdatedAt) throw new HttpsError('aborted', 'This record changed. Reload before saving your edits.');
    if (request.data?.phone !== undefined && current.phoneStatus === 'wrong_number' && current.doNotCall !== true && current.phone !== updates.phone) updates.phoneStatus = '';
    if (assignmentRequested) await assertRecordAssignment(db, authority, current, assignedToRef, ref => transaction.get(ref));
    if (!assignmentRequested && !isPlatformAdminUser(userData) && !canUpdatePerson(uid, actorRepId, current)) {
      throw new HttpsError('permission-denied', 'You no longer have access to update this contact.');
    }

    const nextOrganizationSnapshot = organizationRef
      ? await transaction.get(organizationRef)
      : null;
    if (organizationRef && !nextOrganizationSnapshot?.exists) {
      throw new HttpsError(
        'failed-precondition',
        'The selected organization no longer exists.'
      );
    }

    let previousOrganization = null;
    if (current.organizationRef && !sameRef(current.organizationRef, organizationRef)) {
      const organizationSnapshot = await transaction.get(current.organizationRef);
      previousOrganization = organizationSnapshot.exists
        ? organizationSnapshot.data() || {}
        : null;

      if (previousOrganization) {
        const nextEmailSet = new Set(nextEmails);
        const shared = recordEmails(previousOrganization).filter((email) =>
          nextEmailSet.has(email)
        );
        if (shared.length) {
          throw new HttpsError(
            'failed-precondition',
            'Remove the shared email address before moving this person to another organization.',
            { sharedEmails: shared }
          );
        }
      }
    }

    await syncEmailIdentityClaims(transaction, db, {
      recordType: 'person',
      recordRef: personRef,
      emails: nextEmails,
      previousEmails: recordEmails(current),
      relatedOrganizationRef: organizationRef,
      actorRef: userRef,
      timestamp: now,
    });

    transaction.update(personRef, updates);
    if (assignmentRequested && current.assignedToUid !== updates.assignedToUid) {
      transaction.create(db.collection('commandConnections').doc(), assignmentEvent(userRef, personRef, current, { ...current, ...updates }, admin.firestore.FieldValue.serverTimestamp()));
    }
    const nextOrganization = nextOrganizationSnapshot?.data() || {};
    if (organizationRef && !nextOrganization.primaryContactRef) {
      transaction.update(organizationRef, {
        primaryContactRef: personRef,
        primaryContactName: fullName,
        updatedAt: now,
        updatedByRef: userRef,
      });
    }
    if (
      current.organizationRef &&
      previousOrganization &&
      sameRef(previousOrganization.primaryContactRef, personRef)
    ) {
      transaction.update(current.organizationRef, {
        primaryContactRef: null,
        primaryContactName: '',
        updatedAt: now,
        updatedByRef: userRef,
      });
    }
  });

  return { ok: true, updated: true, personId, personPath: personRef.path };
}

module.exports = { updateCommandPersonService };


