'use strict';

const admin = require('firebase-admin');
const { HttpsError } = require('firebase-functions/v2/https');
const { requireAuth, requireCommandAccess, isPlatformAdminUser } = require('./commandPersonUtils');
const { INDEXES, getClient } = require('./commandAlgolia');

const DEFINITIONS = Object.freeze({
  people: { collection: 'commandPeople', access: 'team', defaultSort: 'updatedAt', sorts: ['fullName', 'createdAt', 'updatedAt', 'stage', 'estimatedValue'], friendlySorts: { name: 'fullName', updated: 'updatedAt', created: 'createdAt', stage: 'stage', value: 'estimatedValue' }, filters: { stage: ['==', 'string'], assignedToUid: ['==', 'string'], leadListId: ['==', 'string'], archived: ['==', 'boolean'] } },
  organizations: { collection: 'commandOrganizations', access: 'team', defaultSort: 'updatedAt', sorts: ['organization', 'name', 'createdAt', 'updatedAt', 'stage', 'estimatedValue'], friendlySorts: { name: 'organization', updated: 'updatedAt', created: 'createdAt', stage: 'stage', value: 'estimatedValue' }, filters: { stage: ['==', 'string'], assignedToUid: ['==', 'string'], leadListId: ['==', 'string'], archived: ['==', 'boolean'] } },
  actions: { collection: 'commandActions', access: 'team', defaultSort: 'updatedAt', sorts: ['title', 'createdAt', 'updatedAt', 'dueAt', 'status', 'priority'], filters: { status: ['==', 'string'], priority: ['==', 'string'], relatedType: ['==', 'string'], ownerUid: ['==', 'string'], assignedToUid: ['==', 'string'], archived: ['==', 'boolean'] } },
  connections: { collection: 'commandConnections', access: 'team', defaultSort: 'createdAt', sorts: ['createdAt', 'type', 'ownerName'], filters: { type: ['==', 'string'], ownerUid: ['==', 'string'], archived: ['==', 'boolean'] } },
  emailThreads: { collection: 'commandEmailThreads', access: 'viewer', defaultSort: 'lastMessageAt', sorts: ['lastMessageAt', 'createdAt', 'updatedAt', 'subject'], friendlySorts: { newest: 'lastMessageAt', oldest: 'lastMessageAt', subject: 'subject' }, filters: { ownerUid: ['==', 'string'], archived: ['==', 'boolean'] } },
  libraryFiles: { collection: 'commandLibraryFiles', access: 'owner', defaultSort: 'updatedAt', sorts: ['fileName', 'createdAt', 'updatedAt', 'sizeBytes'], filters: { visibility: ['==', 'string'], uploadStatus: ['==', 'string'], archived: ['==', 'boolean'] } },
  emailMessages: { nested: true, parentCollection: 'commandEmailThreads', subcollection: 'emailMessages', defaultSort: 'createdAt', sorts: ['createdAt', 'direction', 'status'], filters: { direction: ['==', 'string'], status: ['==', 'string'] } },
});

function clean(value) { return typeof value === 'string' ? value.trim() : ''; }
function validId(value, name) { const id = clean(value); if (!id || id.includes('/')) throw new HttpsError('invalid-argument', `A valid ${name} is required.`); return id; }
function normalizeFilterValue(value, kind, field) { if (kind === 'boolean') { if (typeof value !== 'boolean') throw new HttpsError('invalid-argument', `${field} must be a boolean.`); return value; } return clean(value) || null; }
function serialize(value) { if (value === null || value === undefined) return null; if (typeof value?.toDate === 'function') return value.toDate().toISOString(); if (value?.path) return value.path; if (Array.isArray(value)) return value.map(serialize); if (typeof value === 'object') { const output = {}; for (const [key, child] of Object.entries(value)) output[key] = serialize(child); return output; } return value; }
function escapeAlgolia(value) { return clean(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }

async function actor(request) {
  const db = admin.firestore();
  const uid = requireAuth(request);
  const access = await requireCommandAccess(db, uid);
  return { db, uid, userData: access.userData || {} };
}

function platformAdminBypassesListingAccess(definition, userData) {
  return isPlatformAdminUser(userData) && definition.access === 'team';
}

async function collectionFor(db, uid, userData, definition, requestData) {
  if (!definition.nested) {
    let query = db.collection(definition.collection);
    if (platformAdminBypassesListingAccess(definition, userData)) {
      // Platform Admin represents the entire sales force, not a hierarchy node.
    } else if (definition.access === 'team') {
      const repId = clean(userData.repId);
      query = repId ? query.where('teamRepIds', 'array-contains', repId) : query.where('viewerUids', 'array-contains', uid);
    } else if (definition.access === 'viewer') {
      query = query.where('viewerUids', 'array-contains', uid);
    } else {
      query = query.where('ownerUid', '==', uid);
    }
    return { query, expectedTokenPrefix: `${definition.collection}/` };
  }

  const parentId = validId(requestData.parentId, 'parentId');
  const parentRef = db.collection(definition.parentCollection).doc(parentId);
  const parentSnap = await parentRef.get();
  if (!parentSnap.exists) throw new HttpsError('not-found', 'The parent email thread does not exist.');
  const parent = parentSnap.data() || {};
  const allowed = parent.ownerUid === uid || Array.isArray(parent.viewerUids) && parent.viewerUids.includes(uid);
  if (!allowed) throw new HttpsError('permission-denied', 'You do not have access to this email thread.');
  return { query: parentRef.collection(definition.subcollection), expectedTokenPrefix: `${parentRef.path}/${definition.subcollection}/` };
}

function requestedFilters(data, definition) {
  const filters = data.filters && typeof data.filters === 'object' && !Array.isArray(data.filters) ? { ...data.filters } : {};
  for (const field of Object.keys(definition.filters)) {
    if (data[field] !== undefined) filters[field] = data[field];
  }
  if (['commandPeople', 'commandOrganizations'].includes(definition.collection) && filters.archived === undefined) {
    filters.archived = false;
  }
  if (data.assignedToRefPath !== undefined && filters.assignedToUid === undefined) {
    const path = clean(data.assignedToRefPath);
    if (path) {
      const parts = path.split('/').filter(Boolean);
      if (parts.length !== 2 || parts[0] !== 'users') throw new HttpsError('invalid-argument', 'assignedToRefPath must use users/{documentId}.');
      filters.assignedToUid = parts[1];
    }
  }
  return filters;
}

function applyFilters(query, definition, filters) {
  let result = query;
  for (const [field, value] of Object.entries(filters)) {
    const rule = definition.filters[field];
    if (!rule) throw new HttpsError('invalid-argument', `Unsupported filter for this record type: ${field}`);
    const normalized = normalizeFilterValue(value, rule[1], field);
    if (normalized !== null) result = result.where(field, rule[0], normalized);
  }
  return result;
}

function resolveSort(data, definition) {
  const friendly = clean(data.sortBy);
  const sortField = friendly ? definition.friendlySorts?.[friendly] : clean(data.sortField) || definition.defaultSort;
  if (!sortField || !definition.sorts.includes(sortField)) throw new HttpsError('invalid-argument', 'Unsupported sort for this record type.');
  let direction = clean(data.sortDirection).toLowerCase() === 'asc' ? 'asc' : 'desc';
  if (friendly === 'name' || friendly === 'subject') direction = clean(data.sortDirection) ? direction : 'asc';
  if (friendly === 'oldest') direction = 'asc';
  if (friendly === 'newest') direction = 'desc';
  return { sortField, sortDirection: direction };
}

async function listAlgoliaRecordPage({ request, uid, userData, pageSize, filters, credentials, recordType }) {
  const query = clean(request.data?.searchQuery);
  if (query.length < 2 || query.length > 100) throw new HttpsError('invalid-argument', 'Page search must contain 2 to 100 characters.');
  const token = clean(request.data?.pageToken);
  let page = 0;
  if (token) {
    const match = new RegExp(`^algolia:${recordType}:(\\d+)$`).exec(token);
    if (!match) throw new HttpsError('invalid-argument', 'The page token does not belong to this search.');
    page = Number(match[1]);
  }

  const clauses = [];
  const repId = clean(userData.repId);
  const uidValue = escapeAlgolia(uid);
  if (!isPlatformAdminUser(userData)) clauses.push(repId ? `(teamRepIds:"${escapeAlgolia(repId)}" OR ownerUid:"${uidValue}" OR viewerUids:"${uidValue}")` : `(ownerUid:"${uidValue}" OR viewerUids:"${uidValue}")`);
  const archived = filters.archived === undefined ? false : normalizeFilterValue(filters.archived, 'boolean', 'archived');
  clauses.push(`archived:${archived ? 'true' : 'false'}`);
  if (filters.stage !== undefined && clean(filters.stage)) clauses.push(`stage:"${escapeAlgolia(filters.stage)}"`);
  if (filters.assignedToUid !== undefined && clean(filters.assignedToUid)) clauses.push(`assignedToUid:"${escapeAlgolia(filters.assignedToUid)}"`);
  if (filters.leadListId !== undefined && clean(filters.leadListId)) clauses.push(`leadListId:"${escapeAlgolia(filters.leadListId)}"`);

  const client = getClient(credentials.appId, credentials.adminKey);
  const result = await client.request('POST', `/1/indexes/${encodeURIComponent(INDEXES[recordType])}/query`, {
    query,
    page,
    hitsPerPage: pageSize,
    filters: clauses.join(' AND '),
    attributesToRetrieve: ['objectID', 'id', 'path'],
    attributesToHighlight: [],
  }, true);
  const hits = Array.isArray(result.hits) ? result.hits : [];
  const records = hits.map((hit) => ({ id: clean(hit.id || hit.objectID), path: clean(hit.path) })).filter((record) => record.path);
  const totalRecords = Number(result.nbHits || 0);
  const totalPages = Math.max(1, Number(result.nbPages || Math.ceil(totalRecords / pageSize)));
  const hasNextPage = page + 1 < Number(result.nbPages || 0);
  return { ok: true, result: 'success', recordType, records, recordRefs: records.map((record) => record.path), pageSize, totalRecords, totalPages, hasNextPage, nextPageToken: hasNextPage ? `algolia:${recordType}:${page + 1}` : '' };
}

function comparable(value) {
  if (value === null || value === undefined) return '';
  if (typeof value?.toMillis === 'function') return value.toMillis();
  if (typeof value === 'number') return value;
  return clean(String(value)).toLowerCase();
}

async function listLeadListRecordPage({ db, uid, userData, definition, recordType, filters, sortField, sortDirection, pageSize, pageToken, searchQuery }) {
  const leadListId = clean(filters.leadListId);
  const snapshot = await db.collection(definition.collection)
    .where('leadListId', '==', leadListId)
    .get();
  const repId = clean(userData.repId);
  const platformAdmin = isPlatformAdminUser(userData);
  const rows = snapshot.docs.filter((doc) => {
    const data = doc.data() || {};
    const accessible = platformAdmin ||
      data.ownerUid === uid ||
      (Array.isArray(data.viewerUids) && data.viewerUids.includes(uid)) ||
      (repId && Array.isArray(data.teamRepIds) && data.teamRepIds.includes(repId));
    if (!accessible) return false;
    const search = clean(searchQuery).toLowerCase();
    if (search) {
      const searchable = recordType === 'people'
        ? [data.fullName, data.firstName, data.lastName, data.email, data.phone, data.organizationName]
        : [data.organization, data.name, data.email, data.phone, data.website, data.industry, data.city, data.province];
      if (!searchable.some((value) => clean(String(value || '')).toLowerCase().includes(search))) return false;
    }
    if (filters.archived !== undefined && data.archived !== filters.archived) return false;
    if (clean(filters.stage) && clean(data.stage) !== clean(filters.stage)) return false;
    if (clean(filters.assignedToUid) && clean(data.assignedToUid) !== clean(filters.assignedToUid)) return false;
    return true;
  });
  const multiplier = sortDirection === 'asc' ? 1 : -1;
  rows.sort((left, right) => {
    const a = comparable(left.data()?.[sortField]);
    const b = comparable(right.data()?.[sortField]);
    if (a < b) return -1 * multiplier;
    if (a > b) return 1 * multiplier;
    return left.id.localeCompare(right.id) * multiplier;
  });
  const tokenPrefix = `leadList:${recordType}:${leadListId}:`;
  let offset = 0;
  if (pageToken) {
    if (!pageToken.startsWith(tokenPrefix)) throw new HttpsError('invalid-argument', 'The page token does not belong to this List.');
    offset = Number(pageToken.slice(tokenPrefix.length));
    if (!Number.isInteger(offset) || offset < 0) throw new HttpsError('invalid-argument', 'The List page token is invalid.');
  }
  const visibleDocs = rows.slice(offset, offset + pageSize);
  const nextOffset = offset + visibleDocs.length;
  const hasNextPage = nextOffset < rows.length;
  const records = visibleDocs.map((doc) => ({ id: doc.id, path: doc.ref.path, data: serialize(doc.data() || {}) }));
  return {
    ok: true,
    result: 'success',
    recordType,
    records,
    recordRefs: records.map((record) => record.path),
    pageSize,
    totalRecords: rows.length,
    totalPages: Math.max(1, Math.ceil(rows.length / pageSize)),
    hasNextPage,
    nextPageToken: hasNextPage ? `${tokenPrefix}${nextOffset}` : '',
  };
}

async function listCommandRecordsPageService(request, credentials = {}) {
  const { db, uid, userData } = await actor(request);
  const data = request.data || {};
  const recordType = clean(data.recordType);
  const definition = DEFINITIONS[recordType];
  if (!definition) throw new HttpsError('invalid-argument', 'Unsupported recordType.');
  const pageSize = Math.min(Math.max(Number(data.pageSize) || 25, 1), 100);
  const filters = requestedFilters(data, definition);
  const searchQuery = clean(data.searchQuery);

  if (searchQuery && !['people', 'organizations'].includes(recordType)) {
    throw new HttpsError('invalid-argument', 'Page search is supported for People and Organizations only.');
  }

  const { sortField, sortDirection } = resolveSort(data, definition);
  if (clean(filters.leadListId) && ['people', 'organizations'].includes(recordType)) {
    return listLeadListRecordPage({
      db,
      uid,
      userData,
      definition,
      recordType,
      filters,
      sortField,
      sortDirection,
      pageSize,
      pageToken: clean(data.pageToken),
      searchQuery,
    });
  }
  if (searchQuery) {
    return listAlgoliaRecordPage({ request, uid, userData, pageSize, filters, credentials, recordType });
  }
  const source = await collectionFor(db, uid, userData, definition, data);
  const baseQuery = applyFilters(source.query, definition, filters);
  const countSnapshot = await baseQuery.count().get();
  const totalRecords = Number(countSnapshot.data().count || 0);
  const totalPages = Math.max(1, Math.ceil(totalRecords / pageSize));

  let pageQuery = baseQuery.orderBy(sortField, sortDirection).orderBy(admin.firestore.FieldPath.documentId(), sortDirection);
  const pageToken = clean(data.pageToken);
  if (pageToken) {
    if (!pageToken.startsWith(source.expectedTokenPrefix)) throw new HttpsError('invalid-argument', 'The page token does not belong to this record list.');
    const tokenSnap = await db.doc(pageToken).get();
    if (!tokenSnap.exists) throw new HttpsError('invalid-argument', 'The page token is no longer valid.');
    pageQuery = pageQuery.startAfter(tokenSnap);
  }

  const snapshot = await pageQuery.limit(pageSize + 1).get();
  const hasNextPage = snapshot.docs.length > pageSize;
  const visibleDocs = snapshot.docs.slice(0, pageSize);
  const records = visibleDocs.map((doc) => ({ id: doc.id, path: doc.ref.path, data: serialize(doc.data() || {}) }));
  const last = visibleDocs[visibleDocs.length - 1];
  return { ok: true, result: 'success', recordType, records, recordRefs: records.map((record) => record.path), pageSize, totalRecords, totalPages, hasNextPage, nextPageToken: hasNextPage && last ? last.ref.path : '' };
}

module.exports = {
  DEFINITIONS,
  listCommandRecordsPageService,
  _test: { platformAdminBypassesListingAccess, listLeadListRecordPage },
};
