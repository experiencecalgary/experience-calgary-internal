'use strict';

const admin = require('firebase-admin');
const { HttpsError } = require('firebase-functions/v2/https');
const { requireAuth, requireCommandAccess, isPlatformAdminUser } = require('./commandPersonUtils');
const { INDEXES, TYPE_ORDER, getClient, multiSearch, accessFilter, ensureIndexSettings } = require('./commandAlgolia');

function clean(value) { return typeof value === 'string' ? value.trim() : ''; }
function escapeFilter(value) { return clean(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }

async function actor(request) {
  const db = admin.firestore();
  const uid = requireAuth(request);
  const access = await requireCommandAccess(db, uid);
  return { uid, userData: access.userData || {} };
}

function selectedTypes(rawTypes) {
  if (!Array.isArray(rawTypes) || rawTypes.length === 0) return TYPE_ORDER;
  const unique = [...new Set(rawTypes.map(clean).filter((type) => TYPE_ORDER.includes(type)))];
  if (!unique.length) throw new HttpsError('invalid-argument', 'No supported search types were provided.');
  return unique;
}

function normalizeHit(type, hit = {}) {
  const base = {
    type,
    id: clean(hit.id || hit.objectID),
    path: clean(hit.path),
    parentPath: clean(hit.parentPath),
    title: clean(hit.title),
    subtitle: clean(hit.subtitle),
    archived: hit.archived === true,
    createdAt: hit.createdAt || null,
    updatedAt: hit.updatedAt || null,
    highlights: hit._highlightResult || null,
  };

  if (type === 'people') {
    return {
      ...base,
      email: clean(hit.email).toLowerCase(),
      organizationName: clean(hit.organizationName),
      stage: clean(hit.stage),
      assignedToName: clean(hit.assignedToName),
    };
  }

  if (type === 'organizations') {
    return {
      ...base,
      email: clean(hit.email).toLowerCase(),
      city: clean(hit.city),
      province: clean(hit.province),
      stage: clean(hit.stage),
      assignedToName: clean(hit.assignedToName),
    };
  }

  return base;
}

const PLATFORM_ADMIN_TEAM_SEARCH_TYPES = Object.freeze([
  'people',
  'organizations',
  'actions',
  'connections',
]);

function filterFor(type, uid, userData) {
  if (
    isPlatformAdminUser(userData) &&
    PLATFORM_ADMIN_TEAM_SEARCH_TYPES.includes(type)
  ) {
    return 'archived:false';
  }
  const repId = escapeFilter(userData.repId);
  const uidFilter = accessFilter(uid);
  if (['people', 'organizations', 'actions', 'connections'].includes(type) && repId) return `(teamRepIds:"${repId}" OR ${uidFilter}) AND archived:false`;
  return `(${uidFilter}) AND archived:false`;
}

async function searchCommandRecordsService(request, credentials = {}) {
  const { uid, userData } = await actor(request);
  const query = clean(request.data?.query);
  if (query.length < 2 || query.length > 100) throw new HttpsError('invalid-argument', 'Search must contain 2 to 100 characters.');
  const types = selectedTypes(request.data?.types);
  const limitPerType = Math.min(Math.max(Number(request.data?.limitPerType || request.data?.limit) || 5, 1), 20);
  const client = getClient(credentials.appId, credentials.adminKey);
  const response = await multiSearch(client, types.map((type) => ({
    indexName: INDEXES[type], query, hitsPerPage: limitPerType, page: 0,
    filters: filterFor(type, uid, userData),
    attributesToRetrieve: 'objectID,id,path,parentPath,title,subtitle,archived,createdAt,updatedAt,email,organizationName,city,province,stage,assignedToName',
    attributesToHighlight: 'title,subtitle', highlightPreTag: '<mark>', highlightPostTag: '</mark>',
  })));
  const groups = {}; const totals = {}; let totalResults = 0;
  types.forEach((type, index) => {
    const result = response.results?.[index] || {};
    groups[type] = Array.isArray(result.hits) ? result.hits.map((hit) => normalizeHit(type, hit)) : [];
    totals[type] = Number(result.nbHits || 0); totalResults += totals[type];
  });
  return { ok: true, result: 'success', query, types, groups, totals, totalResults, limitPerType };
}

async function configureCommandSearchIndexesService(request, credentials = {}) {
  await actor(request);
  const types = selectedTypes(request.data?.types);
  const client = getClient(credentials.appId, credentials.adminKey);
  await ensureIndexSettings(client, types);
  const teamTypes = types.filter((type) => ['people', 'organizations', 'actions', 'connections'].includes(type));
  await Promise.all(teamTypes.map((type) => client.request('PUT', `/1/indexes/${encodeURIComponent(INDEXES[type])}/settings`, {
    attributesForFaceting: [
      'filterOnly(ownerUid)', 'filterOnly(viewerUids)', 'filterOnly(teamRepIds)', 'filterOnly(archived)',
      ...(type === 'people' || type === 'organizations' ? ['filterOnly(stage)', 'filterOnly(assignedToUid)', 'filterOnly(leadListId)'] : []),
      ...(type === 'actions' ? ['filterOnly(status)', 'filterOnly(priority)', 'filterOnly(relatedType)'] : []),
      ...(type === 'connections' ? ['filterOnly(connectionType)'] : []),
    ],
  })));
  return { ok: true, result: 'success', configuredIndexes: types.map((type) => INDEXES[type]) };
}

module.exports = {
  searchCommandRecordsService,
  configureCommandSearchIndexesService,
  _test: { filterFor, PLATFORM_ADMIN_TEAM_SEARCH_TYPES },
};
