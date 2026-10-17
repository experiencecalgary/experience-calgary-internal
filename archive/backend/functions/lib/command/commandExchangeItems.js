'use strict';

const admin = require('firebase-admin');
const { HttpsError } = require('firebase-functions/v2/https');
const { requireAuth, requireCommandAccess } = require('./commandPersonUtils');

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validId(value, fieldName) {
  const id = clean(value);
  if (!id || id.includes('/')) {
    throw new HttpsError('invalid-argument', `A valid ${fieldName} is required.`);
  }
  return id;
}

async function createCommandExchangeItemService(request) {
  const db = admin.firestore();
  const uid = requireAuth(request);
  const { userRef } = await requireCommandAccess(db, uid);
  const exchangeId = validId(request.data?.exchangeId, 'exchangeId');
  const libraryFileId = validId(request.data?.libraryFileId, 'libraryFileId');
  const exchangeRef = db.collection('commandExchanges').doc(exchangeId);
  const libraryRef = db.collection('commandLibraryFiles').doc(libraryFileId);
  const [exchangeSnap, librarySnap] = await Promise.all([
    exchangeRef.get(),
    libraryRef.get(),
  ]);

  if (!exchangeSnap.exists) throw new HttpsError('not-found', 'The Exchange does not exist.');
  if (!librarySnap.exists || librarySnap.data()?.archived === true) {
    throw new HttpsError('not-found', 'The library file does not exist.');
  }

  const exchange = exchangeSnap.data() || {};
  const library = librarySnap.data() || {};
  if (exchange.ownerUid !== uid) throw new HttpsError('permission-denied', 'Only the Exchange owner can add files.');
  if (exchange.type !== 'share' || exchange.status !== 'draft') {
    throw new HttpsError('failed-precondition', 'Files can only be added to draft share Exchanges.');
  }
  if (library.ownerUid !== uid && library.visibility !== 'shared') {
    throw new HttpsError('permission-denied', 'You do not have access to this library file.');
  }
  if (!clean(library.storagePath)) throw new HttpsError('failed-precondition', 'The library file is not ready.');

  const duplicate = await db.collection('commandExchangeItems')
    .where('exchangeRef', '==', exchangeRef)
    .where('libraryFileRef', '==', libraryRef)
    .limit(1)
    .get();
  if (!duplicate.empty) {
    return { ok: true, created: false, itemId: duplicate.docs[0].id };
  }

  const itemRef = db.collection('commandExchangeItems').doc();
  const now = admin.firestore.FieldValue.serverTimestamp();
  await itemRef.create({
    exchangeRef,
    libraryFileRef: libraryRef,
    fileName: library.fileName || '',
    contentType: library.contentType || 'application/octet-stream',
    sizeBytes: Number(library.sizeBytes || 0),
    storagePath: library.storagePath,
    uploadStatus: 'ready',
    createdAt: now,
    createdByRef: userRef,
  });

  return { ok: true, created: true, itemId: itemRef.id, itemPath: itemRef.path };
}

module.exports = { createCommandExchangeItemService };
