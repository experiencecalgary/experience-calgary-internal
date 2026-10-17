'use strict';

const crypto = require('crypto');
const admin = require('firebase-admin');
const { HttpsError } = require('firebase-functions/v2/https');
const {
  requireAuth,
  requireCommandAccess,
} = require('./commandPersonUtils');

const EXCHANGES_COLLECTION = 'commandExchanges';
const EXCHANGE_ITEMS_COLLECTION = 'commandExchangeItems';
const PEOPLE_COLLECTION = 'commandPeople';
const ORGANIZATIONS_COLLECTION = 'commandOrganizations';
const SETTINGS_PATH = 'commandSettings/exchange';
const DEFAULT_EXPIRY_HOURS = 48;
const ALLOWED_TYPES = new Set(['request', 'share']);

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validDocumentId(value, fieldName) {
  const id = clean(value);
  if (!id || id.includes('/')) {
    throw new HttpsError('invalid-argument', `A valid ${fieldName} is required.`);
  }
  return id;
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function actorName(user = {}) {
  const combined = [clean(user.firstName), clean(user.lastName)]
    .filter(Boolean)
    .join(' ');
  return clean(user.fullName) || clean(user.displayName) || combined || clean(user.email);
}

function actorTeamRepIds(user = {}) {
  return [...new Set([
    clean(user.repId),
    clean(user.programDirectorRepId),
    clean(user.directorRepId),
  ].filter(Boolean))];
}

async function optionalRecord(db, collection, id, label) {
  const cleanedId = clean(id);
  if (!cleanedId) return { ref: null, name: '' };
  validDocumentId(cleanedId, `${label}Id`);

  const ref = db.collection(collection).doc(cleanedId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.archived === true) {
    throw new HttpsError('not-found', `The selected ${label} does not exist.`);
  }

  const data = snap.data() || {};
  const name = collection === PEOPLE_COLLECTION
    ? clean(data.fullName) || [clean(data.firstName), clean(data.lastName)].filter(Boolean).join(' ')
    : clean(data.organization) || clean(data.name);

  return { ref, name };
}

async function expiryHours(db) {
  const snap = await db.doc(SETTINGS_PATH).get();
  const configured = Number(snap.data()?.exchangeLinkExpiryHours);
  if (Number.isFinite(configured) && configured >= 1 && configured <= 720) {
    return configured;
  }
  return DEFAULT_EXPIRY_HOURS;
}

function assertOwner(actorUid, exchange) {
  if (exchange.ownerUid !== actorUid) {
    throw new HttpsError('permission-denied', 'Only the Exchange owner can perform this action.');
  }
}

async function createCommandExchangeService(request) {
  const db = admin.firestore();
  const uid = requireAuth(request);
  const { userRef, userData } = await requireCommandAccess(db, uid);

  const type = clean(request.data?.type).toLowerCase();
  if (!ALLOWED_TYPES.has(type)) {
    throw new HttpsError('invalid-argument', 'Exchange type must be request or share.');
  }

  const title = clean(request.data?.title);
  const message = clean(request.data?.message);
  if (!title) {
    throw new HttpsError('invalid-argument', 'An Exchange title is required.');
  }
  if (title.length > 200) {
    throw new HttpsError('invalid-argument', 'Exchange title must be 200 characters or fewer.');
  }
  if (message.length > 5000) {
    throw new HttpsError('invalid-argument', 'Exchange message must be 5000 characters or fewer.');
  }

  const [person, organization, hours] = await Promise.all([
    optionalRecord(db, PEOPLE_COLLECTION, request.data?.personId, 'contact'),
    optionalRecord(db, ORGANIZATIONS_COLLECTION, request.data?.organizationId, 'organization'),
    expiryHours(db),
  ]);

  const token = randomToken();
  const exchangeRef = db.collection(EXCHANGES_COLLECTION).doc();
  const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + hours * 60 * 60 * 1000);
  const now = admin.firestore.FieldValue.serverTimestamp();

  await exchangeRef.create({
    type,
    status: 'draft',
    title,
    message,
    personRef: person.ref,
    personName: person.name,
    organizationRef: organization.ref,
    organizationName: organization.name,
    ownerUid: uid,
    ownerRef: userRef,
    ownerName: actorName(userData),
    viewerUids: [uid],
    teamRepIds: actorTeamRepIds(userData),
    tokenHash: hashToken(token),
    expiresAt,
    confirmedAt: null,
    completedAt: null,
    cancelledAt: null,
    createdAt: now,
    createdByRef: userRef,
    updatedAt: now,
    updatedByRef: userRef,
  });

  return {
    ok: true,
    created: true,
    exchangeId: exchangeRef.id,
    exchangePath: exchangeRef.path,
    token,
    type,
    status: 'draft',
    expiresAt: expiresAt.toDate().toISOString(),
  };
}

async function confirmCommandExchangeService(request) {
  const db = admin.firestore();
  const uid = requireAuth(request);
  const { userRef } = await requireCommandAccess(db, uid);
  const exchangeId = validDocumentId(request.data?.exchangeId, 'exchangeId');
  const exchangeRef = db.collection(EXCHANGES_COLLECTION).doc(exchangeId);

  const result = await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(exchangeRef);
    if (!snap.exists) {
      throw new HttpsError('not-found', 'The Exchange does not exist.');
    }

    const exchange = snap.data() || {};
    assertOwner(uid, exchange);

    if (exchange.status === 'open' || exchange.status === 'active') {
      return { changed: false, status: exchange.status, type: exchange.type };
    }
    if (exchange.status !== 'draft') {
      throw new HttpsError('failed-precondition', 'Only draft Exchanges can be confirmed.');
    }
    if (exchange.expiresAt?.toMillis?.() <= Date.now()) {
      throw new HttpsError('failed-precondition', 'This Exchange has already expired.');
    }

    if (exchange.type === 'share') {
      const itemSnap = await transaction.get(
        db.collection(EXCHANGE_ITEMS_COLLECTION)
          .where('exchangeRef', '==', exchangeRef)
          .limit(1)
      );
      if (itemSnap.empty) {
        throw new HttpsError('failed-precondition', 'Add at least one file before confirming a share Exchange.');
      }
    }

    const status = exchange.type === 'request' ? 'open' : 'active';
    const now = admin.firestore.FieldValue.serverTimestamp();
    transaction.update(exchangeRef, {
      status,
      confirmedAt: now,
      confirmedByRef: userRef,
      updatedAt: now,
      updatedByRef: userRef,
    });

    return { changed: true, status, type: exchange.type };
  });

  return {
    ok: true,
    confirmed: true,
    changed: result.changed,
    exchangeId,
    type: result.type,
    status: result.status,
  };
}

async function cancelCommandExchangeService(request) {
  const db = admin.firestore();
  const uid = requireAuth(request);
  const { userRef } = await requireCommandAccess(db, uid);
  const exchangeId = validDocumentId(request.data?.exchangeId, 'exchangeId');
  const exchangeRef = db.collection(EXCHANGES_COLLECTION).doc(exchangeId);

  const result = await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(exchangeRef);
    if (!snap.exists) {
      throw new HttpsError('not-found', 'The Exchange does not exist.');
    }

    const exchange = snap.data() || {};
    assertOwner(uid, exchange);

    if (exchange.status === 'cancelled') {
      return { changed: false, previousStatus: exchange.status };
    }
    if (exchange.status === 'completed') {
      throw new HttpsError('failed-precondition', 'A completed Exchange cannot be cancelled.');
    }

    const previousStatus = exchange.status;
    const now = admin.firestore.FieldValue.serverTimestamp();
    transaction.update(exchangeRef, {
      status: 'cancelled',
      cancelledAt: now,
      cancelledByRef: userRef,
      updatedAt: now,
      updatedByRef: userRef,
    });

    return { changed: true, previousStatus };
  });

  return {
    ok: true,
    cancelled: true,
    changed: result.changed,
    exchangeId,
    previousStatus: result.previousStatus,
    status: 'cancelled',
  };
}

module.exports = {
  createCommandExchangeService,
  confirmCommandExchangeService,
  cancelCommandExchangeService,
};
