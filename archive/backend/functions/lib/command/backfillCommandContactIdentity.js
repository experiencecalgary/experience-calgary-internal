'use strict';

const admin = require('firebase-admin');
const { HttpsError } = require('firebase-functions/v2/https');
const {
  requireAuth,
  requireCommandAccess,
} = require('./commandPersonUtils');
const {
  normalizeEmail,
  normalizeAdditionalEmails,
  recordEmails,
  sameRef,
  assertClaimsAvailable,
  syncEmailIdentityClaims,
} = require('./commandEmailIdentity');

const PEOPLE = 'commandPeople';
const ORGANIZATIONS = 'commandOrganizations';

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlatformAdmin(data = {}) {
  return data.role === 'platform_admin' ||
    data.userRole === 'platform_admin' ||
    data.platformAdmin === true;
}

function collectionFor(recordType) {
  if (recordType === 'people') return PEOPLE;
  if (recordType === 'organizations') return ORGANIZATIONS;
  throw new HttpsError(
    'invalid-argument',
    'recordType must be people or organizations.'
  );
}

async function legacyEmailMatches(db, collection, value) {
  const [primary, additional] = await Promise.all([
    db.collection(collection)
      .where('emailNormalized', '==', value)
      .limit(3)
      .get(),
    db.collection(collection)
      .where('additionalEmailsNormalized', 'array-contains', value)
      .limit(3)
      .get(),
  ]);
  return [...new Map(
    [...primary.docs, ...additional.docs].map((doc) => [doc.ref.path, doc])
  ).values()];
}

async function auditLegacyConflicts(db, recordType, ref, data, emails) {
  const sameCollection = recordType === 'people' ? PEOPLE : ORGANIZATIONS;
  const otherCollection = recordType === 'people' ? ORGANIZATIONS : PEOPLE;
  const conflicts = [];

  for (const value of emails) {
    const [sameMatches, otherMatches] = await Promise.all([
      legacyEmailMatches(db, sameCollection, value),
      legacyEmailMatches(db, otherCollection, value),
    ]);
    const sameOther = sameMatches.find((doc) => doc.ref.path !== ref.path);
    if (sameOther) {
      conflicts.push({
        email: value,
        reason: recordType === 'people'
          ? 'email_used_by_another_person'
          : 'email_used_by_another_organization',
        conflictingPath: sameOther.ref.path,
      });
      continue;
    }

    for (const match of otherMatches) {
      const allowed = recordType === 'people'
        ? sameRef(data.organizationRef, match.ref)
        : sameRef(match.data()?.organizationRef, ref);
      if (!allowed) {
        conflicts.push({
          email: value,
          reason: recordType === 'people'
            ? 'email_used_by_unrelated_organization'
            : 'email_used_by_unrelated_person',
          conflictingPath: match.ref.path,
        });
        break;
      }
    }
  }
  return conflicts;
}

async function backfillCommandContactIdentityService(request) {
  const db = admin.firestore();
  const uid = requireAuth(request);
  const { userRef, userData } = await requireCommandAccess(db, uid);
  if (userData.active === false || !isPlatformAdmin(userData)) {
    throw new HttpsError(
      'permission-denied',
      'Only an active platform administrator can run this migration.'
    );
  }

  const recordType = clean(request.data?.recordType);
  const collection = collectionFor(recordType);
  const dryRun = request.data?.dryRun !== false;
  const requestedLimit = Number(request.data?.limit);
  const limit = Math.min(
    Math.max(Number.isInteger(requestedLimit) ? requestedLimit : 25, 1),
    50
  );
  const startAfterId = clean(request.data?.startAfterId);

  let query = db.collection(collection)
    .orderBy(admin.firestore.FieldPath.documentId())
    .limit(limit);
  if (startAfterId) query = query.startAfter(startAfterId);
  const page = await query.get();

  const results = [];
  let repairedCount = 0;
  let conflictCount = 0;

  for (const document of page.docs) {
    const data = document.data() || {};
    let additionalEmails;
    let emails;
    try {
      const primary = normalizeEmail(data.emailNormalized || data.email);
      additionalEmails = normalizeAdditionalEmails(
        data.additionalEmailsNormalized || data.additionalEmails || [],
        primary
      );
      emails = [...new Set([primary, ...additionalEmails].filter(Boolean))];
    } catch (error) {
      conflictCount += 1;
      results.push({
        id: document.id,
        path: document.ref.path,
        status: 'conflict',
        conflicts: [{
          reason: 'invalid_additional_email_data',
          message: error.message || 'Additional email data is invalid.',
        }],
      });
      continue;
    }

    const legacyConflicts = await auditLegacyConflicts(
      db,
      recordType,
      document.ref,
      data,
      emails
    );
    if (legacyConflicts.length) {
      conflictCount += 1;
      results.push({
        id: document.id,
        path: document.ref.path,
        status: 'conflict',
        conflicts: legacyConflicts,
      });
      continue;
    }

    const fallbackAssignedToRef = data.assignedToRef ||
      data.ownerRef ||
      data.createdByRef ||
      null;
    if (!fallbackAssignedToRef) {
      conflictCount += 1;
      results.push({
        id: document.id,
        path: document.ref.path,
        status: 'conflict',
        conflicts: [{ reason: 'missing_owner_and_assignee' }],
      });
      continue;
    }

    try {
      const outcome = await db.runTransaction(async (transaction) => {
        const currentSnapshot = await transaction.get(document.ref);
        if (!currentSnapshot.exists) {
          throw new HttpsError('not-found', 'The record was removed during migration.');
        }
        const current = currentSnapshot.data() || {};
        let clearPrimaryContact = false;

        if (recordType === 'organizations' && current.primaryContactRef) {
          const personSnapshot = await transaction.get(current.primaryContactRef);
          const person = personSnapshot.exists ? personSnapshot.data() || {} : null;
          clearPrimaryContact = !person ||
            person.archived === true ||
            !sameRef(person.organizationRef, document.ref);
        }

        await assertClaimsAvailable(transaction, db, {
          recordType: recordType === 'people' ? 'person' : 'organization',
          recordRef: document.ref,
          emails,
          relatedOrganizationRef: current.organizationRef || null,
        });

        if (!dryRun) {
          await syncEmailIdentityClaims(transaction, db, {
            recordType: recordType === 'people' ? 'person' : 'organization',
            recordRef: document.ref,
            emails,
            previousEmails: recordEmails(current),
            relatedOrganizationRef: current.organizationRef || null,
            actorRef: userRef,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
          });

          const update = {
            emailNormalized: normalizeEmail(current.emailNormalized || current.email),
            additionalEmails,
            additionalEmailsNormalized: additionalEmails,
            assignedToRef: current.assignedToRef ||
              current.ownerRef ||
              current.createdByRef,
            identityBackfilledAt: admin.firestore.FieldValue.serverTimestamp(),
            identityBackfilledByRef: userRef,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          };
          if (clearPrimaryContact) {
            update.primaryContactRef = null;
            update.primaryContactName = '';
          }
          transaction.update(document.ref, update);
        }

        return { clearPrimaryContact };
      });

      repairedCount += dryRun ? 0 : 1;
      results.push({
        id: document.id,
        path: document.ref.path,
        status: dryRun ? 'ready' : 'repaired',
        emailCount: emails.length,
        assignmentRepairRequired: !data.assignedToRef,
        invalidPrimaryContact: outcome.clearPrimaryContact,
      });
    } catch (error) {
      conflictCount += 1;
      results.push({
        id: document.id,
        path: document.ref.path,
        status: 'conflict',
        conflicts: [{
          reason: error.details?.conflictType || error.code || 'migration_error',
          email: error.details?.email || '',
          message: error.message || 'Migration failed.',
        }],
      });
    }
  }

  const lastDocument = page.docs[page.docs.length - 1];
  return {
    ok: true,
    dryRun,
    recordType,
    processedCount: page.size,
    repairedCount,
    conflictCount,
    nextCursor: page.size === limit ? lastDocument.id : '',
    done: page.size < limit,
    results,
  };
}

module.exports = {
  backfillCommandContactIdentityService,
};
