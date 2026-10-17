'use strict';

const admin = require('firebase-admin');
const { HttpsError } = require('firebase-functions/v2/https');
const {
  requireAuth,
  requireCommandAccess,
  isPlatformAdminUser,
} = require('./commandPersonUtils');
const { buildCommandAccessMetadata } = require('./commandAccessMetadata');

const LISTS_COLLECTION = 'commandLeadLists';
const RECORD_COLLECTIONS = Object.freeze({
  people: 'commandPeople',
  organizations: 'commandOrganizations',
  leads: 'commandLeads',
});
const MAX_RECORDS = 100;
const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 500;

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validateName(value) {
  const name = clean(value).replace(/\s+/g, ' ');
  if (!name) throw new HttpsError('invalid-argument', 'List name is required.');
  if (name.length > MAX_NAME_LENGTH) {
    throw new HttpsError('invalid-argument', `List name must be ${MAX_NAME_LENGTH} characters or fewer.`);
  }
  return name;
}

function validateDescription(value) {
  const description = clean(value);
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new HttpsError('invalid-argument', `List description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer.`);
  }
  return description;
}

function validateColor(value) {
  const color = clean(value);
  if (!color) return '';
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
    throw new HttpsError('invalid-argument', 'List color must use #RRGGBB format.');
  }
  return color.toUpperCase();
}

function listId(value) {
  const id = clean(value);
  if (!id || id.includes('/')) throw new HttpsError('invalid-argument', 'A valid leadListId is required.');
  return id;
}

function canAccess(data, uid, repId, platformAdmin = false) {
  return platformAdmin ||
    data.ownerUid === uid ||
    (Array.isArray(data.viewerUids) && data.viewerUids.includes(uid)) ||
    (repId && Array.isArray(data.teamRepIds) && data.teamRepIds.includes(repId));
}

async function actor(request) {
  const db = admin.firestore();
  const uid = requireAuth(request);
  const { userRef, userData } = await requireCommandAccess(db, uid);
  return {
    db,
    uid,
    userRef,
    userData,
    repId: clean(userData.repId),
    platformAdmin: isPlatformAdminUser(userData),
  };
}

async function resolveCommandLeadList(db, uid, userData, requestedId, options = {}) {
  const context = {
    db,
    uid,
    repId: clean(userData?.repId),
    platformAdmin: isPlatformAdminUser(userData || {}),
  };
  return getAccessibleList(context, requestedId, options);
}

async function getAccessibleList(context, requestedId, options = {}) {
  const ref = context.db.collection(LISTS_COLLECTION).doc(listId(requestedId));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'The selected List no longer exists.');
  const data = snap.data() || {};
  if (!canAccess(data, context.uid, context.repId, context.platformAdmin)) {
    throw new HttpsError('permission-denied', 'You do not have access to this List.');
  }
  if (options.requireActive !== false && data.archived === true) {
    throw new HttpsError('failed-precondition', 'The selected List is archived.');
  }
  return { ref, snap, data };
}

async function createCommandLeadListService(request) {
  const context = await actor(request);
  const name = validateName(request.data?.name);
  const description = validateDescription(request.data?.description);
  const color = validateColor(request.data?.color);
  const access = await buildCommandAccessMetadata(context.db, {
    actorRef: context.userRef,
    ownerRef: context.userRef,
    assignedToRef: context.userRef,
  });
  const ref = context.db.collection(LISTS_COLLECTION).doc();
  const now = admin.firestore.FieldValue.serverTimestamp();
  await ref.create({
    name,
    nameNormalized: name.toLowerCase(),
    description,
    color,
    archived: false,
    ...access,
    createdAt: now,
    createdByRef: context.userRef,
    updatedAt: now,
    updatedByRef: context.userRef,
  });
  return { ok: true, leadListId: ref.id, leadListPath: ref.path, name, description, color, archived: false };
}

async function listCommandLeadListsService(request) {
  const context = await actor(request);
  const includeArchived = request.data?.includeArchived === true;
  let query = context.db.collection(LISTS_COLLECTION);
  if (!context.platformAdmin) {
    query = context.repId
      ? query.where('teamRepIds', 'array-contains', context.repId)
      : query.where('viewerUids', 'array-contains', context.uid);
  }
  const snap = await query.get();
  const lists = snap.docs
    .map((doc) => ({ id: doc.id, ...(doc.data() || {}) }))
    .filter((item) => includeArchived || item.archived !== true)
    .sort((a, b) => clean(a.name).localeCompare(clean(b.name)))
    .map((item) => ({
      leadListId: item.id,
      name: clean(item.name),
      description: clean(item.description),
      color: clean(item.color),
      archived: item.archived === true,
      ownerUid: clean(item.ownerUid),
      ownerName: clean(item.ownerName),
    }));
  return { ok: true, lists };
}

async function propagateListName(db, id, name, userRef) {
  let updatedCount = 0;
  for (const collection of Object.values(RECORD_COLLECTIONS)) {
    let cursor = null;
    while (true) {
      let query = db.collection(collection)
        .where('leadListId', '==', id)
        .orderBy(admin.firestore.FieldPath.documentId())
        .limit(400);
      if (cursor) query = query.startAfter(cursor);
      const snap = await query.get();
      if (!snap.docs.length) break;
      const pending = snap.docs.filter((doc) => clean(doc.data()?.leadListName) !== name);
      if (pending.length) {
        const batch = db.batch();
        const now = admin.firestore.FieldValue.serverTimestamp();
        for (const doc of pending) {
          batch.update(doc.ref, { leadListName: name, updatedAt: now, updatedByRef: userRef });
        }
        await batch.commit();
        updatedCount += pending.length;
      }
      cursor = snap.docs[snap.docs.length - 1];
      if (snap.docs.length < 400) break;
    }
  }
  return updatedCount;
}

async function updateCommandLeadListService(request) {
  const context = await actor(request);
  const selected = await getAccessibleList(context, request.data?.leadListId, { requireActive: false });
  if (selected.data.archived === true) {
    throw new HttpsError('failed-precondition', 'Archived Lists cannot be edited.');
  }
  const updates = {};
  if (request.data?.name !== undefined) updates.name = validateName(request.data.name);
  if (request.data?.description !== undefined) updates.description = validateDescription(request.data.description);
  if (request.data?.color !== undefined) updates.color = validateColor(request.data.color);
  if (!Object.keys(updates).length) throw new HttpsError('invalid-argument', 'Provide at least one List field to update.');
  if (updates.name) updates.nameNormalized = updates.name.toLowerCase();
  updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
  updates.updatedByRef = context.userRef;
  await selected.ref.update(updates);
  const updatedRecords = updates.name
    ? await propagateListName(context.db, selected.ref.id, updates.name, context.userRef)
    : 0;
  return { ok: true, leadListId: selected.ref.id, updatedRecords };
}

async function archiveCommandLeadListService(request) {
  const context = await actor(request);
  const selected = await getAccessibleList(context, request.data?.leadListId, { requireActive: false });
  if (selected.data.archived !== true) {
    await selected.ref.update({
      archived: true,
      archivedAt: admin.firestore.FieldValue.serverTimestamp(),
      archivedByRef: context.userRef,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedByRef: context.userRef,
    });
  }
  return { ok: true, leadListId: selected.ref.id, archived: true };
}

function validateRecordPaths(recordType, rawPaths) {
  const collection = RECORD_COLLECTIONS[clean(recordType)];
  if (!collection) throw new HttpsError('invalid-argument', 'recordType must be people, organizations, or leads.');
  if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
    throw new HttpsError('invalid-argument', 'recordRefPaths must contain at least one record.');
  }
  const paths = [...new Set(rawPaths.map(clean))];
  if (paths.length > MAX_RECORDS) {
    throw new HttpsError('invalid-argument', `A maximum of ${MAX_RECORDS} records can be updated at once.`);
  }
  if (paths.some((path) => {
    const parts = path.split('/').filter(Boolean);
    return parts.length !== 2 || parts[0] !== collection;
  })) {
    throw new HttpsError('invalid-argument', `Every record reference must use ${collection}/{documentId}.`);
  }
  return paths;
}

async function assignCommandLeadListService(request) {
  const context = await actor(request);
  const recordType = clean(request.data?.recordType);
  const paths = validateRecordPaths(recordType, request.data?.recordRefPaths);
  const requestedListId = clean(request.data?.leadListId);
  const selected = requestedListId
    ? await getAccessibleList(context, requestedListId)
    : null;
  const refs = paths.map((path) => context.db.doc(path));
  const snaps = await context.db.getAll(...refs);
  const missing = snaps.filter((snap) => !snap.exists).map((snap) => snap.ref.path);
  if (missing.length) {
    throw new HttpsError('not-found', 'One or more selected records no longer exist.', { missingPaths: missing });
  }
  const denied = snaps
    .filter((snap) => !canAccess(snap.data() || {}, context.uid, context.repId, context.platformAdmin))
    .map((snap) => snap.ref.path);
  if (denied.length) {
    throw new HttpsError('permission-denied', 'You do not have access to update every selected record.', { deniedPaths: denied });
  }
  const batch = context.db.batch();
  const now = admin.firestore.FieldValue.serverTimestamp();
  for (const snap of snaps) {
    batch.update(snap.ref, selected ? {
      leadListId: selected.ref.id,
      leadListName: clean(selected.data.name),
      updatedAt: now,
      updatedByRef: context.userRef,
    } : {
      leadListId: admin.firestore.FieldValue.delete(),
      leadListName: admin.firestore.FieldValue.delete(),
      updatedAt: now,
      updatedByRef: context.userRef,
    });
  }
  await batch.commit();
  return {
    ok: true,
    recordType,
    updatedCount: snaps.length,
    leadListId: selected?.ref.id || '',
    leadListName: clean(selected?.data?.name),
  };
}

module.exports = {
  LISTS_COLLECTION,
  createCommandLeadListService,
  listCommandLeadListsService,
  updateCommandLeadListService,
  archiveCommandLeadListService,
  assignCommandLeadListService,
  resolveCommandLeadList,
  _test: { clean, canAccess, validateName, validateDescription, validateColor, validateRecordPaths, propagateListName },
};
