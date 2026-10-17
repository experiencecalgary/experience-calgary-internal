'use strict';

const admin = require('firebase-admin');
const { assignmentActor, assertRecordAssignment } = require('./commandRecordAssignment');
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
  syncEmailIdentityClaims,
} = require('./commandEmailIdentity');

function referencePath(value) {
  if (typeof value === 'string') return value.trim();
  return typeof value?.path === 'string' ? value.path.trim() : '';
}

async function resolveAssignedToRef(db, rawValue, fallbackRef) {
  const path = referencePath(rawValue) || fallbackRef.path;
  const parts = path.split('/').filter(Boolean);
  if (parts.length !== 2 || parts[0] !== 'users') {
    throw new HttpsError(
      'invalid-argument',
      'Invalid assignedToRefPath. Expected users/{documentId}.'
    );
  }

  const assignedToRef = db.doc(parts.join('/'));
  const assignedToSnap = await assignedToRef.get();
  if (!assignedToSnap.exists) {
    throw new HttpsError(
      'invalid-argument',
      'The selected assigned representative does not exist.'
    );
  }

  const assignedTo = assignedToSnap.data() || {};
  if (assignedTo.active === false || assignedTo.userType !== 'rep') {
    throw new HttpsError(
      'failed-precondition',
      'The selected assigned user must be an active Experience Calgary representative.'
    );
  }
  return assignedToRef;
}

async function createCommandPersonService(request) {
  const db = admin.firestore();
  const uid = requireAuth(request);
  const { userRef, userData } = await requireCommandAccess(db, uid);

  const personInput = {
    ...(request.data || {}),
    organizationRefPath: referencePath(
      request.data?.organizationRefPath !== undefined
        ? request.data.organizationRefPath
        : request.data?.organizationRef
    ),
  };
  const person = sanitizePersonInput(personInput);
  const additionalEmails = normalizeAdditionalEmails(
    request.data?.additionalEmails || [],
    person.emailNormalized
  );
  const errors = validatePersonFields(person);

  if (Object.keys(errors).length > 0) {
    throw new HttpsError(
      'invalid-argument',
      'Contact information is invalid.',
      { errors }
    );
  }

  const assignedInput = request.data?.assignedToRefPath !== undefined
    ? request.data.assignedToRefPath
    : request.data?.assignedToRef;
  const [{ ownerRef, organizationRef }, assignedToRef] = await Promise.all([
    resolveReferences(
      db,
      { ...person, ownerRefPath: undefined },
      userRef
    ),
    resolveAssignedToRef(db, assignedInput, userRef),
  ]);

  await assertRecordAssignment(db, await assignmentActor(db, uid, userData), null, assignedToRef);
  const access = await buildCommandAccessMetadata(db, {
    actorRef: userRef,
    ownerRef,
    assignedToRef,
  });
  const requestedLeadListId = referencePath(request.data?.leadListId);
  const leadList = requestedLeadListId
    ? await resolveCommandLeadList(db, uid, userData, requestedLeadListId)
    : null;

  const matches = await findDuplicateMatches(db, person);
  if (matches.length > 0) {
    throw new HttpsError(
      'already-exists',
      'A contact already uses this email address or phone number.',
      { matches }
    );
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  const personRef = db.collection(PEOPLE_COLLECTION).doc();
  const fullName = [person.firstName, person.lastName].filter(Boolean).join(' ').trim();
  const emails = [person.emailNormalized, ...additionalEmails].filter(Boolean);

  const documentData = {
    firstName: person.firstName,
    lastName: person.lastName,
    fullName,
    fullNameNormalized: person.fullNameNormalized,
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
    archived: false,
    ...(leadList ? { leadListId: leadList.ref.id, leadListName: leadList.data.name || '' } : {}),
    createdAt: now,
    updatedAt: now,
    createdByRef: userRef,
    updatedByRef: userRef,
  };

  if (person.organizationName) {
    documentData.organizationName = person.organizationName;
  }

  await db.runTransaction(async (transaction) => {
    const organizationSnapshot = organizationRef
      ? await transaction.get(organizationRef)
      : null;
    if (organizationRef && !organizationSnapshot?.exists) {
      throw new HttpsError(
        'failed-precondition',
        'The selected organization no longer exists.'
      );
    }

    await syncEmailIdentityClaims(transaction, db, {
      recordType: 'person',
      recordRef: personRef,
      emails,
      previousEmails: [],
      relatedOrganizationRef: organizationRef,
      actorRef: userRef,
      timestamp: now,
    });
    transaction.create(personRef, documentData);

    const organization = organizationSnapshot?.data() || {};
    if (organizationRef && !organization.primaryContactRef) {
      transaction.update(organizationRef, {
        primaryContactRef: personRef,
        primaryContactName: fullName,
        updatedAt: now,
        updatedByRef: userRef,
      });
    }
  });

  return {
    ok: true,
    created: true,
    personId: personRef.id,
    personPath: personRef.path,
  };
}

module.exports = { createCommandPersonService };

