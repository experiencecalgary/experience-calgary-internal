'use strict';

const INDEXES = Object.freeze({
  people: 'command_people',
  organizations: 'command_organizations',
  actions: 'command_actions',
  connections: 'command_connections',
  emailThreads: 'command_email_threads',
  emailMessages: 'command_email_messages',
  libraryFiles: 'command_library_files',
});

const TYPE_ORDER = Object.freeze([
  'people',
  'organizations',
  'actions',
  'connections',
  'emailThreads',
  'emailMessages',
  'libraryFiles',
]);

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function scalar(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value?.toMillis === 'function') return Math.floor(value.toMillis() / 1000);
  if (value?.path) return value.path;
  return null;
}

function stringArray(value) {
  return Array.isArray(value) ? [...new Set(value.map(clean).filter(Boolean))] : [];
}

function referencePath(value) {
  return clean(value?.path);
}

function titleFor(type, data = {}) {
  if (type === 'people') return clean(data.fullName) || [clean(data.firstName), clean(data.lastName)].filter(Boolean).join(' ');
  if (type === 'organizations') return clean(data.organization || data.name);
  if (type === 'actions') return clean(data.title) || 'Action';
  if (type === 'connections') return clean(data.summary || data.title) || 'Connection';
  if (type === 'emailThreads') return clean(data.subject) || 'Email thread';
  if (type === 'emailMessages') return clean(data.subject) || clean(data.bodyText).slice(0, 90) || 'Email message';
  if (type === 'libraryFiles') return clean(data.fileName) || 'Document';
  return '';
}

function subtitleFor(type, data = {}) {
  if (type === 'people') return clean(data.organizationName || data.email || data.phone);
  if (type === 'organizations') return clean(data.email || data.phone || data.city);
  if (type === 'actions') return clean(data.personName || data.organizationName || data.ownerName);
  if (type === 'connections') return clean(data.personName || data.organizationName || data.ownerName);
  if (type === 'emailThreads') return clean(data.personName || data.organizationName || data.senderEmail || data.ownerName);
  if (type === 'emailMessages') return clean(data.fromAddress || data.toAddress || data.direction);
  if (type === 'libraryFiles') return clean(data.ownerName || data.contentType);
  return '';
}

function baseRecord(type, docId, path, data = {}, parentPath = '') {
  return {
    objectID: docId,
    type,
    id: docId,
    path,
    parentPath,
    title: titleFor(type, data),
    subtitle: subtitleFor(type, data),
    ownerUid: clean(data.ownerUid),
    viewerUids: stringArray(data.viewerUids),
    teamRepIds: stringArray(data.teamRepIds),
    archived: data.archived === true,
    createdAt: scalar(data.createdAt),
    updatedAt: scalar(data.updatedAt),
  };
}

function buildAlgoliaRecord(type, docId, path, data = {}, parentPath = '') {
  const base = baseRecord(type, docId, path, data, parentPath);
  const records = {
    people: {
      ...base,
      firstName: clean(data.firstName),
      lastName: clean(data.lastName),
      fullName: clean(data.fullName),
      email: clean(data.email),
      emails: stringArray([
        data.email,
        ...(Array.isArray(data.additionalEmails) ? data.additionalEmails : []),
      ]),
      phone: clean(data.phone),
      organizationName: clean(data.organizationName),
      stage: clean(data.stage),
      assignedToUid: clean(data.assignedToUid),
      assignedToName: clean(data.assignedToName),
      estimatedValue: Number(data.estimatedValue) || 0,
      leadListId: clean(data.leadListId),
      leadListName: clean(data.leadListName),
    },
    organizations: {
      ...base,
      organization: clean(data.organization || data.name),
      email: clean(data.email),
      emails: stringArray([
        data.email,
        ...(Array.isArray(data.additionalEmails) ? data.additionalEmails : []),
      ]),
      phone: clean(data.phone),
      website: clean(data.website),
      industry: clean(data.industry),
      city: clean(data.city),
      province: clean(data.province),
      stage: clean(data.stage),
      assignedToUid: clean(data.assignedToUid),
      assignedToName: clean(data.assignedToName),
      estimatedValue: Number(data.estimatedValue) || 0,
      leadListId: clean(data.leadListId),
      leadListName: clean(data.leadListName),
    },
    actions: {
      ...base,
      description: clean(data.description),
      status: clean(data.status),
      priority: clean(data.priority),
      relatedType: clean(data.relatedType),
      personName: clean(data.personName),
      organizationName: clean(data.organizationName),
      ownerName: clean(data.ownerName),
      dueAt: scalar(data.dueAt),
    },
    connections: {
      ...base,
      connectionType: clean(data.type),
      summary: clean(data.summary),
      body: clean(data.body),
      personName: clean(data.personName),
      organizationName: clean(data.organizationName),
      ownerName: clean(data.ownerName),
    },
    emailThreads: {
      ...base,
      subject: clean(data.subject),
      personName: clean(data.personName),
      organizationName: clean(data.organizationName),
      senderEmail: clean(data.senderEmail),
      recipientEmail: clean(data.recipientEmail || data.toAddress),
      ownerName: clean(data.ownerName),
      unreadBy: stringArray(data.unreadBy),
      lastMessageAt: scalar(data.lastMessageAt),
    },
    emailMessages: {
      ...base,
      threadId: clean(data.threadId) || clean(parentPath.split('/').pop()),
      direction: clean(data.direction),
      fromName: clean(data.fromName),
      fromAddress: clean(data.fromAddress),
      toAddress: clean(data.toAddress),
      subject: clean(data.subject),
      bodyText: clean(data.bodyText).slice(0, 12000),
      status: clean(data.status),
      hasAttachments: Array.isArray(data.attachments) && data.attachments.length > 0,
    },
    libraryFiles: {
      ...base,
      fileName: clean(data.fileName),
      contentType: clean(data.contentType),
      visibility: clean(data.visibility),
      uploadStatus: clean(data.uploadStatus),
      ownerName: clean(data.ownerName),
      personPath: referencePath(data.personRef),
      organizationPath: referencePath(data.organizationRef),
    },
  };
  return records[type] || base;
}

function getClient(appId, adminKey) {
  const safeAppId = clean(appId);
  const safeAdminKey = clean(adminKey);
  if (!safeAppId || !safeAdminKey) throw new Error('Algolia credentials are not configured.');
  const headers = {
    'content-type': 'application/json',
    'x-algolia-application-id': safeAppId,
    'x-algolia-api-key': safeAdminKey,
  };
  return {
    appId: safeAppId,
    async request(method, path, body, searchHost = false) {
      const host = searchHost ? `${safeAppId}-dsn.algolia.net` : `${safeAppId}.algolia.net`;
      const response = await fetch(`https://${host}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      const payload = text ? JSON.parse(text) : {};
      if (!response.ok) throw new Error(payload.message || `Algolia request failed with status ${response.status}.`);
      return payload;
    },
  };
}

async function saveRecord(client, type, record) {
  const indexName = INDEXES[type];
  if (!indexName) throw new Error(`Unsupported Algolia record type: ${type}`);
  return client.request('PUT', `/1/indexes/${encodeURIComponent(indexName)}/${encodeURIComponent(record.objectID)}`, record);
}

async function deleteRecord(client, type, objectID) {
  const indexName = INDEXES[type];
  if (!indexName) throw new Error(`Unsupported Algolia record type: ${type}`);
  return client.request('DELETE', `/1/indexes/${encodeURIComponent(indexName)}/${encodeURIComponent(objectID)}`);
}

async function multiSearch(client, requests) {
  const encoded = requests.map((request) => {
    const { indexName, ...params } = request;
    return { indexName, params: new URLSearchParams(params).toString() };
  });
  return client.request('POST', '/1/indexes/*/queries', { requests: encoded }, true);
}

function accessFilter(uid) {
  const safeUid = clean(uid).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `ownerUid:"${safeUid}" OR viewerUids:"${safeUid}"`;
}

const INDEX_SETTINGS = Object.freeze({
  people: {
    searchableAttributes: ['unordered(fullName)', 'unordered(email)', 'unordered(emails)', 'unordered(phone)', 'unordered(organizationName)'],
    attributesForFaceting: ['filterOnly(ownerUid)', 'filterOnly(viewerUids)', 'filterOnly(teamRepIds)', 'filterOnly(archived)', 'filterOnly(stage)', 'filterOnly(assignedToUid)', 'filterOnly(leadListId)'],
    customRanking: ['desc(updatedAt)'],
  },
  organizations: {
    searchableAttributes: ['unordered(organization)', 'unordered(email)', 'unordered(emails)', 'unordered(phone)', 'unordered(website)', 'unordered(industry)', 'unordered(city)', 'unordered(province)'],
    attributesForFaceting: ['filterOnly(ownerUid)', 'filterOnly(viewerUids)', 'filterOnly(teamRepIds)', 'filterOnly(archived)', 'filterOnly(stage)', 'filterOnly(assignedToUid)', 'filterOnly(leadListId)'],
    customRanking: ['desc(updatedAt)'],
  },
  actions: {
    searchableAttributes: ['unordered(title)', 'unordered(description)', 'unordered(personName)', 'unordered(organizationName)', 'unordered(ownerName)'],
    attributesForFaceting: ['filterOnly(ownerUid)', 'filterOnly(viewerUids)', 'filterOnly(archived)', 'filterOnly(status)', 'filterOnly(priority)', 'filterOnly(relatedType)'],
    customRanking: ['desc(updatedAt)'],
  },
  connections: {
    searchableAttributes: ['unordered(summary)', 'unordered(body)', 'unordered(personName)', 'unordered(organizationName)', 'unordered(ownerName)'],
    attributesForFaceting: ['filterOnly(ownerUid)', 'filterOnly(viewerUids)', 'filterOnly(archived)', 'filterOnly(connectionType)'],
    customRanking: ['desc(createdAt)'],
  },
  emailThreads: {
    searchableAttributes: ['unordered(subject)', 'unordered(personName)', 'unordered(organizationName)', 'unordered(senderEmail)', 'unordered(recipientEmail)', 'unordered(ownerName)'],
    attributesForFaceting: ['filterOnly(ownerUid)', 'filterOnly(viewerUids)', 'filterOnly(archived)', 'filterOnly(unreadBy)'],
    customRanking: ['desc(lastMessageAt)', 'desc(updatedAt)'],
  },
  emailMessages: {
    searchableAttributes: ['unordered(subject)', 'unordered(bodyText)', 'unordered(fromName)', 'unordered(fromAddress)', 'unordered(toAddress)'],
    attributesForFaceting: ['filterOnly(ownerUid)', 'filterOnly(viewerUids)', 'filterOnly(archived)', 'filterOnly(threadId)', 'filterOnly(direction)', 'filterOnly(hasAttachments)'],
    customRanking: ['desc(createdAt)'],
  },
  libraryFiles: {
    searchableAttributes: ['unordered(fileName)', 'unordered(ownerName)', 'unordered(contentType)'],
    attributesForFaceting: ['filterOnly(ownerUid)', 'filterOnly(viewerUids)', 'filterOnly(archived)', 'filterOnly(visibility)', 'filterOnly(uploadStatus)'],
    customRanking: ['desc(updatedAt)'],
  },
});

async function ensureIndexSettings(client, types = TYPE_ORDER) {
  return Promise.all(types.filter((type) => INDEXES[type] && INDEX_SETTINGS[type]).map((type) =>
    client.request('PUT', `/1/indexes/${encodeURIComponent(INDEXES[type])}/settings`, INDEX_SETTINGS[type])
  ));
}

module.exports = {
  INDEXES,
  TYPE_ORDER,
  buildAlgoliaRecord,
  getClient,
  saveRecord,
  deleteRecord,
  multiSearch,
  accessFilter,
  ensureIndexSettings,
};
