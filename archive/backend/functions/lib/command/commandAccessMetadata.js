'use strict';

const admin = require('firebase-admin');

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function displayName(data = {}) {
  return clean(data.fullName) ||
    [clean(data.firstName), clean(data.lastName)].filter(Boolean).join(' ') ||
    clean(data.displayName) ||
    clean(data.name) ||
    clean(data.email);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

async function readUser(db, ref) {
  if (!ref || ref.parent?.id !== 'users') return null;
  const snap = await ref.get();
  if (!snap.exists) return null;
  return { ref, uid: ref.id, data: snap.data() || {} };
}

async function usersByRepIds(db, repIds) {
  const ids = unique(repIds.map(clean));
  if (!ids.length) return [];
  const snap = await db.collection('users').where('repId', 'in', ids.slice(0, 10)).get();
  return snap.docs
    .filter((doc) => doc.data()?.active !== false)
    .map((doc) => ({ ref: doc.ref, uid: doc.id, data: doc.data() || {} }));
}

async function buildCommandAccessMetadata(db, options = {}) {
  const actorRef = options.actorRef || null;
  const ownerRef = options.ownerRef || actorRef;
  const assignedToRef = options.assignedToRef || null;

  const directUsers = [];
  for (const ref of unique([ownerRef, assignedToRef, actorRef])) {
    const user = await readUser(db, ref);
    if (user) directUsers.push(user);
  }

  const hierarchyRepIds = [];
  for (const user of directUsers) {
    hierarchyRepIds.push(
      clean(user.data.repId),
      clean(user.data.programDirectorRepId),
      clean(user.data.directorRepId)
    );
  }

  const hierarchyUsers = await usersByRepIds(db, hierarchyRepIds);
  const allUsers = new Map();
  [...directUsers, ...hierarchyUsers].forEach((user) => allUsers.set(user.uid, user));

  const ownerUser = directUsers.find((user) => user.ref.path === ownerRef?.path) || null;
  const assignedUser = directUsers.find((user) => user.ref.path === assignedToRef?.path) || null;

  return {
    ownerRef: ownerRef || null,
    ownerUid: ownerUser?.uid || ownerRef?.id || '',
    ownerName: ownerUser ? displayName(ownerUser.data) : '',
    assignedToRef: assignedToRef || null,
    assignedToUid: assignedUser?.uid || assignedToRef?.id || '',
    assignedToName: assignedUser ? displayName(assignedUser.data) : '',
    teamRepIds: unique([
      ...hierarchyRepIds,
      ...[...allUsers.values()].map((user) => clean(user.data.repId)),
    ]),
    viewerUids: unique([...allUsers.keys()]),
  };
}

function sameStringArray(a, b) {
  const left = Array.isArray(a) ? [...a].sort() : [];
  const right = Array.isArray(b) ? [...b].sort() : [];
  return JSON.stringify(left) === JSON.stringify(right);
}

function accessMetadataNeedsUpdate(data = {}, access = {}) {
  return data.ownerRef?.path !== access.ownerRef?.path ||
    clean(data.ownerUid) !== clean(access.ownerUid) ||
    clean(data.ownerName) !== clean(access.ownerName) ||
    data.assignedToRef?.path !== access.assignedToRef?.path ||
    clean(data.assignedToUid) !== clean(access.assignedToUid) ||
    clean(data.assignedToName) !== clean(access.assignedToName) ||
    !sameStringArray(data.teamRepIds, access.teamRepIds) ||
    !sameStringArray(data.viewerUids, access.viewerUids);
}

function accessUpdatePayload(access) {
  return {
    ownerRef: access.ownerRef || null,
    ownerUid: access.ownerUid || '',
    ownerName: access.ownerName || '',
    assignedToRef: access.assignedToRef || null,
    assignedToUid: access.assignedToUid || '',
    assignedToName: access.assignedToName || '',
    teamRepIds: access.teamRepIds || [],
    viewerUids: access.viewerUids || [],
    accessUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

module.exports = {
  buildCommandAccessMetadata,
  accessMetadataNeedsUpdate,
  accessUpdatePayload,
};
