'use strict';

const admin = require('firebase-admin');
const { assignmentActor, assertRecordAssignment } = require('./commandRecordAssignment');
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
  syncEmailIdentityClaims,
} = require('./commandEmailIdentity');

function referencePath(value) {
  if (typeof value === 'string') return value.trim();
  return typeof value?.path === 'string' ? value.path.trim() : '';
}

async function createCommandOrganizationService(request) {
  const db = admin.firestore();
  const uid = requireAuth(request);
  const { userRef, userData } = await requireCommandAccess(db, uid);

  const assignedInput = request.data?.assignedToRefPath !== undefined
    ? request.data.assignedToRefPath
    : request.data?.assignedToRef;
  const primaryContactInput = request.data?.primaryContactRefPath !== undefined
    ? request.data.primaryContactRefPath
    : request.data?.primaryContactRef;

  if (referencePath(primaryContactInput)) {
    throw new HttpsError(
      'failed-precondition',
      'Create the organization first, then connect the person and choose them as primary contact.'
    );
  }

  const organization = sanitizeOrganizationInput({
    ...(request.data || {}),
    ownerRefPath: '',
    assignedToRefPath: referencePath(assignedInput) || userRef.path,
    primaryContactRefPath: '',
  });
  const additionalEmails = normalizeAdditionalEmails(
    request.data?.additionalEmails || [],
    organization.emailNormalized
  );
  const errors = validateOrganizationFields(organization);
  if (Object.keys(errors).length > 0) {
    throw new HttpsError('invalid-argument', 'Organization information is invalid.', { errors });
  }

  const references = await resolveReferences(db, organization, userRef, userRef, null);
  await assertRecordAssignment(db, await assignmentActor(db, uid, userData), null, references.assignedToRef);
  const access = await buildCommandAccessMetadata(db, {
    actorRef: userRef,
    ownerRef: references.ownerRef,
    assignedToRef: references.assignedToRef,
  });
  const requestedLeadListId = referencePath(request.data?.leadListId);
  const leadList = requestedLeadListId
    ? await resolveCommandLeadList(db, uid, userData, requestedLeadListId)
    : null;

  const matches = await findDuplicateMatches(db, organization);
  if (matches.length > 0) {
    throw new HttpsError(
      'already-exists',
      'An organization already uses this name, email address, or phone number.',
      { matches }
    );
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  const organizationRef = db.collection(ORGANIZATIONS_COLLECTION).doc();
  const emails = [organization.emailNormalized, ...additionalEmails].filter(Boolean);
  const data = {
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
    archived: false,
    ...(leadList ? { leadListId: leadList.ref.id, leadListName: leadList.data.name || '' } : {}),
    createdAt: now,
    updatedAt: now,
    createdByRef: userRef,
    updatedByRef: userRef,
    primaryContactRef: null,
    primaryContactName: '',
    address: organization.address,
    city: organization.city,
    province: organization.province,
    postalCode: organization.postalCode,
  };

  await db.runTransaction(async (transaction) => {
    await syncEmailIdentityClaims(transaction, db, {
      recordType: 'organization',
      recordRef: organizationRef,
      emails,
      previousEmails: [],
      actorRef: userRef,
      timestamp: now,
    });
    transaction.create(organizationRef, data);
  });

  return {
    ok: true,
    created: true,
    organizationId: organizationRef.id,
    organizationPath: organizationRef.path,
  };
}

module.exports = { createCommandOrganizationService };

