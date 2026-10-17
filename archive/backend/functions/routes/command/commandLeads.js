'use strict';

const admin = require('firebase-admin');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const {
  requireAuth,
  requireCommandAccess,
  isPlatformAdminUser,
} = require('../../lib/command/commandPersonUtils');
const { buildCommandAccessMetadata } = require('../../lib/command/commandAccessMetadata');
const { canAssignTo, assignmentActor, assertRecordAssignment } = require('../../lib/command/commandRecordAssignment');

const REGION = 'us-central1';
const COLLECTION = 'commandLeads';
const PEOPLE = 'commandPeople';
const ORGANIZATIONS = 'commandOrganizations';
const USERS = 'users';
const ACTIVE_STAGES = new Set(['New', 'Opened', 'Engaged', 'Closing']);
const ALL_STAGES = new Set([...ACTIVE_STAGES, 'Won', 'Lost']);
const LEAD_TYPES = new Set(['person', 'organization']);
const STATUSES = new Set(['active', 'won', 'lost', 'archived', 'stale']);
const callable = handler => onCall({
  region: REGION,
  cors: true,
  timeoutSeconds: 120,
  memory: '512MiB',
}, handler);

const clean = value => typeof value === 'string' ? value.trim() : '';
const unique = values => [...new Set(values.filter(Boolean))];
const refPath = value => clean(value?.path || value);
const iso = value => value?.toDate ? value.toDate().toISOString() : null;
const samePaths = (left, right) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());

function normalizeLeadType(value) {
  const normalized = clean(value).toLowerCase();
  if (!LEAD_TYPES.has(normalized)) {
    throw new HttpsError('invalid-argument', 'leadType must be person or organization.');
  }
  return normalized;
}

function normalizeStage(value, fallback = 'New') {
  const requested = clean(value || fallback);
  const stage = [...ALL_STAGES].find(item => item.toLowerCase() === requested.toLowerCase());
  if (!stage) {
    throw new HttpsError('invalid-argument', `stage must be one of: ${[...ALL_STAGES].join(', ')}.`);
  }
  return stage;
}

function normalizeStatus(value, fallback = 'active') {
  const status = clean(value || fallback).toLowerCase();
  if (!STATUSES.has(status)) {
    throw new HttpsError('invalid-argument', 'status must be active, won, lost, archived, or stale.');
  }
  return status;
}

function validateStageChange(status, currentStage, nextStage) {
  if (status === 'active' && !ACTIVE_STAGES.has(nextStage)) {
    throw new HttpsError('failed-precondition', 'Use closeCommandLead to mark a Lead Won or Lost.');
  }
  if (status !== 'active' && nextStage !== currentStage) {
    throw new HttpsError('failed-precondition', 'Closed Leads cannot change stage without an explicit reopen operation.');
  }
}

function documentPath(value, collection, field, required = false) {
  const parts = refPath(value).split('/').filter(Boolean);
  if (!parts.length && !required) return '';
  if (parts.length !== 2 || parts[0] !== collection) {
    throw new HttpsError('invalid-argument', `${field} must use ${collection}/{documentId}.`);
  }
  return parts.join('/');
}

function documentPaths(values, collection, field) {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values)) throw new HttpsError('invalid-argument', `${field} must be a list.`);
  return unique(values.map(value => documentPath(value, collection, field, true)));
}

function personName(data = {}) {
  return clean(data.fullName) ||
    [clean(data.firstName), clean(data.lastName)].filter(Boolean).join(' ') ||
    clean(data.displayName) || clean(data.email) || 'Unnamed Person';
}

function organizationName(data = {}) {
  return clean(data.organization) || clean(data.name) || clean(data.displayName) || 'Unnamed Organization';
}

function canSee(uid, actorData, data = {}) {
  if (isPlatformAdminUser(actorData)) return true;
  if (data.status === 'stale' || (data.archived === true && data.statusBeforeArchive === 'stale')) return false;
  const repId = clean(String(actorData?.repId ?? ''));
  return clean(data.ownerUid) === uid || clean(data.assignedToUid) === uid ||
    (Array.isArray(data.viewerUids) && data.viewerUids.includes(uid)) ||
    (repId && Array.isArray(data.teamRepIds) && data.teamRepIds.map(String).includes(repId));
}

async function actorContext(request) {
  const db = admin.firestore();
  const uid = requireAuth(request);
  const actor = await requireCommandAccess(db, uid);
  return { db, uid, actor, input: request.data || {} };
}

async function readVisible(ctx, pathValue, collection, field, required = false) {
  const path = documentPath(pathValue, collection, field, required);
  if (!path) return null;
  const ref = ctx.db.doc(path);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.archived === true) {
    throw new HttpsError('not-found', `${field} was not found or is archived.`);
  }
  const data = snap.data() || {};
  if (!canSee(ctx.uid, ctx.actor.userData, data)) {
    throw new HttpsError('permission-denied', `You do not have access to the selected ${field}.`);
  }
  return { ref, data };
}

async function readPeople(ctx, paths) {
  const records = [];
  for (const path of unique(paths)) {
    records.push(await readVisible(ctx, path, PEOPLE, 'connectedPersonRefPaths', true));
  }
  return records;
}

async function readLead(ctx, forAssignment = false) {
  const path = documentPath(ctx.input.leadRefPath || ctx.input.refPath, COLLECTION, 'leadRefPath', true);
  const ref = ctx.db.doc(path);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Lead not found.');
  const data = snap.data() || {};
  if (!forAssignment && !canSee(ctx.uid, ctx.actor.userData, data)) {
    throw new HttpsError('permission-denied', 'You do not have access to this Lead.');
  }
  return { ref, data, updateTime: snap.updateTime };
}

function defaultLeadName(leadType, person, organization) {
  return leadType === 'organization'
    ? organizationName(organization?.data)
    : personName(person?.data);
}

function searchText(displayName, relationships) {
  const values = [
    displayName,
    relationships.person ? personName(relationships.person.data) : '',
    relationships.organization ? organizationName(relationships.organization.data) : '',
    relationships.primary ? personName(relationships.primary.data) : '',
    ...relationships.people.flatMap(record => [
      personName(record.data),
      clean(record.data.email),
      clean(record.data.emailNormalized),
      clean(record.data.phone),
      clean(record.data.phoneNormalized),
    ]),
  ];
  return unique(values.map(value => clean(value).toLowerCase())).join(' ');
}

function serializeLead(ref, data = {}) {
  return {
    id: ref.id,
    refPath: ref.path,
    displayName: clean(data.displayName),
    displayNameNormalized: clean(data.displayNameNormalized),
    notes: clean(data.notes),
    opportunityDetails: clean(data.opportunityDetails),
    leadType: clean(data.leadType),
    stage: clean(data.stage),
    status: clean(data.status),
    archived: data.archived === true,
    subjectPersonRefPath: refPath(data.subjectPersonRef),
    subjectPersonName: clean(data.subjectPersonName),
    subjectOrganizationRefPath: refPath(data.subjectOrganizationRef),
    subjectOrganizationName: clean(data.subjectOrganizationName),
    primaryContactRefPath: refPath(data.primaryContactRef),
    primaryContactName: clean(data.primaryContactName),
    connectedPersonRefPaths: (data.connectedPersonRefs || []).map(refPath).filter(Boolean),
    connectedPersonNames: Array.isArray(data.connectedPersonNames) ? data.connectedPersonNames : [],
    assignedToRefPath: refPath(data.assignedToRef),
    assignedToUid: clean(data.assignedToUid),
    assignedToName: clean(data.assignedToName),
    ownerRefPath: refPath(data.ownerRef),
    ownerUid: clean(data.ownerUid),
    ownerName: clean(data.ownerName),
    viewerUids: Array.isArray(data.viewerUids) ? data.viewerUids : [],
    teamRepIds: Array.isArray(data.teamRepIds) ? data.teamRepIds : [],
    leadListId: clean(data.leadListId),
    leadListName: clean(data.leadListName),
    source: clean(data.source),
    nextActionRefPath: refPath(data.nextActionRef),
    nextActionTitle: clean(data.nextActionTitle),
    nextActionType: clean(data.nextActionType),
    nextActionAt: iso(data.nextActionAt),
    lastActivityAt: iso(data.lastActivityAt),
    lastActivityType: clean(data.lastActivityType),
    lostReason: clean(data.lostReason),
    wonAt: iso(data.wonAt),
    lostAt: iso(data.lostAt),
    closedAt: iso(data.closedAt),
    closedByRefPath: refPath(data.closedByRef),
    archivedAt: iso(data.archivedAt),
    archivedByRefPath: refPath(data.archivedByRef),
    statusBeforeArchive: clean(data.statusBeforeArchive),
    createdByUid: clean(data.createdByUid),
    createdByRefPath: refPath(data.createdByRef),
    updatedByRefPath: refPath(data.updatedByRef),
    createdAt: iso(data.createdAt),
    updatedAt: iso(data.updatedAt),
  };
}

function connectionPayload(ctx, lead, type, summary, details = {}) {
  const data = lead.data || {};
  return {
    type,
    summary,
    body: clean(details.notes || details.reason),
    details,
    leadRef: lead.ref,
    leadName: clean(data.displayName),
    sourceRef: lead.ref,
    personRef: data.subjectPersonRef || data.primaryContactRef || null,
    personName: clean(data.subjectPersonName || data.primaryContactName),
    organizationRef: data.subjectOrganizationRef || null,
    organizationName: clean(data.subjectOrganizationName),
    recordType: 'lead',
    recordName: clean(data.displayName),
    ownerRef: data.ownerRef || ctx.actor.userRef,
    ownerUid: clean(data.ownerUid) || ctx.uid,
    ownerName: clean(data.ownerName),
    assignedToRef: data.assignedToRef || null,
    assignedToUid: clean(data.assignedToUid),
    assignedToName: clean(data.assignedToName),
    teamRepIds: data.teamRepIds || [],
    viewerUids: data.viewerUids || [ctx.uid],
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    createdByRef: ctx.actor.userRef,
    createdByUid: ctx.uid,
    createdByName: clean(ctx.actor.userData?.fullName) || clean(ctx.actor.userData?.displayName) || 'Experience Command',
  };
}

async function resolveAssignee(ctx, rawPath, fallbackRef = null) {
  const path = documentPath(rawPath, USERS, 'assignedToRefPath', false);
  const ref = path ? ctx.db.doc(path) : (fallbackRef || ctx.actor.userRef);
  const snap = await ref.get();
  const data = snap.data() || {};
  if (!snap.exists || data.active === false || data.userType !== 'rep') {
    throw new HttpsError('failed-precondition', 'The assigned representative must be active.');
  }
  const authority = await assignmentActor(ctx.db, ctx.uid, ctx.actor.userData);
  if (!canAssignTo(authority, ref.id, data)) {
    throw new HttpsError('permission-denied', 'You may assign Leads only to yourself or an active representative on your team.');
  }
  return { ref, data };
}

async function resolveRelationships(ctx, input, current = {}) {
  const leadType = normalizeLeadType(input.leadType ?? current.leadType);
  const personPath = input.subjectPersonRefPath !== undefined
    ? input.subjectPersonRefPath
    : refPath(current.subjectPersonRef);
  const organizationPath = input.subjectOrganizationRefPath !== undefined
    ? input.subjectOrganizationRefPath
    : refPath(current.subjectOrganizationRef);
  const person = await readVisible(ctx, personPath, PEOPLE, 'subjectPersonRefPath', leadType === 'person');
  const organization = await readVisible(ctx, organizationPath, ORGANIZATIONS, 'subjectOrganizationRefPath', leadType === 'organization');

  const requestedConnected = input.connectedPersonRefPaths !== undefined
    ? documentPaths(input.connectedPersonRefPaths, PEOPLE, 'connectedPersonRefPaths')
    : (current.connectedPersonRefs || []).map(refPath);
  const primaryPath = input.primaryContactRefPath !== undefined
    ? documentPath(input.primaryContactRefPath, PEOPLE, 'primaryContactRefPath', false)
    : refPath(current.primaryContactRef);
  const allPaths = unique([
    ...requestedConnected,
    person?.ref.path,
    primaryPath,
  ]);
  const people = await readPeople(ctx, allPaths);
  const byPath = new Map(people.map(record => [record.ref.path, record]));
  const primary = primaryPath ? byPath.get(primaryPath) : (leadType === 'person' ? person : null);
  if (primaryPath && !primary) {
    throw new HttpsError('failed-precondition', 'The primary contact must be connected to the Lead.');
  }
  return {
    leadType,
    person: leadType === 'person' ? person : null,
    organization,
    people,
    primary,
  };
}

async function createCommandLeadService(request) {
  const ctx = await actorContext(request);
  const relationships = await resolveRelationships(ctx, ctx.input);
  const assignee = await resolveAssignee(ctx, ctx.input.assignedToRefPath);
  const access = await buildCommandAccessMetadata(ctx.db, {
    actorRef: ctx.actor.userRef,
    ownerRef: ctx.actor.userRef,
    assignedToRef: assignee.ref,
  });
  const displayName = clean(ctx.input.displayName) || defaultLeadName(
    relationships.leadType,
    relationships.person,
    relationships.organization
  );
  if (!displayName || displayName.length > 200) {
    throw new HttpsError('invalid-argument', 'Lead name is required and must be 200 characters or fewer.');
  }
  const stage = normalizeStage(ctx.input.stage, 'New');
  if (!ACTIVE_STAGES.has(stage)) {
    throw new HttpsError('invalid-argument', 'New Leads must begin in an active stage.');
  }
  const now = admin.firestore.FieldValue.serverTimestamp();
  const ref = ctx.db.collection(COLLECTION).doc();
  const data = {
    displayName,
    displayNameNormalized: displayName.toLowerCase(),
    searchTextNormalized: searchText(displayName, relationships),
    leadType: relationships.leadType,
    stage,
    status: 'active',
    archived: false,
    subjectPersonRef: relationships.person?.ref || null,
    subjectPersonName: relationships.person ? personName(relationships.person.data) : '',
    subjectOrganizationRef: relationships.organization?.ref || null,
    subjectOrganizationName: relationships.organization ? organizationName(relationships.organization.data) : '',
    primaryContactRef: relationships.primary?.ref || null,
    primaryContactName: relationships.primary ? personName(relationships.primary.data) : '',
    connectedPersonRefs: relationships.people.map(record => record.ref),
    connectedPersonNames: relationships.people.map(record => personName(record.data)),
    leadListId: clean(ctx.input.leadListId),
    leadListName: clean(ctx.input.leadListName),
    source: clean(ctx.input.source),
    stageEnteredAt: now,
    nextActionRef: null,
    nextActionTitle: '',
    nextActionType: '',
    nextActionAt: null,
    lastActivityAt: null,
    lastActivityType: '',
    wonAt: null,
    lostAt: null,
    lostReason: '',
    archivedAt: null,
    ...access,
    createdAt: now,
    updatedAt: now,
    createdByRef: ctx.actor.userRef,
    createdByUid: ctx.uid,
    updatedByRef: ctx.actor.userRef,
  };
  const connectionRef = ctx.db.collection('commandConnections').doc();
  const batch = ctx.db.batch();
  batch.create(ref, data);
  batch.create(connectionRef, connectionPayload(ctx, { ref, data }, 'lead_created', `Lead created: ${displayName}`, {
    leadType: relationships.leadType,
    stage,
    source: data.source,
    leadListId: data.leadListId,
  }));
  await batch.commit();
  return { ok: true, result: 'success', lead: serializeLead(ref, data), leadRefPath: ref.path };
}

async function updateCommandLeadService(request, deps = {}) {
  const ctx = await (deps.context || actorContext)(request);
  if (ctx.actor.userData.active === false) throw new HttpsError('permission-denied', 'Inactive representatives cannot edit Leads.');
  const target = await readLead(ctx);
  if (ctx.input.expectedUpdatedAt && iso(target.data.updatedAt) !== ctx.input.expectedUpdatedAt) throw new HttpsError('aborted', 'This Lead changed. Reload before saving.');
  if (target.data.archived === true) throw new HttpsError('failed-precondition', 'Restore this Lead before editing it.');
  if (ctx.input.leadType !== undefined &&
      normalizeLeadType(ctx.input.leadType) !== clean(target.data.leadType)) {
    throw new HttpsError('failed-precondition', 'Use convertCommandLeadType to change the Lead type.');
  }
  const relationships = await resolveRelationships(ctx, ctx.input, target.data);
  const displayName = ctx.input.displayName === undefined
    ? clean(target.data.displayName)
    : clean(ctx.input.displayName) || defaultLeadName(relationships.leadType, relationships.person, relationships.organization);
  if (!displayName || displayName.length > 200) {
    throw new HttpsError('invalid-argument', 'Lead name is required and must be 200 characters or fewer.');
  }
  const stage = ctx.input.stage === undefined ? clean(target.data.stage) : normalizeStage(ctx.input.stage);
  const status = normalizeStatus(target.data.status || 'active');
  validateStageChange(status, clean(target.data.stage), stage);
  const now = admin.firestore.FieldValue.serverTimestamp();
  const update = {
    displayName,
    displayNameNormalized: displayName.toLowerCase(),
    searchTextNormalized: searchText(displayName, relationships),
    leadType: relationships.leadType,
    stage,
    subjectPersonRef: relationships.person?.ref || null,
    subjectPersonName: relationships.person ? personName(relationships.person.data) : '',
    subjectOrganizationRef: relationships.organization?.ref || null,
    subjectOrganizationName: relationships.organization ? organizationName(relationships.organization.data) : '',
    primaryContactRef: relationships.primary?.ref || null,
    primaryContactName: relationships.primary ? personName(relationships.primary.data) : '',
    connectedPersonRefs: relationships.people.map(record => record.ref),
    connectedPersonNames: relationships.people.map(record => personName(record.data)),
    leadListId: ctx.input.leadListId === undefined ? clean(target.data.leadListId) : clean(ctx.input.leadListId),
    leadListName: ctx.input.leadListName === undefined ? clean(target.data.leadListName) : clean(ctx.input.leadListName),
    source: ctx.input.source === undefined ? clean(target.data.source) : clean(ctx.input.source),
    updatedAt: now,
    updatedByRef: ctx.actor.userRef,
  };
  for (const key of ['notes', 'opportunityDetails']) {
    if (ctx.input[key] !== undefined) {
      if (typeof ctx.input[key] !== 'string' || ctx.input[key].length > 5000) throw new HttpsError('invalid-argument', `${key} must be text with at most 5,000 characters.`);
      update[key] = clean(ctx.input[key]);
    }
  }
  const stageChanged = stage !== clean(target.data.stage);
  if (stageChanged) {
    const reason = clean(ctx.input.stageChangeReason || ctx.input.reason);
    if (!reason || reason.length > 2000) throw new HttpsError('invalid-argument', 'Explain what changed (1–2,000 characters).');
    update.stageEnteredAt = now;
  }
  const relationshipsChanged =
    refPath(update.subjectPersonRef) !== refPath(target.data.subjectPersonRef) ||
    refPath(update.subjectOrganizationRef) !== refPath(target.data.subjectOrganizationRef) ||
    refPath(update.primaryContactRef) !== refPath(target.data.primaryContactRef) ||
    !samePaths(update.connectedPersonRefs.map(refPath), (target.data.connectedPersonRefs || []).map(refPath));
  const batch = ctx.db.batch();
  batch.update(target.ref, update, { lastUpdateTime: target.updateTime });
  if (stageChanged) {
    const connectionRef = ctx.db.collection('commandConnections').doc();
    batch.create(connectionRef, connectionPayload(ctx, { ref: target.ref, data: { ...target.data, ...update } }, 'lead_stage_changed', `${displayName} moved to ${stage}`, {
      previousStage: clean(target.data.stage),
      stage,
      reason: clean(ctx.input.stageChangeReason || ctx.input.reason),
    }));
  }
  if (relationshipsChanged) {
    const connectionRef = ctx.db.collection('commandConnections').doc();
    batch.create(connectionRef, connectionPayload(ctx, { ref: target.ref, data: { ...target.data, ...update } }, 'lead_relationships_changed', `Lead relationships updated: ${displayName}`, {
      previousSubjectPersonRefPath: refPath(target.data.subjectPersonRef),
      previousSubjectOrganizationRefPath: refPath(target.data.subjectOrganizationRef),
      subjectPersonRefPath: refPath(update.subjectPersonRef),
      subjectOrganizationRefPath: refPath(update.subjectOrganizationRef),
      primaryContactRefPath: refPath(update.primaryContactRef),
      connectedPersonRefPaths: update.connectedPersonRefs.map(refPath),
    }));
  }
  const detailFields = ['notes', 'opportunityDetails'].filter(key => update[key] !== undefined && update[key] !== clean(target.data[key]));
  if (detailFields.length) batch.create(ctx.db.collection('commandConnections').doc(), connectionPayload(ctx, { ref: target.ref, data: { ...target.data, ...update } }, 'lead_details_updated', `Lead details updated: ${displayName}`, { changedFields: detailFields, notes: clean(update.notes || update.opportunityDetails) }));
  await batch.commit();
  return { ok: true, result: 'success', leadRefPath: target.ref.path, stageChanged, relationshipsChanged };
}

async function assignCommandLeadService(request) {
  const ctx = await actorContext(request);
  const target = await readLead(ctx, true);
  if (target.data.status === 'stale' || target.data.statusBeforeArchive === 'stale' && target.data.archived === true) throw new HttpsError('failed-precondition', 'Use Stale Lead Management to reassign this Lead.');
  const assignee = await resolveAssignee(ctx, ctx.input.assignedToRefPath);
  const authority = await assignmentActor(ctx.db, ctx.uid, ctx.actor.userData);
  await assertRecordAssignment(ctx.db, authority, target.data, assignee.ref);
  const access = await buildCommandAccessMetadata(ctx.db, {
    actorRef: ctx.actor.userRef,
    ownerRef: target.data.ownerRef || ctx.actor.userRef,
    assignedToRef: assignee.ref,
  });
  const now = admin.firestore.FieldValue.serverTimestamp();
  const update = { ...access, updatedAt: now, updatedByRef: ctx.actor.userRef };
  const connectionRef = ctx.db.collection('commandConnections').doc();
  const batch = ctx.db.batch();
  batch.update(target.ref, update, { lastUpdateTime: target.updateTime });
  batch.create(connectionRef, connectionPayload(ctx, { ref: target.ref, data: { ...target.data, ...update } }, 'lead_assigned', `Lead assigned to ${access.assignedToName || assignee.ref.id}`, {
    previousAssignedToUid: clean(target.data.assignedToUid),
    assignedToUid: access.assignedToUid,
  }));
  await batch.commit();
  return { ok: true, result: 'success', leadRefPath: target.ref.path, assignedToUid: access.assignedToUid, assignedToName: access.assignedToName };
}

async function setCommandLeadContactsService(request) {
  const ctx = await actorContext(request);
  const target = await readLead(ctx);
  const relationships = await resolveRelationships(ctx, {
    leadType: target.data.leadType,
    subjectPersonRefPath: refPath(target.data.subjectPersonRef),
    subjectOrganizationRefPath: refPath(target.data.subjectOrganizationRef),
    connectedPersonRefPaths: ctx.input.connectedPersonRefPaths,
    primaryContactRefPath: ctx.input.primaryContactRefPath,
  }, target.data);
  const now = admin.firestore.FieldValue.serverTimestamp();
  const update = {
    primaryContactRef: relationships.primary?.ref || null,
    primaryContactName: relationships.primary ? personName(relationships.primary.data) : '',
    connectedPersonRefs: relationships.people.map(record => record.ref),
    connectedPersonNames: relationships.people.map(record => personName(record.data)),
    updatedAt: now,
    updatedByRef: ctx.actor.userRef,
  };
  const connectionRef = ctx.db.collection('commandConnections').doc();
  const batch = ctx.db.batch();
  batch.update(target.ref, update);
  batch.create(connectionRef, connectionPayload(ctx, { ref: target.ref, data: { ...target.data, ...update } }, 'lead_contacts_changed', `Lead contacts updated: ${clean(target.data.displayName)}`, {
    primaryContactRefPath: refPath(update.primaryContactRef),
    connectedPersonRefPaths: update.connectedPersonRefs.map(refPath),
  }));
  await batch.commit();
  return { ok: true, result: 'success', leadRefPath: target.ref.path };
}

async function convertCommandLeadTypeService(request) {
  const ctx = await actorContext(request);
  const target = await readLead(ctx);
  if (target.data.archived === true || clean(target.data.status) !== 'active') {
    throw new HttpsError('failed-precondition', 'Only active Leads can be converted.');
  }
  const nextType = normalizeLeadType(ctx.input.leadType);
  if (nextType === clean(target.data.leadType)) {
    return { ok: true, result: 'success', duplicate: true, leadRefPath: target.ref.path, leadType: nextType };
  }
  const relationships = await resolveRelationships(ctx, {
    leadType: nextType,
    subjectPersonRefPath: ctx.input.subjectPersonRefPath ?? refPath(target.data.subjectPersonRef),
    subjectOrganizationRefPath: ctx.input.subjectOrganizationRefPath ?? refPath(target.data.subjectOrganizationRef),
    connectedPersonRefPaths: ctx.input.connectedPersonRefPaths ?? (target.data.connectedPersonRefs || []).map(refPath),
    primaryContactRefPath: ctx.input.primaryContactRefPath ?? refPath(target.data.primaryContactRef),
  }, target.data);
  const displayName = clean(ctx.input.displayName) || defaultLeadName(nextType, relationships.person, relationships.organization);
  const now = admin.firestore.FieldValue.serverTimestamp();
  const update = {
    leadType: nextType,
    displayName,
    displayNameNormalized: displayName.toLowerCase(),
    searchTextNormalized: searchText(displayName, relationships),
    subjectPersonRef: relationships.person?.ref || null,
    subjectPersonName: relationships.person ? personName(relationships.person.data) : '',
    subjectOrganizationRef: relationships.organization?.ref || null,
    subjectOrganizationName: relationships.organization ? organizationName(relationships.organization.data) : '',
    primaryContactRef: relationships.primary?.ref || null,
    primaryContactName: relationships.primary ? personName(relationships.primary.data) : '',
    connectedPersonRefs: relationships.people.map(record => record.ref),
    connectedPersonNames: relationships.people.map(record => personName(record.data)),
    updatedAt: now,
    updatedByRef: ctx.actor.userRef,
  };
  const connectionRef = ctx.db.collection('commandConnections').doc();
  const batch = ctx.db.batch();
  batch.update(target.ref, update);
  batch.create(connectionRef, connectionPayload(ctx, { ref: target.ref, data: { ...target.data, ...update } }, 'lead_type_converted', `Lead converted to ${nextType}`, {
    previousLeadType: clean(target.data.leadType),
    leadType: nextType,
    previousSubjectPersonRefPath: refPath(target.data.subjectPersonRef),
    previousSubjectOrganizationRefPath: refPath(target.data.subjectOrganizationRef),
    subjectPersonRefPath: refPath(update.subjectPersonRef),
    subjectOrganizationRefPath: refPath(update.subjectOrganizationRef),
  }));
  await batch.commit();
  return { ok: true, result: 'success', duplicate: false, leadRefPath: target.ref.path, leadType: nextType };
}

async function closeCommandLeadService(request, deps = {}) {
  const ctx = await (deps.context || actorContext)(request);
  const path = documentPath(ctx.input.leadRefPath || ctx.input.refPath, COLLECTION, 'leadRefPath', true);
  const ref = ctx.db.doc(path);
  const outcome = clean(ctx.input.outcome).toLowerCase();
  if (!['won', 'lost'].includes(outcome)) throw new HttpsError('invalid-argument', 'outcome must be won or lost.');
  const lostReason = clean(ctx.input.lostReason);
  if (outcome === 'lost' && !lostReason) throw new HttpsError('invalid-argument', 'A Lost reason is required.');
  if (lostReason.length > 2000 || clean(ctx.input.notes).length > 5000) throw new HttpsError('invalid-argument', 'Closing notes are too long.');
  return ctx.db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Lead not found.');
    const data = snap.data();
    if (ctx.actor.userData.active === false || !canSee(ctx.uid, ctx.actor.userData, data)) throw new HttpsError('permission-denied', 'Lead is not accessible.');
    if (data.archived === true) throw new HttpsError('failed-precondition', 'Restore this Lead before closing it.');
    if (data.status === outcome) return { ok: true, duplicate: true, leadRefPath: path, outcome, remainingWorkUnchanged: true };
    if (data.status !== 'active') throw new HttpsError('failed-precondition', 'This Lead is already closed. Refresh before continuing.');
    if (ctx.input.expectedUpdatedAt && iso(data.updatedAt) !== ctx.input.expectedUpdatedAt) throw new HttpsError('aborted', 'This Lead changed. Reload before closing.');
    const now = admin.firestore.FieldValue.serverTimestamp();
    const update = { stage: outcome === 'won' ? 'Won' : 'Lost', status: outcome,
      previousActiveStage: clean(data.stage), stageEnteredAt: now,
      lostReason: outcome === 'lost' ? lostReason : '', wonAt: outcome === 'won' ? now : null,
      lostAt: outcome === 'lost' ? now : null, closedAt: now, closedByRef: ctx.actor.userRef,
      updatedAt: now, updatedByRef: ctx.actor.userRef };
    const connectionRef = ctx.db.collection('commandConnections').doc();
    tx.update(ref, update);
    tx.create(connectionRef, connectionPayload(ctx, { ref, data: { ...data, ...update } }, `lead_${outcome}`, `Lead ${outcome}: ${clean(data.displayName)}`, {
      previousStage: clean(data.stage), outcome, lostReason: update.lostReason, notes: clean(ctx.input.notes),
    }));
    return { ok: true, result: 'success', duplicate: false, leadRefPath: path, outcome, remainingWorkUnchanged: true };
  });
}

async function archiveCommandLeadService(request) {
  const ctx = await actorContext(request);
  const target = await readLead(ctx);
  if (target.data.archived === true) return { ok: true, result: 'success', duplicate: true, leadRefPath: target.ref.path };
  const now = admin.firestore.FieldValue.serverTimestamp();
  const update = {
    archived: true,
    statusBeforeArchive: clean(target.data.status) || 'active',
    status: 'archived',
    archivedAt: now,
    archivedByRef: ctx.actor.userRef,
    updatedAt: now,
    updatedByRef: ctx.actor.userRef,
  };
  const connectionRef = ctx.db.collection('commandConnections').doc();
  const batch = ctx.db.batch();
  batch.update(target.ref, update, { lastUpdateTime: target.updateTime });
  batch.create(connectionRef, connectionPayload(ctx, { ref: target.ref, data: { ...target.data, ...update } }, 'lead_archived', `Lead archived: ${clean(target.data.displayName)}`));
  await batch.commit();
  return { ok: true, result: 'success', duplicate: false, leadRefPath: target.ref.path };
}

async function restoreCommandLeadService(request) {
  const ctx = await actorContext(request);
  const target = await readLead(ctx);
  if (target.data.archived !== true) return { ok: true, result: 'success', duplicate: true, leadRefPath: target.ref.path };
  const previous = normalizeStatus(target.data.statusBeforeArchive || 'active');
  const status = previous === 'archived' ? 'active' : previous;
  const now = admin.firestore.FieldValue.serverTimestamp();
  const update = {
    archived: false,
    status,
    archivedAt: null,
    archivedByRef: null,
    updatedAt: now,
    updatedByRef: ctx.actor.userRef,
  };
  const connectionRef = ctx.db.collection('commandConnections').doc();
  const batch = ctx.db.batch();
  batch.update(target.ref, update, { lastUpdateTime: target.updateTime });
  batch.create(connectionRef, connectionPayload(ctx, { ref: target.ref, data: { ...target.data, ...update } }, 'lead_restored', `Lead restored: ${clean(target.data.displayName)}`));
  await batch.commit();
  return { ok: true, result: 'success', duplicate: false, leadRefPath: target.ref.path, status };
}

async function getCommandLeadService(request) {
  const ctx = await actorContext(request);
  const target = await readLead(ctx);
  return { ok: true, result: 'success', lead: serializeLead(target.ref, target.data) };
}

function matchesFilters(data, input) {
  const archived = input.archived === true;
  if ((data.archived === true) !== archived) return false;
  if (clean(input.leadType) && clean(data.leadType) !== clean(input.leadType).toLowerCase()) return false;
  if (clean(input.stage) && clean(data.stage).toLowerCase() !== clean(input.stage).toLowerCase()) return false;
  if (clean(input.status) && clean(data.status).toLowerCase() !== clean(input.status).toLowerCase()) return false;
  if (clean(input.assignedToUid) && clean(data.assignedToUid) !== clean(input.assignedToUid)) return false;
  if (clean(input.leadListId) && clean(data.leadListId) !== clean(input.leadListId)) return false;
  const search = clean(input.search || input.query).toLowerCase();
  if (!search) return true;
  if (clean(data.searchTextNormalized).includes(search)) return true;
  return [
    data.displayName,
    data.subjectPersonName,
    data.subjectOrganizationName,
    data.primaryContactName,
    ...(data.connectedPersonNames || []),
  ].some(value => clean(value).toLowerCase().includes(search));
}

async function listCommandLeadsPageService(request) {
  const ctx = await actorContext(request);
  return require('../../lib/command/commandLeadWorkspace').listLeads(ctx, { serializeLead, matchesFilters });
}

exports.createCommandLead = callable(createCommandLeadService);
exports.updateCommandLead = callable(updateCommandLeadService);
exports.getCommandLead = callable(getCommandLeadService);
exports.listCommandLeadsPage = callable(listCommandLeadsPageService);
exports.searchCommandLeads = callable(listCommandLeadsPageService);
exports.assignCommandLead = callable(assignCommandLeadService);
exports.setCommandLeadContacts = callable(setCommandLeadContactsService);
exports.convertCommandLeadType = callable(convertCommandLeadTypeService);
exports.closeCommandLead = callable(closeCommandLeadService);
exports.archiveCommandLead = callable(archiveCommandLeadService);
exports.restoreCommandLead = callable(restoreCommandLeadService);

exports._test = {
  normalizeLeadType,
  normalizeStage,
  normalizeStatus,
  validateStageChange,
  documentPath,
  documentPaths,
  defaultLeadName,
  searchText,
  canSee,
  matchesFilters,
  serializeLead,
};




exports.closeCommandLeadService = closeCommandLeadService;

exports.updateCommandLeadService = updateCommandLeadService;

