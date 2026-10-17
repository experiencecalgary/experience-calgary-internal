'use strict';

const crypto = require('crypto');
const admin = require('firebase-admin');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const {
  requireAuth,
  requireCommandAccess,
  isPlatformAdminUser,
} = require('../../lib/command/commandPersonUtils');
const { buildCommandAccessMetadata } = require('../../lib/command/commandAccessMetadata');

const REGION = 'us-central1';
const PEOPLE = 'commandPeople';
const ORGANIZATIONS = 'commandOrganizations';
const LEADS = 'commandLeads';
const MIGRATIONS = 'commandLeadMigrations';
const ACTIVE_STAGES = new Set(['New', 'Opened', 'Engaged', 'Closing']);
const CLOSED_STAGES = new Set(['Won', 'Lost']);
const BACKFILL_COLLECTIONS = [
  { name: 'commandActions', person: ['personRef'], organization: ['organizationRef'] },
  { name: 'commandCalls', person: ['personRef'], organization: ['organizationRef'] },
  { name: 'commandConnections', person: ['personRef'], organization: ['organizationRef'] },
  { name: 'commandAgreements', person: ['personRef', 'primaryContactRef', 'signerPersonRef'], organization: ['organizationRef'] },
];
const callable = handler => onCall({
  region: REGION,
  cors: true,
  timeoutSeconds: 540,
  memory: '1GiB',
}, handler);

const clean = value => typeof value === 'string' ? value.trim() : '';
const refPath = value => clean(value?.path || value);
const unique = values => [...new Set((values || []).filter(Boolean))];
const serverTimestamp = () => admin.firestore.FieldValue.serverTimestamp();
const normalizedStage = value => {
  const raw = clean(value || 'New');
  return [...ACTIVE_STAGES, ...CLOSED_STAGES].find(stage => stage.toLowerCase() === raw.toLowerCase()) || 'New';
};
const personName = data => clean(data.fullName) ||
  [clean(data.firstName), clean(data.lastName)].filter(Boolean).join(' ') ||
  clean(data.displayName) || clean(data.email) || 'Unnamed Person';
const organizationName = data => clean(data.organization) || clean(data.name) ||
  clean(data.organizationName) || clean(data.displayName) || 'Unnamed Organization';
const hasContact = data => Boolean(clean(data.email) || clean(data.emailNormalized) || clean(data.phone) || clean(data.phoneNormalized));
const hash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
const migrationLeadId = key => `legacy_${hash(key)}`;
const snapshotData = value => typeof value?.data === 'function' ? (value.data() || {}) : (value?.data || {});

function assertPlatformAdmin(actor) {
  if (!isPlatformAdminUser(actor.userData)) {
    throw new HttpsError('permission-denied', 'Only a platform administrator can migrate existing Leads.');
  }
}

function path(value, collection, field, required = false) {
  const parts = refPath(value).split('/').filter(Boolean);
  if (!parts.length && !required) return '';
  if (parts.length !== 2 || parts[0] !== collection) {
    throw new HttpsError('invalid-argument', `${field} must use ${collection}/{documentId}.`);
  }
  return parts.join('/');
}

async function context(request) {
  const db = admin.firestore();
  const uid = requireAuth(request);
  const actor = await requireCommandAccess(db, uid);
  assertPlatformAdmin(actor);
  return { db, uid, actor, input: request.data || {} };
}

function scopeMatches(data, scope) {
  if (scope.repUid) {
    const uids = unique([data.ownerUid, data.assignedToUid, data.ownerRef?.id, data.assignedToRef?.id].map(clean));
    if (!uids.includes(scope.repUid)) return false;
  }
  if (scope.leadListId) {
    const values = unique([data.leadListId, data.listId, data.leadListRef?.id, data.listRef?.id].map(clean));
    if (!values.includes(scope.leadListId)) return false;
  }
  return true;
}

function salesEligible(data, kind) {
  if (data.archived === true || clean(data.status).toLowerCase() === 'archived') return false;
  if (kind === 'person' && personName(data) === 'Unnamed Person') return false;
  if (kind === 'organization' && organizationName(data) === 'Unnamed Organization') return false;
  return hasContact(data) || Boolean(
    clean(data.stage) || clean(data.status) || data.ownerRef || data.assignedToRef ||
    clean(data.ownerUid) || clean(data.assignedToUid) || clean(data.leadListId) ||
    data.leadListRef || data.lastActivityAt || data.nextActionRef
  );
}

function contactPaths(data) {
  return unique([
    refPath(data.primaryContactRef),
    refPath(data.personRef),
    ...(Array.isArray(data.connectedPersonRefs) ? data.connectedPersonRefs.map(refPath) : []),
    ...(Array.isArray(data.peopleRefs) ? data.peopleRefs.map(refPath) : []),
  ]).filter(value => value.startsWith(`${PEOPLE}/`));
}

function legacyOrganizationPath(data) {
  const value = refPath(data.organizationRef || data.commandOrganizationRef);
  return value.startsWith(`${ORGANIZATIONS}/`) ? value : '';
}

function relationshipConflict(organization = {}, person = {}) {
  const conflicts = [];
  const orgStage = clean(organization.stage);
  const personStage = clean(person.stage);
  if (orgStage && personStage && normalizedStage(orgStage) !== normalizedStage(personStage)) conflicts.push('stage');

  const assignment = data => clean(
    data.assignedToUid || data.assignedToRef?.id || data.ownerUid || data.ownerRef?.id
  );
  const orgAssignment = assignment(organization);
  const personAssignment = assignment(person);
  if (orgAssignment && personAssignment && orgAssignment !== personAssignment) conflicts.push('assigned representative');

  const list = data => clean(data.leadListId || data.listId || data.leadListRef?.id || data.listRef?.id);
  const orgList = list(organization);
  const personList = list(person);
  if (orgList && personList && orgList !== personList) conflicts.push('Lead List');
  return conflicts;
}

function summary(candidate) {
  return {
    candidateId: candidate.candidateId,
    decision: candidate.decision,
    reason: candidate.reason,
    reviewRecords: candidate.reviewRecords || [],
    leadType: candidate.leadType || '',
    displayName: candidate.displayName || '',
    personRefPaths: candidate.personRefPaths || [],
    organizationRefPath: candidate.organizationRefPath || '',
    existingLeadRefPath: candidate.existingLeadRefPath || '',
  };
}

async function existingLeadMaps(db) {
  const snap = await db.collection(LEADS).get();
  const people = new Map();
  const organizations = new Map();
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    if (data.archived === true) continue;
    const orgPath = refPath(data.subjectOrganizationRef);
    if (orgPath) {
      if (!organizations.has(orgPath)) organizations.set(orgPath, []);
      organizations.get(orgPath).push(doc.ref.path);
    }
    for (const personPath of unique([
      refPath(data.subjectPersonRef), refPath(data.primaryContactRef),
      ...(data.connectedPersonRefs || []).map(refPath),
    ])) {
      if (!people.has(personPath)) people.set(personPath, []);
      people.get(personPath).push(doc.ref.path);
    }
  }
  return { people, organizations };
}

function inherited(candidate, peopleByPath, organizationsByPath) {
  const org = candidate.organizationRefPath ? snapshotData(organizationsByPath.get(candidate.organizationRefPath)) : {};
  const firstPerson = candidate.personRefPaths.length ? snapshotData(peopleByPath.get(candidate.personRefPaths[0])) : {};
  const records = [org, firstPerson];
  const take = keys => {
    for (const data of records) for (const key of keys) if (data[key] !== undefined && data[key] !== null && data[key] !== '') return data[key];
    return null;
  };
  return {
    stage: normalizedStage(take(['stage'])),
    ownerRef: take(['ownerRef']),
    assignedToRef: take(['assignedToRef', 'ownerRef']),
    source: clean(take(['source', 'leadSource'])),
    leadListId: clean(take(['leadListId', 'listId', 'leadListRef'])?.id || take(['leadListId', 'listId'])),
    leadListName: clean(take(['leadListName', 'listName'])),
    nextActionRef: take(['nextActionRef', 'flowNextActionRef']),
    nextActionTitle: clean(take(['nextActionTitle', 'flowNextActionTitle'])),
    nextActionType: clean(take(['nextActionType', 'flowNextActionType'])),
    nextActionAt: take(['nextActionAt', 'flowNextActionAt']),
    lastActivityAt: take(['lastActivityAt', 'lastGenuineOutreachAt']),
    lastActivityType: clean(take(['lastActivityType'])),
    lostReason: clean(take(['lostReason', 'closeReason'])),
    closeDetails: clean(take(['closeDetails'])),
    closedAt: take(['closedAt']),
    closedByRef: take(['closedByRef']),
    wonAt: take(['wonAt']),
    lostAt: take(['lostAt']),
    previousActiveStage: clean(take(['previousActiveStage'])),
    importedAt: take(['importedAt']),
    importBatchId: clean(take(['importBatchId'])),
    createdAt: take(['createdAt']),
    legacyUpdatedAt: take(['updatedAt']),
  };
}

function timestampMillis(value) {
  if (value?.toMillis) return value.toMillis();
  if (value && Number.isFinite(value.seconds)) {
    return Number(value.seconds) * 1000 + Math.floor(Number(value.nanoseconds || 0) / 1e6);
  }
  return null;
}

function sourceState(doc) {
  const data = doc?.data?.() || {};
  return {
    path: doc?.ref?.path || '',
    exists: doc?.exists === true,
    updatedAt: timestampMillis(data.updatedAt),
    archived: data.archived === true,
    stage: clean(data.stage),
    status: clean(data.status),
    owner: clean(data.ownerUid || data.ownerRef?.id),
    assignedTo: clean(data.assignedToUid || data.assignedToRef?.id),
    leadListId: clean(data.leadListId || data.listId || data.leadListRef?.id || data.listRef?.id),
    organizationRefPath: legacyOrganizationPath(data),
    primaryContactRefPath: refPath(data.primaryContactRef),
    connectedPersonRefPaths: contactPaths(data).sort(),
    nextActionRefPath: refPath(data.nextActionRef || data.flowNextActionRef),
    nextActionAt: timestampMillis(data.nextActionAt || data.flowNextActionAt),
    closedAt: timestampMillis(data.closedAt),
  };
}

function candidateFingerprint(candidate, peopleByPath, organizationsByPath) {
  const sources = [];
  if (candidate.organizationRefPath) sources.push(sourceState(organizationsByPath.get(candidate.organizationRefPath)));
  for (const personPath of candidate.personRefPaths || []) sources.push(sourceState(peopleByPath.get(personPath)));
  sources.sort((left, right) => left.path.localeCompare(right.path));
  return hash(JSON.stringify({
    leadType: candidate.leadType,
    personRefPaths: candidate.personRefPaths || [],
    organizationRefPath: candidate.organizationRefPath || '',
    inherited: inherited(candidate, peopleByPath, organizationsByPath),
    sources,
  }, (key, value) => value?.path || value?.toMillis?.() || value));
}

async function verifyCandidateFingerprint(ctx, candidate) {
  const personRefs = (candidate.personRefPaths || []).map(value => ctx.db.doc(path(value, PEOPLE, 'personRefPath', true)));
  const organizationRef = candidate.organizationRefPath
    ? ctx.db.doc(path(candidate.organizationRefPath, ORGANIZATIONS, 'organizationRefPath', true))
    : null;
  const refs = [...personRefs, ...(organizationRef ? [organizationRef] : [])];
  const snaps = refs.length ? await ctx.db.getAll(...refs) : [];
  if (snaps.some(snap => !snap.exists)) {
    throw new HttpsError('failed-precondition', 'A source record changed or was removed after preview. Run the preview again.');
  }
  const peopleByPath = new Map();
  const organizationsByPath = new Map();
  for (const snap of snaps) {
    if (snap.ref.parent.id === PEOPLE) peopleByPath.set(snap.ref.path, snap);
    if (snap.ref.parent.id === ORGANIZATIONS) organizationsByPath.set(snap.ref.path, snap);
  }
  const current = candidateFingerprint(candidate, peopleByPath, organizationsByPath);
  if (!clean(candidate.sourceFingerprint) || current !== clean(candidate.sourceFingerprint)) {
    throw new HttpsError('failed-precondition', 'A source record changed after preview. Run the preview again before committing.');
  }
}

async function buildCandidates(ctx, scope, limit, afterCandidateId = '') {
  const [peopleSnap, orgSnap, existing] = await Promise.all([
    ctx.db.collection(PEOPLE).get(),
    ctx.db.collection(ORGANIZATIONS).get(),
    existingLeadMaps(ctx.db),
  ]);
  const peopleByPath = new Map(peopleSnap.docs.map(doc => [doc.ref.path, doc]));
  const organizationsByPath = new Map(orgSnap.docs.map(doc => [doc.ref.path, doc]));
  const eligiblePeople = peopleSnap.docs.filter(doc => scopeMatches(doc.data() || {}, scope) && salesEligible(doc.data() || {}, 'person'));
  const eligibleOrganizations = orgSnap.docs.filter(doc => scopeMatches(doc.data() || {}, scope) && salesEligible(doc.data() || {}, 'organization'));
  const eligibleOrgPaths = new Set(eligibleOrganizations.map(doc => doc.ref.path));
  const peopleForOrg = new Map();
  for (const doc of eligiblePeople) {
    const orgPath = legacyOrganizationPath(doc.data() || {});
    if (orgPath && organizationsByPath.has(orgPath)) {
      if (!peopleForOrg.has(orgPath)) peopleForOrg.set(orgPath, []);
      peopleForOrg.get(orgPath).push(doc.ref.path);
    }
  }
  const candidates = [];
  const consumedPeople = new Set();
  for (const orgDoc of eligibleOrganizations) {
    const orgPath = orgDoc.ref.path;
    const orgData = orgDoc.data() || {};
    const linkedPeople = unique([...(peopleForOrg.get(orgPath) || []), ...contactPaths(orgData)])
      .filter(personPath => peopleByPath.has(personPath));
    linkedPeople.forEach(personPath => consumedPeople.add(personPath));
    const existingRefs = existing.organizations.get(orgPath) || [];
    const primary = refPath(orgData.primaryContactRef);
    // A contact attached only through the Organization is context, not a
    // competing legacy opportunity. Compare pipeline fields only for People
    // that independently qualified as sales records in this preview scope.
    const conflicts = unique((peopleForOrg.get(orgPath) || []).flatMap(personPath =>
      relationshipConflict(orgData, snapshotData(peopleByPath.get(personPath)))
    ));
    const candidate = {
      candidateId: `organization_${orgDoc.id}`,
      decision: existingRefs.length ? 'already_migrated' : (conflicts.length ? 'ambiguous' : 'ready'),
      reason: existingRefs.length
        ? 'An active Lead already uses this Organization.'
        : conflicts.length
          ? `Connected People conflict with the Organization on: ${conflicts.join(', ')}.`
          : 'Organization is a sales record; connected People will remain contacts.',
      leadType: 'organization', displayName: organizationName(orgData),
      organizationRefPath: orgPath, personRefPaths: linkedPeople,
      primaryContactRefPath: linkedPeople.includes(primary) ? primary : (linkedPeople.length === 1 ? linkedPeople[0] : ''),
      existingLeadRefPath: existingRefs.length === 1 ? existingRefs[0] : '',
      identityKeys: unique([
        clean(orgData.emailNormalized || orgData.email).toLowerCase() ? `email:${clean(orgData.emailNormalized || orgData.email).toLowerCase()}` : '',
        clean(orgData.phoneNormalized || orgData.phone).replace(/\D/g, '') ? `phone:${clean(orgData.phoneNormalized || orgData.phone).replace(/\D/g, '')}` : '',
      ]),
    };
    if (existingRefs.length > 1) {
      candidate.decision = 'ambiguous';
      candidate.reason = 'More than one active Lead already uses this Organization.';
    }
    candidates.push({ ...candidate, inherited: inherited(candidate, peopleByPath, organizationsByPath) });
  }
  for (const personDoc of eligiblePeople) {
    if (consumedPeople.has(personDoc.ref.path)) continue;
    const data = personDoc.data() || {};
    const orgPath = legacyOrganizationPath(data);
    const personExisting = existing.people.get(personDoc.ref.path) || [];
    const orgExisting = orgPath ? existing.organizations.get(orgPath) || [] : [];
    const allExisting = unique([...personExisting, ...orgExisting]);
    const candidate = {
      candidateId: `person_${personDoc.id}`,
      decision: personExisting.length === 1 ? 'already_migrated' : 'ready',
      reason: personExisting.length === 1 ? 'An active Lead already includes this Person.' : 'Person is being worked independently as a sales record.',
      leadType: 'person', displayName: personName(data),
      organizationRefPath: orgPath,
      personRefPaths: [personDoc.ref.path], primaryContactRefPath: personDoc.ref.path,
      existingLeadRefPath: personExisting.length === 1 ? personExisting[0] : '',
      identityKeys: unique([
        clean(data.emailNormalized || data.email).toLowerCase() ? `email:${clean(data.emailNormalized || data.email).toLowerCase()}` : '',
        clean(data.phoneNormalized || data.phone).replace(/\D/g, '') ? `phone:${clean(data.phoneNormalized || data.phone).replace(/\D/g, '')}` : '',
      ]),
    };
    if (personExisting.length > 1 || allExisting.length > 1) {
      candidate.decision = 'ambiguous';
      candidate.reason = 'More than one active Lead already includes this Person or Organization.';
    } else if (!personExisting.length && orgExisting.length === 1) {
      candidate.decision = 'ambiguous';
      candidate.reason = 'The Organization already has a Lead, but this Person is not connected to it.';
    } else if (orgPath && !organizationsByPath.has(orgPath)) {
      candidate.decision = 'ambiguous';
      candidate.reason = 'The Person points to an Organization that no longer exists.';
    } else if (orgPath && eligibleOrgPaths.has(orgPath)) {
      candidate.decision = 'ambiguous';
      candidate.reason = 'The Organization was eligible but the relationship could not be safely combined.';
    }
    candidates.push({ ...candidate, inherited: inherited(candidate, peopleByPath, organizationsByPath) });
  }
  for (const doc of peopleSnap.docs) {
    if (scopeMatches(doc.data() || {}, scope) && !salesEligible(doc.data() || {}, 'person')) {
      candidates.push({ candidateId: `person_${doc.id}`, decision: 'contact_only', reason: 'Archived or does not contain enough sales/contact information.', leadType: 'person', displayName: personName(doc.data() || {}), personRefPaths: [doc.ref.path], organizationRefPath: '' });
    }
  }
  for (const doc of orgSnap.docs) {
    if (scopeMatches(doc.data() || {}, scope) && !salesEligible(doc.data() || {}, 'organization')) {
      candidates.push({ candidateId: `organization_${doc.id}`, decision: 'contact_only', reason: 'Archived or does not contain enough sales/contact information.', leadType: 'organization', displayName: organizationName(doc.data() || {}), personRefPaths: [], organizationRefPath: doc.ref.path });
    }
  }
  const identities = new Map();
  for (const candidate of candidates.filter(item => item.decision === 'ready')) {
    for (const key of candidate.identityKeys || []) {
      const scopedKey = `${candidate.leadType}:${key}`;
      if (!identities.has(scopedKey)) identities.set(scopedKey, []);
      identities.get(scopedKey).push(candidate);
    }
  }
  for (const matches of identities.values()) {
    if (matches.length < 2) continue;
    for (const candidate of matches) {
      candidate.decision = 'ambiguous';
      candidate.reason = 'Another legacy record has the same exact email address or phone number; no duplicate was merged automatically.';
    }
  }
  for (const candidate of candidates) {
    candidate.sourceFingerprint = candidateFingerprint(candidate, peopleByPath, organizationsByPath);
  }
  candidates.sort((a, b) => a.candidateId.localeCompare(b.candidateId));
  for (const candidate of candidates) {
    candidate.reviewRecords = [candidate.organizationRefPath, ...(candidate.personRefPaths || [])].filter(Boolean).map(refPath => {
      const doc = organizationsByPath.get(refPath) || peopleByPath.get(refPath);
      const data = snapshotData(doc);
      return { refPath, stage: clean(data.stage), assignedToRefPath: clean(data.assignedToRef?.path || data.assignedToRef), leadListId: clean(data.leadListId), leadListName: clean(data.leadListName), assignedToName: clean(data.assignedToName), name: refPath.startsWith('commandOrganizations/') ? organizationName(data) : personName(data) };
    });
  }
  const page = candidates.filter(candidate => !afterCandidateId || candidate.candidateId > afterCandidateId).slice(0, limit + 1);
  const hasMore = page.length > limit;
  if (hasMore) page.pop();
  return {
    candidates: page,
    hasMore,
    nextCursor: hasMore && page.length ? page[page.length - 1].candidateId : '',
  };
}

function counts(candidates) {
  return candidates.reduce((result, candidate) => {
    result[candidate.decision] = (result[candidate.decision] || 0) + 1;
    return result;
  }, { ready: 0, already_migrated: 0, ambiguous: 0, contact_only: 0 });
}

async function previewService(request) {
  const ctx = await context(request);
  const scope = {
    repUid: clean(ctx.input.repUid),
    leadListId: clean(ctx.input.leadListId),
  };
  if (!scope.repUid && !scope.leadListId && ctx.input.allEligible !== true) {
    throw new HttpsError('invalid-argument', 'Select a representative or Lead List for this migration preview.');
  }
  // One migration parent plus at most 450 candidate writes remains below the
  // Firestore 500-operation batch ceiling.
  const limit = Math.min(Math.max(Number(ctx.input.limit) || 200, 1), 450);
  const afterCandidateId = clean(ctx.input.afterCandidateId);
  if (clean(ctx.input.migrationId)) return migrationPage(ctx, clean(ctx.input.migrationId), afterCandidateId, limit);
  if (ctx.input.allEligible === true) return createFullPreview(ctx, scope, limit);
  const page = await buildCandidates(ctx, scope, limit, afterCandidateId);
  const candidates = page.candidates;
  const migrationRef = ctx.db.collection(MIGRATIONS).doc();
  const batch = ctx.db.batch();
  batch.create(migrationRef, {
    status: 'previewed', scope, limit, afterCandidateId, hasMore: page.hasMore,
    nextCursor: page.nextCursor, counts: counts(candidates), candidateCount: candidates.length,
    createdAt: serverTimestamp(), createdByRef: ctx.actor.userRef, createdByUid: ctx.uid,
    updatedAt: serverTimestamp(), committedCount: 0,
  });
  for (const candidate of candidates) {
    batch.create(migrationRef.collection('candidates').doc(candidate.candidateId), {
      ...candidate,
      status: ['ready', 'already_migrated'].includes(candidate.decision) ? 'ready' : 'skipped',
      createdAt: serverTimestamp(),
    });
  }
  await batch.commit();
  return {
    ok: true, migrationId: migrationRef.id, scope, counts: counts(candidates),
    candidates: candidates.map(summary), hasMore: page.hasMore, nextCursor: page.nextCursor,
  };
}

async function migrationPage(ctx, id, cursor = '', limit = 200) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new HttpsError('invalid-argument', 'Invalid migration ID.');
  const ref = ctx.db.collection(MIGRATIONS).doc(id), snap = await ref.get();
  if (!snap.exists || snap.data().status === 'building') throw new HttpsError('failed-precondition', 'Preview is not ready.');
  let query = ref.collection('candidates').orderBy(admin.firestore.FieldPath.documentId());
  if (cursor) query = query.startAfter(cursor);
  const rows = (await query.limit(limit + 1).get()).docs;
  const hasMore = rows.length > limit; if (hasMore) rows.pop();
  return { ok: true, migrationId: id, scope: snap.data().scope, totalCounts: snap.data().counts,
    counts: counts(rows.map(d => d.data())), candidates: rows.map(d => ({ ...summary(d.data()), status: d.data().status })),
    hasMore, nextCursor: hasMore ? rows[rows.length - 1].id : '' };
}
async function createFullPreview(ctx, scope, limit) {
  const ref = ctx.db.collection(MIGRATIONS).doc();
  await ref.create({ status: 'building', scope, createdByUid: ctx.uid, createdAt: serverTimestamp() });
  // Grouping requires the full relationship graph. Build once, not on each page.
  const page = await buildCandidates(ctx, scope, Number.MAX_SAFE_INTEGER);
  for (let offset = 0; offset < page.candidates.length; offset += 400) {
    const batch = ctx.db.batch();
    for (const candidate of page.candidates.slice(offset, offset + 400)) {
      batch.create(ref.collection('candidates').doc(candidate.candidateId), { ...candidate,
        status: ['ready', 'already_migrated'].includes(candidate.decision) ? 'ready' : 'skipped', createdAt: serverTimestamp() });
    }
    await batch.commit();
  }
  await ref.set({ status: 'previewed', counts: counts(page.candidates), candidateCount: page.candidates.length,
    updatedAt: serverTimestamp(), committedCount: 0 }, { merge: true });
  return migrationPage(ctx, ref.id, '', limit);
}

async function uniqueLeadForRecord(db, data) {
  const candidates = new Map();
  const add = async (field, reference, operator = '==') => {
    if (!reference) return;
    const snap = await db.collection(LEADS).where(field, operator, reference).limit(3).get();
    for (const doc of snap.docs) if (doc.data()?.archived !== true) candidates.set(doc.ref.path, doc.ref);
  };
  await Promise.all([
    add('subjectPersonRef', data.personRef), add('primaryContactRef', data.personRef),
    add('connectedPersonRefs', data.personRef, 'array-contains'), add('subjectOrganizationRef', data.organizationRef),
  ]);
  return candidates.size === 1 ? [...candidates.values()][0] : null;
}

async function backfillLead(ctx, leadRef, leadData) {
  const found = new Map();
  for (const config of BACKFILL_COLLECTIONS) {
    for (const personRef of unique([leadData.subjectPersonRef, leadData.primaryContactRef, ...(leadData.connectedPersonRefs || [])])) {
      for (const field of config.person) {
        const snap = await ctx.db.collection(config.name).where(field, '==', personRef).get();
        snap.docs.forEach(doc => found.set(doc.ref.path, doc));
      }
    }
    if (leadData.subjectOrganizationRef) {
      for (const field of config.organization) {
        const snap = await ctx.db.collection(config.name).where(field, '==', leadData.subjectOrganizationRef).get();
        snap.docs.forEach(doc => found.set(doc.ref.path, doc));
      }
    }
  }
  const result = { linked: 0, ambiguous: 0, existing: 0, byCollection: {} };
  for (const doc of found.values()) {
    const data = doc.data() || {};
    if (data.leadRef) { result.existing += 1; continue; }
    const uniqueLead = await uniqueLeadForRecord(ctx.db, {
      ...data,
      personRef: data.personRef || data.primaryContactRef || data.signerPersonRef || null,
      organizationRef: data.organizationRef || null,
    });
    if (uniqueLead?.path !== leadRef.path) { result.ambiguous += 1; continue; }
    const update = {
      leadRef,
      leadLinkedAt: serverTimestamp(),
      leadLinkedByMigration: true,
    };
    if (!clean(data.leadName)) update.leadName = clean(leadData.displayName);
    await doc.ref.update(update);
    result.linked += 1;
    result.byCollection[doc.ref.parent.id] = (result.byCollection[doc.ref.parent.id] || 0) + 1;
  }
  return result;
}

async function finishCandidate(candidateRef, work) {
  const result = await work();
  await candidateRef.set({ status: 'committed', committedAt: serverTimestamp() }, { merge: true });
  return result;
}

async function createLead(ctx, migrationRef, candidateRef, candidate) {
  await verifyCandidateFingerprint(ctx, candidate);
  if (candidate.decision === 'already_migrated') {
    const existingPath = path(candidate.existingLeadRefPath, LEADS, 'existingLeadRefPath', true);
    const existingRef = ctx.db.doc(existingPath);
    const existingSnap = await existingRef.get();
    if (!existingSnap.exists || existingSnap.data()?.archived === true) {
      throw new HttpsError('failed-precondition', 'The existing Lead changed after preview. Run the preview again.');
    }
    const existingData = existingSnap.data() || {};
    const matchesOrganization = candidate.leadType !== 'organization' ||
      refPath(existingData.subjectOrganizationRef) === candidate.organizationRefPath;
    const existingPeople = unique([
      refPath(existingData.subjectPersonRef),
      refPath(existingData.primaryContactRef),
      ...(existingData.connectedPersonRefs || []).map(refPath),
    ]);
    const matchesPerson = candidate.leadType !== 'person' ||
      (candidate.personRefPaths || []).some(personPath => existingPeople.includes(personPath));
    if (!matchesOrganization || !matchesPerson) {
      throw new HttpsError('failed-precondition', 'The existing Lead relationships changed after preview. Run the preview again.');
    }
    await candidateRef.set({
      status: 'ready',
      leadRef: existingRef,
      committedAt: serverTimestamp(),
      commitMode: 'existing_lead_backfill',
    }, { merge: true });
    const backfill = await finishCandidate(candidateRef, () => backfillLead(ctx, existingRef, existingData));
    return { leadRefPath: existingRef.path, duplicate: true, backfill };
  }
  if (candidate.decision !== 'ready') {
    throw new HttpsError('failed-precondition', 'Candidate is not ready to migrate.');
  }
  const inheritedData = candidate.inherited || {};
  const personRefs = (candidate.personRefPaths || []).map(value => ctx.db.doc(path(value, PEOPLE, 'personRefPath', true)));
  const organizationRef = candidate.organizationRefPath ? ctx.db.doc(path(candidate.organizationRefPath, ORGANIZATIONS, 'organizationRefPath', true)) : null;
  const primaryContactRef = candidate.primaryContactRefPath ? ctx.db.doc(path(candidate.primaryContactRefPath, PEOPLE, 'primaryContactRefPath', true)) : null;
  const ownerRef = inheritedData.ownerRef || inheritedData.assignedToRef || ctx.actor.userRef;
  const assignedToRef = inheritedData.assignedToRef || ownerRef;
  const access = await buildCommandAccessMetadata(ctx.db, { actorRef: ctx.actor.userRef, ownerRef, assignedToRef });
  const sourceKey = candidate.leadType === 'organization' ? candidate.organizationRefPath : candidate.personRefPaths[0];
  const leadRef = ctx.db.collection(LEADS).doc(migrationLeadId(sourceKey));
  const stage = normalizedStage(inheritedData.stage);
  const status = stage === 'Won' ? 'won' : stage === 'Lost' ? 'lost' : 'active';
  const peopleSnaps = personRefs.length ? await ctx.db.getAll(...personRefs) : [];
  const names = peopleSnaps.map(snap => snap.exists ? personName(snap.data() || {}) : '').filter(Boolean);
  let orgName = '';
  if (organizationRef) {
    const orgSnap = await organizationRef.get();
    if (!orgSnap.exists) throw new HttpsError('failed-precondition', 'A previewed Organization no longer exists.');
    orgName = organizationName(orgSnap.data() || {});
  }
  const now = serverTimestamp();
  const leadData = {
    displayName: clean(candidate.displayName), displayNameNormalized: clean(candidate.displayName).toLowerCase(),
    searchTextNormalized: unique([candidate.displayName, orgName, ...names].map(v => clean(v).toLowerCase())).join(' '),
    leadType: candidate.leadType, stage, status, archived: false,
    subjectPersonRef: candidate.leadType === 'person' ? personRefs[0] || null : null,
    subjectPersonName: candidate.leadType === 'person' ? names[0] || '' : '',
    subjectOrganizationRef: organizationRef, subjectOrganizationName: orgName,
    primaryContactRef, primaryContactName: primaryContactRef ? names[personRefs.findIndex(ref => ref.path === primaryContactRef.path)] || '' : '',
    connectedPersonRefs: personRefs, connectedPersonNames: names,
    ...access,
    leadListId: clean(inheritedData.leadListId), leadListName: clean(inheritedData.leadListName), source: clean(inheritedData.source),
    nextActionRef: inheritedData.nextActionRef || null, nextActionTitle: clean(inheritedData.nextActionTitle),
    nextActionType: clean(inheritedData.nextActionType), nextActionAt: inheritedData.nextActionAt || null,
    lastActivityAt: inheritedData.lastActivityAt || null, lastActivityType: clean(inheritedData.lastActivityType),
    lostReason: clean(inheritedData.lostReason), closeDetails: clean(inheritedData.closeDetails),
    previousActiveStage: clean(inheritedData.previousActiveStage),
    ...(status === 'won' ? {
      wonAt: inheritedData.wonAt || inheritedData.closedAt || now,
      closedAt: inheritedData.closedAt || inheritedData.wonAt || now,
    } : {}),
    ...(status === 'lost' ? {
      lostAt: inheritedData.lostAt || inheritedData.closedAt || now,
      closedAt: inheritedData.closedAt || inheritedData.lostAt || now,
    } : {}),
    ...(inheritedData.closedByRef ? { closedByRef: inheritedData.closedByRef } : {}),
    migrationSource: 'legacy_command_center', migrationId: migrationRef.id,
    migrationCandidateId: candidateRef.id, legacyPersonRefs: personRefs, legacyOrganizationRef: organizationRef,
    migratedAt: now, migratedByRef: ctx.actor.userRef,
    importedAt: inheritedData.importedAt || null, importBatchId: clean(inheritedData.importBatchId),
    createdAt: inheritedData.createdAt || now, legacyUpdatedAt: inheritedData.legacyUpdatedAt || null,
    updatedAt: now, createdByRef: ctx.actor.userRef, createdByUid: ctx.uid, updatedByRef: ctx.actor.userRef,
  };
  const transactionResult = await ctx.db.runTransaction(async transaction => {
    const [leadSnap, candidateSnap] = await Promise.all([transaction.get(leadRef), transaction.get(candidateRef)]);
    if (leadSnap.exists) {
      if (leadSnap.data()?.migrationCandidateId === candidateRef.id || leadSnap.data()?.migrationSource === 'legacy_command_center') {
        transaction.set(candidateRef, { status: 'ready', leadRef }, { merge: true });
        return { duplicate: true, leadData: leadSnap.data() || {} };
      }
      throw new HttpsError('already-exists', 'The deterministic migration Lead ID is already occupied.');
    }
    if (!candidateSnap.exists || candidateSnap.data()?.decision !== 'ready') throw new HttpsError('failed-precondition', 'Candidate is not ready to migrate.');
    transaction.create(leadRef, leadData);
    transaction.set(candidateRef, { status: 'ready', leadRef }, { merge: true });
    return { duplicate: false, leadData };
  });
  const importedEventRef = ctx.db.collection('commandConnections').doc(`lead_imported_${leadRef.id}`);
  await importedEventRef.set({
    type: 'lead_imported', eventType: 'lead_imported',
    summary: `Migrated Lead: ${clean(transactionResult.leadData.displayName)}`,
    body: '', details: { migrationId: migrationRef.id, source: 'legacy_command_center' },
    leadRef, leadName: clean(transactionResult.leadData.displayName), sourceRef: leadRef,
    personRef: transactionResult.leadData.subjectPersonRef || transactionResult.leadData.primaryContactRef || null,
    personName: clean(transactionResult.leadData.subjectPersonName || transactionResult.leadData.primaryContactName),
    organizationRef: transactionResult.leadData.subjectOrganizationRef || null,
    organizationName: clean(transactionResult.leadData.subjectOrganizationName),
    recordType: 'lead', recordName: clean(transactionResult.leadData.displayName),
    ownerRef: transactionResult.leadData.ownerRef || ctx.actor.userRef,
    ownerUid: clean(transactionResult.leadData.ownerUid) || ctx.uid,
    ownerName: clean(transactionResult.leadData.ownerName),
    assignedToRef: transactionResult.leadData.assignedToRef || null,
    assignedToUid: clean(transactionResult.leadData.assignedToUid),
    assignedToName: clean(transactionResult.leadData.assignedToName),
    teamRepIds: transactionResult.leadData.teamRepIds || [],
    viewerUids: transactionResult.leadData.viewerUids || [ctx.uid],
    createdAt: serverTimestamp(), eventAt: serverTimestamp(),
    createdByRef: ctx.actor.userRef, createdByUid: ctx.uid,
    deduplicationKey: `lead_imported:migration:${leadRef.id}`,
  }, { merge: false });
  const backfill = await finishCandidate(candidateRef, () => backfillLead(ctx, leadRef, transactionResult.leadData));
  return { leadRefPath: leadRef.path, duplicate: transactionResult.duplicate, backfill };
}

async function commitService(request) {
  const ctx = await context(request);
  const migrationId = clean(ctx.input.migrationId);
  if (!/^[A-Za-z0-9_-]+$/.test(migrationId)) throw new HttpsError('invalid-argument', 'A valid migrationId is required.');
  const migrationRef = ctx.db.collection(MIGRATIONS).doc(migrationId);
  const migrationSnap = await migrationRef.get();
  if (!migrationSnap.exists) throw new HttpsError('not-found', 'Migration preview not found.');
  if (migrationSnap.data().status === 'building') throw new HttpsError('failed-precondition', 'Wait for the preview to finish before committing.');
  const requested = Array.isArray(ctx.input.candidateIds) ? unique(ctx.input.candidateIds.map(clean)) : [];
  const limit = Math.min(Math.max(Number(ctx.input.limit) || 20, 1), 50);
  let docs;
  if (requested.length) {
    if (requested.length > 50) throw new HttpsError('invalid-argument', 'Commit at most 50 candidates at a time.');
    docs = (await ctx.db.getAll(...requested.map(id => migrationRef.collection('candidates').doc(id)))).filter(snap => snap.exists);
  } else {
    docs = (await migrationRef.collection('candidates').where('status', '==', 'ready').limit(limit).get()).docs;
  }
  const results = [];
  for (const candidateSnap of docs) {
    try {
      results.push({ candidateId: candidateSnap.id, ok: true, ...(await createLead(ctx, migrationRef, candidateSnap.ref, candidateSnap.data() || {})) });
    } catch (error) {
      await candidateSnap.ref.set({ status: 'failed', error: clean(error.message) || 'Migration failed.', failedAt: serverTimestamp() }, { merge: true });
      results.push({ candidateId: candidateSnap.id, ok: false, error: clean(error.message) || 'Migration failed.' });
    }
  }
  const created = results.filter(item => item.ok && !item.duplicate).length;
  const already = results.filter(item => item.ok && item.duplicate).length;
  const failed = results.filter(item => !item.ok).length;
  const linked = results.reduce((sum, item) => sum + Number(item.backfill?.linked || 0), 0);
  const ambiguousBackfills = results.reduce((sum, item) => sum + Number(item.backfill?.ambiguous || 0), 0);
  await migrationRef.set({
    status: failed ? 'partially_committed' : 'committed', lastCommitAt: serverTimestamp(),
    updatedAt: serverTimestamp(), lastCommitByRef: ctx.actor.userRef,
    committedCount: admin.firestore.FieldValue.increment(created),
    lastBatch: { requested: docs.length, created, already, failed, linked, ambiguousBackfills },
  }, { merge: true });
  return { ok: failed === 0, migrationId, requested: docs.length, created, already, failed, linked, ambiguousBackfills, results };
}

exports.previewCommandLeadMigrationService = previewService;
exports.commitCommandLeadMigrationService = commitService;
exports.previewCommandLeadMigration = callable(previewService);
exports.commitCommandLeadMigration = callable(commitService);


exports._test = { finishCandidate, inherited, migrationPage, counts, summary, scopeMatches, relationshipConflict, assertPlatformAdmin };
