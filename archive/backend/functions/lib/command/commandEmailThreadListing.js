'use strict';

const crypto = require('crypto');
const { HttpsError } = require('firebase-functions/v2/https');
const { isPlatformAdminUser } = require('./commandPersonUtils');

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function escapeFilter(value) {
  return clean(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function queryFingerprint({ searchQuery, mailboxView, unreadOnly }) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ searchQuery, mailboxView, unreadOnly }))
    .digest('hex')
    .slice(0, 16);
}

function encodePageToken(page, fingerprint) {
  return Buffer.from(
    JSON.stringify({ version: 1, page, fingerprint }),
    'utf8'
  ).toString('base64url');
}

function decodePageToken(rawToken, expectedFingerprint) {
  const token = clean(rawToken);
  if (!token) return 0;

  try {
    const parsed = JSON.parse(
      Buffer.from(token, 'base64url').toString('utf8')
    );
    if (
      parsed.version !== 1 ||
      !Number.isInteger(parsed.page) ||
      parsed.page < 0 ||
      parsed.fingerprint !== expectedFingerprint
    ) {
      throw new Error('Invalid token');
    }
    return parsed.page;
  } catch (_error) {
    throw new HttpsError(
      'invalid-argument',
      'The page token does not belong to this inbox view.'
    );
  }
}

function buildInboxFilters(uid, mailboxView, unreadOnly, platformAdmin = false) {
  if (platformAdmin && mailboxView === 'team' && unreadOnly) {
    throw new HttpsError(
      'invalid-argument',
      'Unread-only filtering is not supported for the all-sales-force inbox.'
    );
  }
  const safeUid = escapeFilter(uid);
  const filters = ['archived:false'];
  if (mailboxView === 'my') {
    filters.push(`viewerUids:"${safeUid}"`, `ownerUid:"${safeUid}"`);
  } else {
    if (!platformAdmin) filters.push(`viewerUids:"${safeUid}"`);
    filters.push(`NOT ownerUid:"${safeUid}"`);
  }

  if (unreadOnly) filters.push(`unreadBy:"${safeUid}"`);
  return filters.join(' AND ');
}

async function listCommandEmailThreadsPageService(request, credentials = {}) {
  const { requireEmailActor } = require('../commandEmail/emailAccess');
  const { INDEXES, getClient } = require('./commandAlgolia');
  const actor = await requireEmailActor(
    require('firebase-admin').firestore(),
    request
  );
  const data = request.data || {};
  const pageSize = Math.min(
    Math.max(Math.trunc(Number(data.pageSize)) || 25, 1),
    100
  );
  const searchQuery = clean(data.searchQuery);
  if (searchQuery.length === 1 || searchQuery.length > 100) {
    throw new HttpsError(
      'invalid-argument',
      'Inbox search must be empty or contain 2 to 100 characters.'
    );
  }

  const mailboxView = clean(data.mailboxView).toLowerCase() || 'my';
  if (!['my', 'team'].includes(mailboxView)) {
    throw new HttpsError(
      'invalid-argument',
      'mailboxView must be "my" or "team".'
    );
  }
  if (
    data.unreadOnly !== undefined &&
    typeof data.unreadOnly !== 'boolean'
  ) {
    throw new HttpsError(
      'invalid-argument',
      'unreadOnly must be a boolean.'
    );
  }
  const unreadOnly = data.unreadOnly === true;
  const platformAdmin = isPlatformAdminUser(actor.userData);
  const fingerprint = queryFingerprint({
    searchQuery,
    mailboxView,
    unreadOnly,
  });
  const page = decodePageToken(data.pageToken, fingerprint);
  const client = getClient(credentials.appId, credentials.adminKey);

  let result;
  try {
    result = await client.request(
      'POST',
      `/1/indexes/${encodeURIComponent(INDEXES.emailThreads)}/query`,
      {
        query: searchQuery,
        page,
        hitsPerPage: pageSize,
        filters: buildInboxFilters(actor.uid, mailboxView, unreadOnly, platformAdmin),
        attributesToRetrieve: ['objectID', 'id', 'path'],
        attributesToHighlight: [],
      },
      true
    );
  } catch (error) {
    throw new HttpsError(
      'internal',
      'The ExMail inbox could not be loaded.',
      { cause: String(error?.message || error).slice(0, 300) }
    );
  }

  const hits = Array.isArray(result.hits) ? result.hits : [];
  const records = hits
    .map((hit) => ({
      id: clean(hit.id || hit.objectID),
      path: clean(hit.path),
    }))
    .filter((record) => record.path.startsWith('commandEmailThreads/'));
  const totalRecords = Math.max(0, Number(result.nbHits) || 0);
  const algoliaPageCount = Math.max(0, Number(result.nbPages) || 0);
  const totalPages = Math.max(1, algoliaPageCount);
  const hasNextPage = page + 1 < algoliaPageCount;

  return {
    ok: true,
    result: 'success',
    recordType: 'emailThreads',
    mailboxView,
    unreadOnly,
    records,
    recordRefs: records.map((record) => record.path),
    pageSize,
    totalRecords,
    totalPages,
    hasNextPage,
    nextPageToken: hasNextPage
      ? encodePageToken(page + 1, fingerprint)
      : '',
  };
}

module.exports = {
  buildInboxFilters,
  decodePageToken,
  encodePageToken,
  listCommandEmailThreadsPageService,
  queryFingerprint,
};
