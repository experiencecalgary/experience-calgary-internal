'use strict';

const crypto = require('crypto');
const admin = require('firebase-admin');
const { HttpsError } = require('firebase-functions/v2/https');
const {
  requireAuth,
  requireCommandAccess,
} = require('./commandPersonUtils');

const EXCHANGES = 'commandExchanges';
const ITEMS = 'commandExchangeItems';
const LIBRARY = 'commandLibraryFiles';
const THREADS = 'commandEmailThreads';
const PEOPLE = 'commandPeople';
const ORGANIZATIONS = 'commandOrganizations';
const SETTINGS = 'commandSettings/exchange';
const DEFAULTS = Object.freeze({ maxFiles: 10, maxFileSizeMb: 20, maxTotalMb: 75 });

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

function hashToken(value) {
  return crypto.createHash('sha256').update(clean(value)).digest('hex');
}

function tokenMatches(provided, storedHash) {
  const a = Buffer.from(hashToken(provided), 'hex');
  const b = Buffer.from(clean(storedHash), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function filename(value) {
  const name = clean(value).replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 180);
  if (!name) throw new HttpsError('invalid-argument', 'A file name is required.');
  return name;
}

function positiveInteger(value, fieldName) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new HttpsError('invalid-argument', `${fieldName} must be a positive integer.`);
  }
  return number;
}

function recordName(data = {}) {
  return clean(data.fullName) || [clean(data.firstName), clean(data.lastName)].filter(Boolean).join(' ') || clean(data.organization) || clean(data.name);
}

function canAccess(uid, data = {}) {
  return data.ownerUid === uid || Array.isArray(data.viewerUids) && data.viewerUids.includes(uid);
}

async function actor(request) {
  const db = admin.firestore();
  const uid = requireAuth(request);
  const access = await requireCommandAccess(db, uid);
  return { db, uid, ...access };
}

async function settings(db) {
  const snap = await db.doc(SETTINGS).get();
  const data = snap.data() || {};
  const bounded = (value, fallback, max) => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 1 && number <= max ? number : fallback;
  };
  return {
    maxFiles: bounded(data.maxFilesPerExchange, DEFAULTS.maxFiles, 100),
    maxFileSizeMb: bounded(data.maxFileSizeMb, DEFAULTS.maxFileSizeMb, 500),
    maxTotalMb: bounded(data.maxTotalExchangeSizeMb, DEFAULTS.maxTotalMb, 2000),
  };
}

async function signedUrl(storagePath, action, contentType) {
  const options = {
    version: 'v4',
    action,
    expires: Date.now() + 15 * 60 * 1000,
  };
  if (action === 'write' && contentType) options.contentType = contentType;
  const [url] = await admin.storage().bucket().file(storagePath).getSignedUrl(options);
  return url;
}

async function getExchange(db, exchangeId) {
  const ref = db.collection(EXCHANGES).doc(validId(exchangeId, 'exchangeId'));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'The Exchange does not exist.');
  return { ref, snap, data: snap.data() || {} };
}

async function createCommandLibraryFileService(request) {
  const { db, uid, userRef, userData } = await actor(request);
  const name = filename(request.data?.fileName);
  const sizeBytes = positiveInteger(request.data?.sizeBytes, 'sizeBytes');
  const contentType = clean(request.data?.contentType) || 'application/octet-stream';
  const config = await settings(db);
  if (sizeBytes > config.maxFileSizeMb * 1024 * 1024) {
    throw new HttpsError('failed-precondition', `Files may not exceed ${config.maxFileSizeMb} MB.`);
  }

  const ref = db.collection(LIBRARY).doc();
  const storagePath = `command/library/${uid}/${ref.id}/${name}`;
  const now = admin.firestore.FieldValue.serverTimestamp();
  await ref.create({
    fileName: name,
    contentType,
    sizeBytes,
    storagePath,
    ownerUid: uid,
    ownerRef: userRef,
    ownerName: recordName(userData),
    visibility: request.data?.visibility === 'shared' ? 'shared' : 'personal',
    archived: false,
    uploadStatus: 'pending',
    createdAt: now,
    createdByRef: userRef,
    updatedAt: now,
    updatedByRef: userRef,
  });

  return {
    ok: true,
    libraryFileId: ref.id,
    libraryFilePath: ref.path,
    storagePath,
    uploadUrl: await signedUrl(storagePath, 'write', contentType),
    expiresInSeconds: 900,
  };
}

async function setLibraryArchived(request, archived) {
  const { db, uid, userRef } = await actor(request);
  const id = validId(request.data?.libraryFileId, 'libraryFileId');
  const ref = db.collection(LIBRARY).doc(id);
  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'The library file does not exist.');
    const data = snap.data() || {};
    if (data.ownerUid !== uid) throw new HttpsError('permission-denied', 'Only the file owner can change this file.');
    const now = admin.firestore.FieldValue.serverTimestamp();
    transaction.update(ref, {
      archived,
      archivedAt: archived ? now : admin.firestore.FieldValue.delete(),
      archivedByRef: archived ? userRef : admin.firestore.FieldValue.delete(),
      restoredAt: archived ? admin.firestore.FieldValue.delete() : now,
      restoredByRef: archived ? admin.firestore.FieldValue.delete() : userRef,
      updatedAt: now,
      updatedByRef: userRef,
    });
  });
  return { ok: true, libraryFileId: id, archived };
}

const archiveCommandLibraryFileService = (request) => setLibraryArchived(request, true);
const restoreCommandLibraryFileService = (request) => setLibraryArchived(request, false);

async function getCommandExchangeItemAccessService(request) {
  const { db, uid } = await actor(request);
  const itemId = validId(request.data?.itemId, 'itemId');
  const snap = await db.collection(ITEMS).doc(itemId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'The Exchange item does not exist.');
  const item = snap.data() || {};
  const exchangeSnap = await item.exchangeRef.get();
  if (!exchangeSnap.exists || !canAccess(uid, exchangeSnap.data() || {})) {
    throw new HttpsError('permission-denied', 'You do not have access to this Exchange item.');
  }
  if (!clean(item.storagePath)) throw new HttpsError('failed-precondition', 'The file is not ready.');
  return { ok: true, itemId, downloadUrl: await signedUrl(item.storagePath, 'read'), expiresInSeconds: 900 };
}

async function publicExchangeFromRequest(req) {
  const db = admin.firestore();
  const exchangeId = clean(req.query.exchangeId || req.body?.exchangeId);
  const token = clean(req.query.token || req.body?.token || req.headers['x-command-exchange-token']);
  if (!exchangeId || !token) throw new HttpsError('invalid-argument', 'exchangeId and token are required.');
  const result = await getExchange(db, exchangeId);
  const exchange = result.data;
  if (!tokenMatches(token, exchange.tokenHash)) throw new HttpsError('permission-denied', 'The Exchange link is invalid.');
  if (exchange.expiresAt?.toMillis?.() <= Date.now() && exchange.status !== 'completed') {
    throw new HttpsError('failed-precondition', 'The Exchange link has expired.');
  }
  if (['cancelled', 'expired'].includes(exchange.status)) {
    throw new HttpsError('failed-precondition', `This Exchange is ${exchange.status}.`);
  }
  return { db, exchangeId, token, ...result };
}

function publicError(res, error) {
  const status = {
    'invalid-argument': 400,
    'permission-denied': 403,
    'not-found': 404,
    'failed-precondition': 409,
  }[error.code] || 500;
  res.status(status).json({ ok: false, error: error.message || 'Request failed.' });
}

async function getPublicCommandExchangeHandler(req, res) {
  try {
    const { db, exchangeId, ref, data } = await publicExchangeFromRequest(req);
    const items = await db.collection(ITEMS).where('exchangeRef', '==', ref).limit(100).get();
    res.status(200).json({
      ok: true,
      exchange: {
        exchangeId,
        type: data.type,
        status: data.status,
        title: data.title || '',
        message: data.message || '',
        ownerName: data.ownerName || '',
        expiresAt: data.expiresAt?.toDate?.().toISOString() || null,
      },
      items: items.docs.map((doc) => {
        const item = doc.data() || {};
        return { itemId: doc.id, fileName: item.fileName || '', sizeBytes: item.sizeBytes || 0, contentType: item.contentType || '' };
      }),
    });
  } catch (error) { publicError(res, error); }
}

async function preparePublicCommandExchangeUploadHandler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required.' });
    const { db, ref, data } = await publicExchangeFromRequest(req);
    if (data.type !== 'request' || data.status !== 'open') throw new HttpsError('failed-precondition', 'This Exchange is not accepting uploads.');
    const name = filename(req.body?.fileName);
    const sizeBytes = positiveInteger(req.body?.sizeBytes, 'sizeBytes');
    const contentType = clean(req.body?.contentType) || 'application/octet-stream';
    const config = await settings(db);
    const existing = await db.collection(ITEMS).where('exchangeRef', '==', ref).limit(config.maxFiles + 1).get();
    if (existing.size >= config.maxFiles) throw new HttpsError('failed-precondition', `This Exchange accepts at most ${config.maxFiles} files.`);
    const currentTotal = existing.docs.reduce((sum, doc) => sum + Number(doc.data()?.sizeBytes || 0), 0);
    if (sizeBytes > config.maxFileSizeMb * 1024 * 1024 || currentTotal + sizeBytes > config.maxTotalMb * 1024 * 1024) {
      throw new HttpsError('failed-precondition', 'The file exceeds the configured Exchange size limits.');
    }
    const itemRef = db.collection(ITEMS).doc();
    const storagePath = `command/exchanges/${ref.id}/public/${itemRef.id}/${name}`;
    await itemRef.create({ exchangeRef: ref, fileName: name, sizeBytes, contentType, storagePath, uploadStatus: 'pending', createdAt: admin.firestore.FieldValue.serverTimestamp() });
    res.status(200).json({ ok: true, itemId: itemRef.id, uploadUrl: await signedUrl(storagePath, 'write', contentType), expiresInSeconds: 900 });
  } catch (error) { publicError(res, error); }
}

async function submitPublicCommandExchangeHandler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required.' });
    const { db, ref, data } = await publicExchangeFromRequest(req);
    if (data.type !== 'request') throw new HttpsError('failed-precondition', 'Only request Exchanges can be submitted.');
    const items = await db.collection(ITEMS).where('exchangeRef', '==', ref).limit(100).get();
    if (items.empty) throw new HttpsError('failed-precondition', 'Upload at least one file before submitting.');
    await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(ref);
      const current = snap.data() || {};
      if (current.status === 'completed') return;
      if (current.status !== 'open') throw new HttpsError('failed-precondition', 'This Exchange is not open.');
      transaction.update(ref, { status: 'completed', completedAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    });
    res.status(200).json({ ok: true, submitted: true, status: 'completed', fileCount: items.size });
  } catch (error) { publicError(res, error); }
}

async function getPublicCommandExchangeItemAccessHandler(req, res) {
  try {
    const { db, ref, data } = await publicExchangeFromRequest(req);
    if (data.type !== 'share' || data.status !== 'active') throw new HttpsError('failed-precondition', 'This Exchange is not available for downloads.');
    const itemId = validId(req.query.itemId || req.body?.itemId, 'itemId');
    const snap = await db.collection(ITEMS).doc(itemId).get();
    const item = snap.data() || {};
    if (!snap.exists || item.exchangeRef?.path !== ref.path) throw new HttpsError('not-found', 'The Exchange item does not exist.');
    res.status(200).json({ ok: true, itemId, downloadUrl: await signedUrl(item.storagePath, 'read'), expiresInSeconds: 900 });
  } catch (error) { publicError(res, error); }
}

async function linkThread(request, mode) {
  const { db, uid, userRef } = await actor(request);
  const threadId = validId(request.data?.threadId, 'threadId');
  const threadRef = db.collection(THREADS).doc(threadId);
  const threadSnap = await threadRef.get();
  if (!threadSnap.exists || !canAccess(uid, threadSnap.data() || {})) throw new HttpsError('permission-denied', 'You do not have access to this email thread.');
  const now = admin.firestore.FieldValue.serverTimestamp();
  if (mode === 'unlink') {
    await threadRef.update({ personRef: null, personName: '', organizationRef: null, organizationName: '', linkedAt: admin.firestore.FieldValue.delete(), linkedByRef: admin.firestore.FieldValue.delete(), updatedAt: now });
    return { ok: true, threadId, unlinked: true };
  }
  const organizationId = validId(request.data?.organizationId, 'organizationId');
  const organizationRef = db.collection(ORGANIZATIONS).doc(organizationId);
  const organizationSnap = await organizationRef.get();
  if (!organizationSnap.exists || organizationSnap.data()?.archived === true) throw new HttpsError('not-found', 'The selected organization does not exist.');
  await threadRef.update({ organizationRef, organizationName: recordName(organizationSnap.data() || {}), linkedAt: now, linkedByRef: userRef, updatedAt: now });
  return { ok: true, threadId, organizationId, linked: true };
}

const linkCommandEmailThreadToOrganizationService = (request) => linkThread(request, 'organization');
const unlinkCommandEmailThreadService = (request) => linkThread(request, 'unlink');

async function searchCommandRecordsService(request) {
  const { db, uid } = await actor(request);
  const query = clean(request.data?.query).toLowerCase();
  if (query.length < 2 || query.length > 100) throw new HttpsError('invalid-argument', 'Search must contain 2 to 100 characters.');
  const limit = Math.min(Math.max(Number(request.data?.limit) || 10, 1), 25);
  const types = Array.isArray(request.data?.types) ? request.data.types : ['people', 'organizations', 'emailThreads', 'exchanges', 'libraryFiles'];
  const definitions = {
    people: [PEOPLE, ['fullName', 'email', 'phone', 'organizationName']],
    organizations: [ORGANIZATIONS, ['organization', 'email', 'phone', 'city']],
    emailThreads: [THREADS, ['subject', 'personName', 'organizationName', 'senderEmail']],
    exchanges: [EXCHANGES, ['title', 'personName', 'organizationName', 'ownerName']],
    libraryFiles: [LIBRARY, ['fileName', 'ownerName']],
  };
  const results = [];
  for (const type of types) {
    const definition = definitions[type];
    if (!definition) continue;
    const snap = await db.collection(definition[0]).orderBy('updatedAt', 'desc').limit(100).get().catch(() => db.collection(definition[0]).limit(100).get());
    for (const doc of snap.docs) {
      const data = doc.data() || {};
      if (data.archived === true || !canAccess(uid, data) && data.ownerUid) continue;
      const haystack = definition[1].map((field) => clean(data[field])).join(' ').toLowerCase();
      if (haystack.includes(query)) results.push({ type, id: doc.id, path: doc.ref.path, title: clean(data.fullName || data.organization || data.subject || data.title || data.fileName), subtitle: clean(data.email || data.organizationName || data.ownerName || data.phone) });
      if (results.length >= limit) return { ok: true, query, results };
    }
  }
  return { ok: true, query, results };
}

function validateCsvRows(rows, recordType) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 500) throw new HttpsError('invalid-argument', 'Provide between 1 and 500 rows.');
  const valid = [];
  const invalid = [];
  rows.forEach((raw, index) => {
    const row = raw && typeof raw === 'object' ? raw : {};
    const errors = [];
    if (recordType === 'people') {
      if (!clean(row.firstName)) errors.push('firstName is required');
      if (!clean(row.lastName)) errors.push('lastName is required');
      if (!clean(row.email) && !clean(row.phone)) errors.push('email or phone is required');
    } else {
      if (!clean(row.organization || row.name)) errors.push('organization is required');
    }
    const normalized = recordType === 'people' ? {
      firstName: clean(row.firstName), lastName: clean(row.lastName), fullName: [clean(row.firstName), clean(row.lastName)].filter(Boolean).join(' '), email: clean(row.email), emailNormalized: clean(row.email).toLowerCase(), phone: clean(row.phone), phoneNormalized: clean(row.phone).replace(/\D/g, ''), organizationName: clean(row.organizationName), stage: clean(row.stage) || 'New', archived: false,
    } : {
      organization: clean(row.organization || row.name), organizationNormalized: clean(row.organization || row.name).toLowerCase(), email: clean(row.email), phone: clean(row.phone), phoneNormalized: clean(row.phone).replace(/\D/g, ''), website: clean(row.website), industry: clean(row.industry), city: clean(row.city), province: clean(row.province), stage: clean(row.stage) || 'New', archived: false,
    };
    (errors.length ? invalid : valid).push({ index, row: normalized, errors });
  });
  return { valid, invalid };
}

async function validateCommandCsvImportService(request) {
  await actor(request);
  const recordType = clean(request.data?.recordType);
  if (!['people', 'organizations'].includes(recordType)) throw new HttpsError('invalid-argument', 'recordType must be people or organizations.');
  const result = validateCsvRows(request.data?.rows, recordType);
  return { ok: true, recordType, validCount: result.valid.length, invalidCount: result.invalid.length, invalidRows: result.invalid };
}

async function commitCommandCsvImportService(request) {
  const { db, uid, userRef, userData } = await actor(request);
  const recordType = clean(request.data?.recordType);
  if (!['people', 'organizations'].includes(recordType)) throw new HttpsError('invalid-argument', 'recordType must be people or organizations.');
  const result = validateCsvRows(request.data?.rows, recordType);
  if (result.invalid.length) throw new HttpsError('failed-precondition', 'Fix invalid rows before committing.', { invalidRows: result.invalid });
  const collection = recordType === 'people' ? PEOPLE : ORGANIZATIONS;
  const teamRepIds = [...new Set([clean(userData.repId), clean(userData.programDirectorRepId), clean(userData.directorRepId)].filter(Boolean))];
  let batch = db.batch();
  let operations = 0;
  const now = admin.firestore.FieldValue.serverTimestamp();
  for (const entry of result.valid) {
    const ref = db.collection(collection).doc();
    batch.create(ref, { ...entry.row, ownerUid: uid, ownerRef: userRef, ownerName: recordName(userData), viewerUids: [uid], teamRepIds, createdAt: now, createdByRef: userRef, updatedAt: now, updatedByRef: userRef });
    operations += 1;
    if (operations === 450) { await batch.commit(); batch = db.batch(); operations = 0; }
  }
  if (operations) await batch.commit();
  return { ok: true, committed: true, recordType, createdCount: result.valid.length };
}

async function syncCommandUserTeamAccessHandler() {
  const db = admin.firestore();
  const users = await db.collection('users').where('userType', '==', 'rep').get();
  const byRepId = new Map();
  users.docs.forEach((doc) => { const data = doc.data() || {}; if (data.active !== false && clean(data.repId)) byRepId.set(clean(data.repId), doc.id); });
  const collections = [PEOPLE, ORGANIZATIONS, THREADS, EXCHANGES, LIBRARY];
  let updated = 0;
  for (const collection of collections) {
    const snap = await db.collection(collection).limit(1000).get();
    let batch = db.batch(); let count = 0;
    for (const doc of snap.docs) {
      const data = doc.data() || {};
      const viewerUids = new Set([data.ownerUid].filter(Boolean));
      (data.teamRepIds || []).forEach((repId) => { const mapped = byRepId.get(clean(repId)); if (mapped) viewerUids.add(mapped); });
      batch.update(doc.ref, { viewerUids: [...viewerUids] }); count += 1; updated += 1;
      if (count === 450) { await batch.commit(); batch = db.batch(); count = 0; }
    }
    if (count) await batch.commit();
  }
  return { updated };
}

async function expireCommandExchangesHandler() {
  const db = admin.firestore();
  const now = admin.firestore.Timestamp.now();
  const snap = await db.collection(EXCHANGES).where('expiresAt', '<=', now).limit(500).get();
  let batch = db.batch(); let count = 0; let expired = 0;
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    if (!['draft', 'open', 'active'].includes(data.status)) continue;
    batch.update(doc.ref, { status: 'expired', expiredAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    count += 1; expired += 1;
    if (count === 450) { await batch.commit(); batch = db.batch(); count = 0; }
  }
  if (count) await batch.commit();
  return { expired };
}

module.exports = {
  createCommandLibraryFileService,
  archiveCommandLibraryFileService,
  restoreCommandLibraryFileService,
  getCommandExchangeItemAccessService,
  getPublicCommandExchangeHandler,
  preparePublicCommandExchangeUploadHandler,
  submitPublicCommandExchangeHandler,
  getPublicCommandExchangeItemAccessHandler,
  linkCommandEmailThreadToOrganizationService,
  unlinkCommandEmailThreadService,
  searchCommandRecordsService,
  validateCommandCsvImportService: require('./commandCsvImport').validateCommandCsvImportService,
  commitCommandCsvImportService: require('./commandCsvImport').commitCommandCsvImportService,
  syncCommandUserTeamAccessHandler,
  expireCommandExchangesHandler,
};
