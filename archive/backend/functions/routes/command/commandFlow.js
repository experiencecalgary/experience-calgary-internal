'use strict';

const admin = require('firebase-admin');
const {
  onCall,
  HttpsError,
} = require('firebase-functions/v2/https');
const {
  onDocumentWritten,
} = require('firebase-functions/v2/firestore');
const {
  requireAuth,
  requireCommandAccess,
  isPlatformAdminUser,
} = require('../../lib/command/commandPersonUtils');

const ACTIVE_STAGES = Object.freeze(['Opened', 'Engaged', 'Closing']);
const DEFINITIONS = Object.freeze({
  people: {
    collection: 'commandPeople',
    relationField: 'personRef',
    nameFields: ['fullName', 'firstName', 'lastName'],
  },
  organizations: {
    collection: 'commandOrganizations',
    relationField: 'organizationRef',
    nameFields: ['organization', 'name'],
  },
});
const ATTENTION_FILTERS = new Set(['all', 'overdue', 'no_action']);
const MAX_PAGE_SIZE = 50;

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function serialize(value) {
  if (value === null || value === undefined) return null;
  if (typeof value?.toDate === 'function') return value.toDate().toISOString();
  if (value?.path) return value.path;
  if (Array.isArray(value)) return value.map(serialize);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, serialize(child)])
    );
  }
  return value;
}

function recordName(data, definition) {
  if (definition.collection === 'commandPeople') {
    return clean(data.fullName) ||
      [clean(data.firstName), clean(data.lastName)].filter(Boolean).join(' ');
  }
  return clean(data.organization) || clean(data.name);
}

function actionTarget(data = {}) {
  if (data.personRef?.path) {
    return {
      ref: data.personRef,
      relationField: 'personRef',
    };
  }
  if (data.organizationRef?.path) {
    return {
      ref: data.organizationRef,
      relationField: 'organizationRef',
    };
  }
  return null;
}

async function recomputeActionMetadata(target) {
  if (!target?.ref?.path) return;

  const db = admin.firestore();
  const recordSnap = await target.ref.get();
  if (!recordSnap.exists) return;

  const baseQuery = db
    .collection('commandActions')
    .where(target.relationField, '==', target.ref)
    .where('status', '==', 'open');

  const [countSnap, nextSnap] = await Promise.all([
    baseQuery.count().get(),
    baseQuery.orderBy('dueAt', 'asc').limit(1).get(),
  ]);

  const count = Number(countSnap.data().count || 0);
  const nextDoc = nextSnap.docs[0] || null;
  const next = nextDoc?.data() || {};

  await target.ref.set({
    flowOpenActionCount: count,
    flowNextActionRef: nextDoc?.ref || null,
    flowNextActionTitle: clean(next.title),
    flowNextActionType: clean(next.actionType),
    flowNextActionAt: next.dueAt || null,
    flowActionMetadataUpdatedAt:
      admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

exports.commandFlowActionMetadata = onDocumentWritten(
  {
    region: 'us-central1',
    document: 'commandActions/{actionId}',
    timeoutSeconds: 120,
    memory: '256MiB',
  },
  async (event) => {
    const before = event.data?.before?.data() || {};
    const after = event.data?.after?.data() || {};
    const targets = new Map();

    for (const target of [actionTarget(before), actionTarget(after)]) {
      if (target?.ref?.path) targets.set(target.ref.path, target);
    }

    await Promise.all(
      [...targets.values()].map(recomputeActionMetadata)
    );
  }
);

function applyAttention(records, attentionFilter, nowMillis) {
  if (attentionFilter === 'no_action') {
    return records.filter((record) =>
      Number(record.data.flowOpenActionCount || 0) === 0
    );
  }

  if (attentionFilter === 'overdue') {
    return records.filter((record) => {
      const dueAt = record.data.flowNextActionAt;
      return Number(record.data.flowOpenActionCount || 0) > 0 &&
        typeof dueAt?.toMillis === 'function' &&
        dueAt.toMillis() < nowMillis;
    });
  }

  return records;
}

function urgency(record, nowMillis) {
  const count = Number(record.data.flowOpenActionCount || 0);
  const dueAt = record.data.flowNextActionAt;
  const dueMillis = typeof dueAt?.toMillis === 'function'
    ? dueAt.toMillis()
    : Number.POSITIVE_INFINITY;

  if (count > 0 && dueMillis < nowMillis) return [0, dueMillis];
  if (count > 0 && Number.isFinite(dueMillis)) return [1, dueMillis];
  return [2, Number.POSITIVE_INFINITY];
}

function compareRecords(left, right, nowMillis) {
  const a = urgency(left, nowMillis);
  const b = urgency(right, nowMillis);
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return left.id.localeCompare(right.id);
}

function pageOffset(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

async function listCommandFlowPageService(request) {
  const db = admin.firestore();
  const uid = requireAuth(request);
  const { userData } = await requireCommandAccess(db, uid);
  const input = request.data || {};
  const recordType = clean(input.recordType).toLowerCase();
  const definition = DEFINITIONS[recordType];

  if (!definition) {
    throw new HttpsError(
      'invalid-argument',
      'recordType must be people or organizations.'
    );
  }

  const attentionFilter =
    clean(input.attentionFilter).toLowerCase() || 'all';
  if (!ATTENTION_FILTERS.has(attentionFilter)) {
    throw new HttpsError(
      'invalid-argument',
      'attentionFilter must be all, overdue, or no_action.'
    );
  }

  const repId = clean(userData.repId);
  if (!repId) {
    throw new HttpsError(
      'failed-precondition',
      'Your representative profile does not have a rep ID.'
    );
  }

  const pageSize = Math.min(
    Math.max(Number(input.pageSize) || 20, 1),
    MAX_PAGE_SIZE
  );
  const tokens = input.pageTokens &&
    typeof input.pageTokens === 'object' &&
    !Array.isArray(input.pageTokens)
    ? input.pageTokens
    : {};
  const nowMillis = Date.now();

  const platformAdmin = isPlatformAdminUser(userData);
  const stageSnapshots = await Promise.all(
    ACTIVE_STAGES.map((stage) => {
      let query = db.collection(definition.collection);
      if (!platformAdmin) {
        query = query.where('teamRepIds', 'array-contains', repId);
      }
      return query
        .where('archived', '==', false)
        .where('stage', '==', stage)
        .get();
    })
  );

  const columns = {};
  const totals = {
    Opened: 0,
    Engaged: 0,
    Closing: 0,
    active: 0,
    overdue: 0,
    noAction: 0,
  };

  for (let index = 0; index < ACTIVE_STAGES.length; index += 1) {
    const stage = ACTIVE_STAGES[index];
    const allRecords = stageSnapshots[index].docs.map((doc) => ({
      id: doc.id,
      ref: doc.ref,
      data: doc.data() || {},
    }));

    totals[stage] = allRecords.length;
    totals.active += allRecords.length;
    totals.overdue += applyAttention(
      allRecords,
      'overdue',
      nowMillis
    ).length;
    totals.noAction += applyAttention(
      allRecords,
      'no_action',
      nowMillis
    ).length;

    const filtered = applyAttention(
      allRecords,
      attentionFilter,
      nowMillis
    ).sort((left, right) => compareRecords(left, right, nowMillis));

    const offset = pageOffset(tokens[stage]);
    const visible = filtered.slice(offset, offset + pageSize);
    const nextOffset = offset + visible.length;
    const hasMore = nextOffset < filtered.length;

    columns[stage] = {
      stage,
      total: filtered.length,
      records: visible.map((record) => ({
        id: record.id,
        path: record.ref.path,
        name: recordName(record.data, definition),
        organizationName:
          recordType === 'people'
            ? clean(record.data.organizationName)
            : '',
        stage: clean(record.data.stage),
        ownerName: clean(record.data.ownerName),
        assignedToName: clean(record.data.assignedToName),
        assignedToRefPath: record.data.assignedToRef?.path || '',
        estimatedValue:
          Number.isFinite(Number(record.data.estimatedValue))
            ? Number(record.data.estimatedValue)
            : null,
        nextActionRefPath:
          record.data.flowNextActionRef?.path || '',
        nextActionTitle:
          clean(record.data.flowNextActionTitle),
        nextActionType:
          clean(record.data.flowNextActionType),
        nextActionAt:
          serialize(record.data.flowNextActionAt),
        openActionCount:
          Number(record.data.flowOpenActionCount || 0),
        overdue:
          applyAttention([record], 'overdue', nowMillis).length === 1,
        noAction:
          applyAttention([record], 'no_action', nowMillis).length === 1,
      })),
      hasMore,
      nextPageToken: hasMore ? String(nextOffset) : '',
    };
  }

  return {
    ok: true,
    result: 'success',
    recordType,
    attentionFilter,
    activeStages: ACTIVE_STAGES,
    totals,
    columns,
  };
}

exports.listCommandFlowPageService = listCommandFlowPageService;
exports.listCommandFlowPage = onCall(
  {
    region: 'us-central1',
    cors: true,
    timeoutSeconds: 120,
    memory: '512MiB',
  },
  listCommandFlowPageService
);

exports.backfillCommandFlowActionMetadata = onCall(
  {
    region: 'us-central1',
    cors: true,
    timeoutSeconds: 540,
    memory: '512MiB',
  },
  async (request) => {
    const db = admin.firestore();
    const uid = requireAuth(request);
    const { userData } = await requireCommandAccess(db, uid);

    if (
      userData.role !== 'platform_admin' &&
      userData.userType !== 'admin'
    ) {
      throw new HttpsError(
        'permission-denied',
        'Only a platform administrator can backfill Flow metadata.'
      );
    }

    const recordType = clean(request.data?.recordType).toLowerCase();
    const definition = DEFINITIONS[recordType];
    if (!definition) {
      throw new HttpsError(
        'invalid-argument',
        'recordType must be people or organizations.'
      );
    }

    const pageSize = Math.min(
      Math.max(Number(request.data?.pageSize) || 100, 1),
      250
    );
    let query = db.collection(definition.collection)
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(pageSize);

    const pageToken = clean(request.data?.pageToken);
    if (pageToken) {
      const tokenSnap = await db.doc(pageToken).get();
      if (
        !tokenSnap.exists ||
        tokenSnap.ref.parent.id !== definition.collection
      ) {
        throw new HttpsError(
          'invalid-argument',
          'The Flow backfill page token is invalid.'
        );
      }
      query = query.startAfter(tokenSnap);
    }

    const snapshot = await query.get();
    for (const doc of snapshot.docs) {
      await recomputeActionMetadata({
        ref: doc.ref,
        relationField: definition.relationField,
      });
    }

    const last = snapshot.docs[snapshot.docs.length - 1];
    return {
      ok: true,
      recordType,
      processedCount: snapshot.size,
      hasMore: snapshot.size === pageSize,
      nextPageToken:
        snapshot.size === pageSize && last ? last.ref.path : '',
    };
  }
);
