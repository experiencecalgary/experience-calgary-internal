'use strict';

const admin = require('firebase-admin');
const { HttpsError } = require('firebase-functions/v2/https');
const {
  requireAuth,
  requireCommandAccess,
} = require('./commandPersonUtils');
const {
  recordEmails,
  syncEmailIdentityClaims,
  sameRef,
} = require('./commandEmailIdentity');

const PEOPLE_COLLECTION = 'commandPeople';
const ORGANIZATIONS_COLLECTION = 'commandOrganizations';

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function referenceId(value, collection, fieldName, required = true) {
  const path = typeof value === 'string'
    ? value.trim()
    : typeof value?.path === 'string'
      ? value.path.trim()
      : '';
  const parts = path.split('/').filter(Boolean);
  const id = parts.length === 1
    ? parts[0]
    : parts.length === 2 && parts[0] === collection
      ? parts[1]
      : '';

  if ((!id && required) || id.includes('/')) {
    throw new HttpsError(
      'invalid-argument',
      `A valid ${fieldName} is ${required ? 'required' : 'expected'}.`
    );
  }
  return id;
}

function canAccess(uid, repId, data = {}) {
  return data.ownerUid === uid ||
    (Array.isArray(data.viewerUids) && data.viewerUids.includes(uid)) ||
    (repId && Array.isArray(data.teamRepIds) &&
      data.teamRepIds.map(String).includes(repId));
}

function organizationName(data = {}) {
  return clean(data.organization || data.name);
}

async function setCommandPersonOrganizationService(request) {
  const db = admin.firestore();
  const uid = requireAuth(request);
  const { userRef, userData } = await requireCommandAccess(db, uid);
  const repId = userData.repId === null || userData.repId === undefined
    ? ''
    : String(userData.repId).trim();

  const personId = referenceId(
    request.data?.personId || request.data?.personRefPath || request.data?.personRef,
    PEOPLE_COLLECTION,
    'personId'
  );

  const rawOrganization = request.data?.organizationId !== undefined
    ? request.data.organizationId
    : request.data?.organizationRefPath !== undefined
      ? request.data.organizationRefPath
      : request.data?.organizationRef;
  const disconnect = rawOrganization === null || rawOrganization === undefined ||
    (typeof rawOrganization === 'string' && !rawOrganization.trim());
  const makePrimaryContact = request.data?.makePrimaryContact === true;
  if (disconnect && makePrimaryContact) {
    throw new HttpsError(
      'invalid-argument',
      'A disconnected person cannot be the primary contact.'
    );
  }
  const organizationId = disconnect
    ? ''
    : referenceId(rawOrganization, ORGANIZATIONS_COLLECTION, 'organizationId');

  const personRef = db.collection(PEOPLE_COLLECTION).doc(personId);
  const nextOrganizationRef = organizationId
    ? db.collection(ORGANIZATIONS_COLLECTION).doc(organizationId)
    : null;
  const timestamp = admin.firestore.FieldValue.serverTimestamp();

  const result = await db.runTransaction(async (transaction) => {
    const personSnapshot = await transaction.get(personRef);
    if (!personSnapshot.exists || personSnapshot.data()?.archived === true) {
      throw new HttpsError('not-found', 'The selected person does not exist.');
    }
    const person = personSnapshot.data() || {};
    if (!canAccess(uid, repId, person)) {
      throw new HttpsError('permission-denied', 'You do not have access to update this person.');
    }

    const previousOrganizationRef = person.organizationRef || null;
    let nextOrganization = null;
    if (nextOrganizationRef) {
      const organizationSnapshot = await transaction.get(nextOrganizationRef);
      if (!organizationSnapshot.exists || organizationSnapshot.data()?.archived === true) {
        throw new HttpsError('not-found', 'The selected organization does not exist.');
      }
      nextOrganization = organizationSnapshot.data() || {};
      if (!canAccess(uid, repId, nextOrganization)) {
        throw new HttpsError(
          'permission-denied',
          'You do not have access to connect this organization.'
        );
      }
    }

    let previousOrganization = null;
    if (
      previousOrganizationRef &&
      !sameRef(previousOrganizationRef, nextOrganizationRef)
    ) {
      const previousSnapshot = await transaction.get(previousOrganizationRef);
      previousOrganization = previousSnapshot.exists
        ? previousSnapshot.data() || {}
        : null;
    }

    // A shared Person/Organization address is legal only while they are
    // connected. Prevent a move/disconnect from silently making it illegal.
    if (previousOrganization && previousOrganizationRef) {
      const personEmailSet = new Set(recordEmails(person));
      const shared = recordEmails(previousOrganization).filter((email) =>
        personEmailSet.has(email)
      );
      if (shared.length) {
        throw new HttpsError(
          'failed-precondition',
          'Remove the shared email address before disconnecting this person from the organization.',
          { sharedEmails: shared }
        );
      }
    }

    // This also creates missing identity claims for legacy people and verifies
    // that the requested relationship is compatible with every Person email.
    const emails = recordEmails(person);
    await syncEmailIdentityClaims(transaction, db, {
      recordType: 'person',
      recordRef: personRef,
      emails,
      previousEmails: emails,
      relatedOrganizationRef: nextOrganizationRef,
      actorRef: userRef,
      timestamp,
    });

    const update = {
      organizationRef: nextOrganizationRef,
      organizationName: nextOrganizationRef
        ? organizationName(nextOrganization)
        : admin.firestore.FieldValue.delete(),
      updatedAt: timestamp,
      updatedByRef: userRef,
    };
    transaction.update(personRef, update);

    const shouldSetPrimary = Boolean(
      nextOrganizationRef &&
      (makePrimaryContact || !nextOrganization?.primaryContactRef)
    );
    if (shouldSetPrimary) {
      const personName = clean(person.fullName) ||
        [clean(person.firstName), clean(person.lastName)].filter(Boolean).join(' ');
      transaction.update(nextOrganizationRef, {
        primaryContactRef: personRef,
        primaryContactName: personName,
        updatedAt: timestamp,
        updatedByRef: userRef,
      });
    }

    // Primary contact is derived from the Person relationship. If the Person
    // leaves, clear the old organization's primary-contact shortcut atomically.
    if (
      previousOrganizationRef &&
      !sameRef(previousOrganizationRef, nextOrganizationRef) &&
      previousOrganization &&
      sameRef(previousOrganization.primaryContactRef, personRef)
    ) {
      transaction.update(previousOrganizationRef, {
        primaryContactRef: null,
        primaryContactName: '',
        updatedAt: timestamp,
        updatedByRef: userRef,
      });
    }

    return {
      previousOrganizationId: previousOrganizationRef?.id || '',
      organizationName: nextOrganizationRef
        ? organizationName(nextOrganization)
        : '',
      primaryContact: shouldSetPrimary,
    };
  });

  return {
    ok: true,
    personId,
    personPath: personRef.path,
    organizationId,
    organizationPath: nextOrganizationRef?.path || '',
    organizationName: result.organizationName,
    previousOrganizationId: result.previousOrganizationId,
    connected: Boolean(nextOrganizationRef),
    primaryContact: result.primaryContact,
  };
}

async function assertPrimaryContactBelongsToOrganization(
  transaction,
  organizationRef,
  primaryContactRef
) {
  if (!primaryContactRef) return null;
  const snapshot = await transaction.get(primaryContactRef);
  const person = snapshot.exists ? snapshot.data() || {} : null;
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
  return person;
}

module.exports = {
  setCommandPersonOrganizationService,
  assertPrimaryContactBelongsToOrganization,
};
