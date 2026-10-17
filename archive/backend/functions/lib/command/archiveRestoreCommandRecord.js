'use strict';

const admin = require('firebase-admin');
const { HttpsError } = require('firebase-functions/v2/https');
const {
  requireAuth,
  requireCommandAccess,
} = require('./commandPersonUtils');

const ALLOWED_RECORDS = Object.freeze({
  person: {
    collection: 'commandPeople',
    idField: 'personId',
    label: 'contact',
  },
  organization: {
    collection: 'commandOrganizations',
    idField: 'organizationId',
    label: 'organization',
  },
});

function validDocumentId(value, fieldName) {
  const id = typeof value === 'string' ? value.trim() : '';

  if (!id || id.includes('/')) {
    throw new HttpsError(
      'invalid-argument',
      `A valid ${fieldName} is required.`
    );
  }

  return id;
}

function recordConfig(recordType) {
  const config = ALLOWED_RECORDS[recordType];

  if (!config) {
    throw new HttpsError(
      'internal',
      'Unsupported Experience Command record type.'
    );
  }

  return config;
}

function createArchiveCommandRecordService(recordType) {
  const config = recordConfig(recordType);

  return async function archiveCommandRecordService(request) {
    const db = admin.firestore();
    const uid = requireAuth(request);
    const { userRef } = await requireCommandAccess(db, uid);
    const recordId = validDocumentId(
      request.data?.[config.idField],
      config.idField
    );
    const recordRef = db.collection(config.collection).doc(recordId);

    const result = await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(recordRef);

      if (!snap.exists) {
        throw new HttpsError(
          'not-found',
          `The ${config.label} does not exist.`
        );
      }

      const current = snap.data() || {};

      if (current.archived === true) {
        return { changed: false };
      }

      const now = admin.firestore.FieldValue.serverTimestamp();
      transaction.update(recordRef, {
        archived: true,
        archivedAt: now,
        archivedByRef: userRef,
        restoredAt: admin.firestore.FieldValue.delete(),
        restoredByRef: admin.firestore.FieldValue.delete(),
        updatedAt: now,
        updatedByRef: userRef,
      });

      return { changed: true };
    });

    return {
      ok: true,
      archived: true,
      changed: result.changed,
      recordType,
      recordId,
      recordPath: recordRef.path,
    };
  };
}

function createRestoreCommandRecordService(recordType) {
  const config = recordConfig(recordType);

  return async function restoreCommandRecordService(request) {
    const db = admin.firestore();
    const uid = requireAuth(request);
    const { userRef } = await requireCommandAccess(db, uid);
    const recordId = validDocumentId(
      request.data?.[config.idField],
      config.idField
    );
    const recordRef = db.collection(config.collection).doc(recordId);

    const result = await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(recordRef);

      if (!snap.exists) {
        throw new HttpsError(
          'not-found',
          `The ${config.label} does not exist.`
        );
      }

      const current = snap.data() || {};

      if (current.archived !== true) {
        return { changed: false };
      }

      const now = admin.firestore.FieldValue.serverTimestamp();
      transaction.update(recordRef, {
        archived: false,
        restoredAt: now,
        restoredByRef: userRef,
        updatedAt: now,
        updatedByRef: userRef,
      });

      return { changed: true };
    });

    return {
      ok: true,
      restored: true,
      changed: result.changed,
      recordType,
      recordId,
      recordPath: recordRef.path,
    };
  };
}

module.exports = {
  createArchiveCommandRecordService,
  createRestoreCommandRecordService,
};
