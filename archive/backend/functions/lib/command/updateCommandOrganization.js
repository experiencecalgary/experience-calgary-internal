'use strict';

const admin = require('firebase-admin');
const { assignmentActor, assertRecordAssignment, assignmentEvent } = require('./commandRecordAssignment');
const { isPlatformAdminUser } = require('./commandPersonUtils');
const { HttpsError } = require('firebase-functions/v2/https');
const {
  ORGANIZATIONS_COLLECTION,
  sanitizeOrganizationInput,
  validateOrganizationFields,
  requireAuth,
  requireCommandAccess,
  resolveReferences,
  findDuplicateMatches,
} = require('./commandOrganizationUtils');
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

function canUpdateOrganization(uid, repId, data = {}) {
  return data.ownerUid === uid ||
    (Array.isArray(data.viewerUids) && data.viewerUids.includes(uid)) ||
    (repId && Array.isArray(data.teamRepIds) &&
      data.teamRepIds.map(String).includes(repId));
}

async function updateCommandOrganizationService(request) {
  const db = admin.firestore();
  const uid = requireAuth(request);
  const { userRef, userData } = await requireCommandAccess(db, uid);
  const repId = userData.repId === null || userData.repId === undefined
    ? ''
    : String(userData.repId).trim();

  const organizationId = typeof request.data?.organizationId === 'string'
    ? request.data.organizationId.trim()
    : '';
  if (!organizationId || organizationId.includes('/')) {
    throw new HttpsError('invalid-argument', 'A valid organizationId is required.');
  }

  const organizationRef = db.collection(ORGANIZATIONS_COLLECTION).doc(organizationId);
  const existingSnap = await organizationRef.get();
  if (!existingSnap.exists) throw new HttpsError('not-found', 'The organization does not exist.');
  const existing = existingSnap.data() || {};
  const assignmentRequested = request.data?.assignedToRefPath !== undefined || request.data?.assignedToRef !== undefined;
  const authority = assignmentRequested ? await assignmentActor(db, uid, userData) : null;
  if (!assignmentRequested && !isPlatformAdminUser(userData) && !canUpdateOrganization(uid, repId, existing)) {
    throw new HttpsError('permission-denied', 'You do not have access to update this organization.');
  }

  const assignedInput = request.data?.assignedToRefPath !== undefined
    ? request.data.assignedToRefPath
    : request.data?.assignedToRef;
  const primaryContactInput = request.data?.primaryContactRefPath !== undefined
    ? request.data.primaryContactRefPath
    : request.data?.primaryContactRef;

  const mergedInput = {
    organization: request.data?.organization !== undefined ? request.data.organization : existing.organization,
    website: request.data?.website !== undefined ? request.data.website : existing.website,
    email: request.data?.email !== undefined ? request.data.email : existing.email,
    phone: request.data?.phone !== undefined ? request.data.phone : existing.phone,
    industry: request.data?.industry !== undefined ? request.data.industry : existing.industry,
    stage: request.data?.stage !== undefined ? request.data.stage : existing.stage,
    estimatedValue: request.data?.estimatedValue !== undefined ? request.data.estimatedValue : existing.estimatedValue,
    address: request.data?.address !== undefined ? request.data.address : existing.address,
    city: request.data?.city !== undefined ? request.data.city : existing.city,
    province: request.data?.province !== undefined ? request.data.province : existing.province,
    postalCode: request.data?.postalCode !== undefined ? request.data.postalCode : existing.postalCode,
    ownerRefPath: existing.ownerRef?.path || userRef.path,
    assignedToRefPath: assignedInput !== undefined
      ? referencePath(assignedInput) || existing.ownerRef?.path || userRef.path
      : existing.assignedToRef?.path || existing.ownerRef?.path || userRef.path,
    primaryContactRefPath: primaryContactInput !== undefined
      ? referencePath(primaryContactInput)
      : existing.primaryContactRef?.path,
  };

  const organization = sanitizeOrganizationInput(mergedInput);
  const additionalEmails = normalizeAdditionalEmails(
    request.data?.additionalEmails !== undefined
      ? request.data.additionalEmails
      : existing.additionalEmailsNormalized || existing.additionalEmails || [],
    organization.emailNormalized
  );
  const errors = validateOrganizationFields(organization);
  if (Object.keys(errors).length > 0) {
    throw new HttpsError('invalid-argument', 'Organization information is invalid.', { errors });
  }

  const references = await resolveReferences(
    db,
    organization,
    existing.ownerRef || userRef,
    existing.assignedToRef || existing.ownerRef || userRef,
    existing.primaryContactRef || null
  );
  if (assignmentRequested) await assertRecordAssignment(db, authority, existing, references.assignedToRef);
  const access = await buildCommandAccessMetadata(db, {
    actorRef: userRef,
    ownerRef: references.ownerRef,
    assignedToRef: references.assignedToRef,
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

  const matches = await findDuplicateMatches(db, organization, organizationId);
  if (matches.length > 0) {
    throw new HttpsError(
      'already-exists',
      'Another organization already uses this name, email address, or phone number.',
      { matches }
    );
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  const nextEmails = [organization.emailNormalized, ...additionalEmails].filter(Boolean);
  const updates = {
    organization: organization.organization,
    organizationNormalized: organization.organizationNormalized,
    website: organization.website,
    phone: organization.phone,
    email: organization.email,
    emailNormalized: organization.emailNormalized,
    additionalEmails,
    additionalEmailsNormalized: additionalEmails,
    phoneNormalized: organization.phoneNormalized,
    industry: organization.industry,
    stage: organization.stage,
    estimatedValue: organization.estimatedValue,
    ownerRef: access.ownerRef,
    ownerUid: access.ownerUid,
    ownerName: access.ownerName || references.ownerName,
    assignedToRef: access.assignedToRef,
    assignedToUid: access.assignedToUid,
    assignedToName: access.assignedToName || references.assignedToName,
    teamRepIds: access.teamRepIds,
    viewerUids: access.viewerUids,
    updatedAt: now,
    updatedByRef: userRef,
    ...(request.data?.leadListId === undefined ? {} : leadList ? { leadListId: leadList.ref.id, leadListName: leadList.data.name || '' } : { leadListId: admin.firestore.FieldValue.delete(), leadListName: admin.firestore.FieldValue.delete() }),
    primaryContactRef: references.primaryContactRef,
    primaryContactName: references.primaryContactName,
    address: organization.address,
    city: organization.city,
    province: organization.province,
    postalCode: organization.postalCode,
  };

  for (const key of ['notes']) {
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
    const currentSnapshot = await transaction.get(organizationRef);
    if (!currentSnapshot.exists) {
      throw new HttpsError('not-found', 'The organization does not exist.');
    }
    const current = currentSnapshot.data() || {};
    if (currentSnapshot.updateTime && existingSnap.updateTime && !currentSnapshot.updateTime.isEqual(existingSnap.updateTime)) throw new HttpsError('aborted', 'This record changed while saving. Reload before retrying.');
    if (request.data?.expectedUpdatedAt && current.updatedAt?.toDate?.().toISOString() !== request.data.expectedUpdatedAt) throw new HttpsError('aborted', 'This record changed. Reload before saving your edits.');
    if (request.data?.phone !== undefined && current.phoneStatus === 'wrong_number' && current.doNotCall !== true && current.phone !== updates.phone) updates.phoneStatus = '';
    if (assignmentRequested) await assertRecordAssignment(db, authority, current, references.assignedToRef, ref => transaction.get(ref));
    if (!assignmentRequested && !isPlatformAdminUser(userData) && !canUpdateOrganization(uid, repId, current)) {
      throw new HttpsError(
        'permission-denied',
        'You no longer have access to update this organization.'
      );
    }

    if (references.primaryContactRef) {
      const personSnapshot = await transaction.get(references.primaryContactRef);
      const person = personSnapshot.exists ? personSnapshot.data() || {} : null;
      if (
        !person ||
        person.archived === true ||
        !sameRef(person.organizationRef, organizationRef)
      ) {
        throw new HttpsError(
          'failed-precondition',
          'The primary contact must be an active person connected to this organization.'
        );
      }
    }

    await syncEmailIdentityClaims(transaction, db, {
      recordType: 'organization',
      recordRef: organizationRef,
      emails: nextEmails,
      previousEmails: recordEmails(current),
      actorRef: userRef,
      timestamp: now,
    });
    transaction.update(organizationRef, updates);
    if (assignmentRequested && current.assignedToUid !== updates.assignedToUid) {
      transaction.create(db.collection('commandConnections').doc(), assignmentEvent(userRef, organizationRef, current, { ...current, ...updates }, admin.firestore.FieldValue.serverTimestamp()));
    }
  });

  return {
    ok: true,
    updated: true,
    organizationId,
    organizationPath: organizationRef.path,
  };
}

module.exports = { updateCommandOrganizationService };


