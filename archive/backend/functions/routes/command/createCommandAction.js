'use strict';

const admin = require('firebase-admin');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const {
  requireAuth,
  requireCommandAccess,
  isPlatformAdminUser,
} = require('../../lib/command/commandPersonUtils');
const {
  buildCommandAccessMetadata,
} = require('../../lib/command/commandAccessMetadata');
const {
  canAssignCommandAction,
} = require('../../lib/command/commandActionAssignment');

const ACTIONS_COLLECTION = 'commandActions';
const PEOPLE_COLLECTION = 'commandPeople';
const ORGANIZATIONS_COLLECTION = 'commandOrganizations';
const USERS_COLLECTION = 'users';
const LEADS_COLLECTION = 'commandLeads';
const ALLOWED_RELATED_TYPES = new Set(['Person', 'Organization', 'General']);
const ALLOWED_PRIORITIES = new Set(['Low', 'Medium', 'High']);

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function actorName(data = {}) {
  return clean(data.fullName) ||
    [clean(data.firstName), clean(data.lastName)].filter(Boolean).join(' ') ||
    clean(data.displayName) || clean(data.name) || clean(data.email) ||
    'Experience Command';
}

function canSeeLead(uid, actorData, data = {}) {
  if (isPlatformAdminUser(actorData)) return true;
  const repId = clean(String(actorData?.repId ?? ''));
  return clean(data.ownerUid) === uid || clean(data.assignedToUid) === uid ||
    (Array.isArray(data.viewerUids) && data.viewerUids.includes(uid)) ||
    (repId && Array.isArray(data.teamRepIds) && data.teamRepIds.map(String).includes(repId));
}

function normalizeChoice(value, allowedValues) {
  const input = clean(value).toLowerCase();
  return [...allowedValues].find((item) => item.toLowerCase() === input) || '';
}

function validatePath(rawPath, expectedCollection, fieldName) {
  const path = clean(rawPath);
  if (!path) return '';

  const parts = path.split('/').filter(Boolean);
  if (parts.length !== 2 || parts[0] !== expectedCollection) {
    throw new HttpsError(
      'invalid-argument',
      `${fieldName} must use ${expectedCollection}/{documentId}.`
    );
  }

  return parts.join('/');
}

async function resolveExistingDocument(db, rawPath, collection, fieldName) {
  const path = validatePath(rawPath, collection, fieldName);
  if (!path) return null;

  const ref = db.doc(path);
  const snapshot = await ref.get();
  if (!snapshot.exists) {
    throw new HttpsError(
      'invalid-argument',
      `The selected ${fieldName} does not exist.`
    );
  }

  return { ref, data: snapshot.data() || {} };
}

function personName(data) {
  return clean(data.fullName) ||
    [clean(data.firstName), clean(data.lastName)].filter(Boolean).join(' ');
}

function organizationName(data) {
  return clean(data.organization) || clean(data.name);
}

function parseDueAt(value) {
  if (value instanceof admin.firestore.Timestamp) return value;

  if (
    value &&
    typeof value === 'object' &&
    Number.isFinite(value.seconds)
  ) {
    return new admin.firestore.Timestamp(
      value.seconds,
      Number.isFinite(value.nanoseconds) ? value.nanoseconds : 0
    );
  }

  const date = value instanceof Date
    ? value
    : new Date(typeof value === 'number' ? value : clean(value));

  if (Number.isNaN(date.getTime())) {
    throw new HttpsError(
      'invalid-argument',
      'A valid due date and time is required.'
    );
  }

  return admin.firestore.Timestamp.fromDate(date);
}

function dueDateKey(timestamp) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Edmonton',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(timestamp.toDate());

  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );

  return `${values.year}-${values.month}-${values.day}`;
}

async function createCommandActionService(request) {
  const db = admin.firestore();
  const uid = requireAuth(request);
  const { userRef, userData } = await requireCommandAccess(db, uid);
  const input = request.data || {};

  const title = clean(input.title);
  const description = clean(input.description);
  const actionType = clean(input.actionType);
  const priority = normalizeChoice(input.priority, ALLOWED_PRIORITIES);
  const relatedType = normalizeChoice(
    input.relatedType,
    ALLOWED_RELATED_TYPES
  );

  if (!title) {
    throw new HttpsError('invalid-argument', 'Action title is required.');
  }
  if (title.length > 200) {
    throw new HttpsError(
      'invalid-argument',
      'Action title must be 200 characters or fewer.'
    );
  }
  if (description.length > 5000) {
    throw new HttpsError(
      'invalid-argument',
      'Action description must be 5,000 characters or fewer.'
    );
  }
  if (!actionType) {
    throw new HttpsError('invalid-argument', 'Action type is required.');
  }
  if (actionType.toLowerCase() === 'meeting') {
    throw new HttpsError(
      'failed-precondition',
      'Meetings must be created with createCommandMeeting.'
    );
  }
  if (!priority) {
    throw new HttpsError(
      'invalid-argument',
      'Priority must be Low, Medium, or High.'
    );
  }
  if (!relatedType) {
    throw new HttpsError(
      'invalid-argument',
      'Related type must be Person, Organization, or General.'
    );
  }

  const dueAt = parseDueAt(input.dueAt);
  const [assignedTo, selectedPerson, selectedOrganization] = await Promise.all([
    resolveExistingDocument(
      db,
      input.assignedToRefPath,
      USERS_COLLECTION,
      'assigned representative'
    ),
    resolveExistingDocument(
      db,
      input.personRefPath,
      PEOPLE_COLLECTION,
      'Person'
    ),
    resolveExistingDocument(
      db,
      input.organizationRefPath,
      ORGANIZATIONS_COLLECTION,
      'Organization'
    ),
  ]);
  const selectedLead = await resolveExistingDocument(
    db,
    input.leadRefPath,
    LEADS_COLLECTION,
    'Lead'
  );

  if (selectedLead) {
    if (!canSeeLead(uid, userData, selectedLead.data)) {
      throw new HttpsError('permission-denied', 'You do not have access to the selected Lead.');
    }
    if (selectedLead.data.archived === true || clean(selectedLead.data.status) !== 'active') {
      throw new HttpsError('failed-precondition', 'Actions can be added only to an active Lead.');
    }
    const connectedPeople = [
      selectedLead.data.subjectPersonRef,
      selectedLead.data.primaryContactRef,
      ...(selectedLead.data.connectedPersonRefs || []),
    ].map((ref) => ref?.path).filter(Boolean);
    if (selectedPerson && !connectedPeople.includes(selectedPerson.ref.path)) {
      throw new HttpsError('failed-precondition', 'The Action Person must be connected to the selected Lead.');
    }
    if (selectedOrganization && selectedLead.data.subjectOrganizationRef?.path !== selectedOrganization.ref.path) {
      throw new HttpsError('failed-precondition', 'The Action Organization must match the selected Lead.');
    }
  }

  if (!assignedTo) {
    throw new HttpsError(
      'invalid-argument',
      'An assigned representative is required.'
    );
  }
  if (
    assignedTo.data.active === false ||
    assignedTo.data.userType !== 'rep'
  ) {
    throw new HttpsError(
      'failed-precondition',
      'The selected assigned user must be an active representative.'
    );
  }
  if (!canAssignCommandAction({
    actorUid: uid,
    actorData: userData,
    assigneeUid: assignedTo.ref.id,
    assigneeData: assignedTo.data,
  })) {
    throw new HttpsError(
      'permission-denied',
      'You can assign an Action only to yourself or an active representative on your team.'
    );
  }
  if (relatedType === 'Person' && !selectedPerson) {
    throw new HttpsError(
      'invalid-argument',
      'Select a Person for a Person action.'
    );
  }
  if (relatedType === 'Organization' && !selectedOrganization) {
    throw new HttpsError(
      'invalid-argument',
      'Select an Organization for an Organization action.'
    );
  }

  const access = await buildCommandAccessMetadata(db, {
    actorRef: userRef,
    ownerRef: userRef,
    assignedToRef: assignedTo.ref,
  });
  const now = admin.firestore.FieldValue.serverTimestamp();
  const actionRef = db.collection(ACTIONS_COLLECTION).doc();
  const documentData = {
    title,
    description,
    actionType,
    status: 'open',
    priority,
    dueAt,
    dueDateKey: dueDateKey(dueAt),
    relatedType,
    ownerRef: access.ownerRef,
    ownerUid: access.ownerUid,
    ownerName: access.ownerName,
    assignedToRef: access.assignedToRef,
    assignedToUid: access.assignedToUid,
    assignedToName: access.assignedToName,
    teamRepIds: access.teamRepIds,
    viewerUids: access.viewerUids,
    createdAt: now,
    updatedAt: now,
    createdByRef: userRef,
    createdByUid: uid,
    createdByName: actorName(userData),
    updatedByRef: userRef,
    ...(selectedLead ? { leadRef: selectedLead.ref } : {}),
  };

  if (relatedType === 'Person') {
    documentData.personRef = selectedPerson.ref;
    documentData.personName = personName(selectedPerson.data);
  } else if (relatedType === 'Organization') {
    documentData.organizationRef = selectedOrganization.ref;
    documentData.organizationName = organizationName(
      selectedOrganization.data
    );
  }

  const batch = db.batch();
  batch.create(actionRef, documentData);
  if (selectedLead) {
    batch.update(selectedLead.ref, {
      nextActionRef: actionRef,
      nextActionTitle: title,
      nextActionType: actionType,
      nextActionAt: dueAt,
      updatedAt: now,
      updatedByRef: userRef,
    });
  }
  await batch.commit();

  return {
    ok: true,
    created: true,
    actionId: actionRef.id,
    actionPath: actionRef.path,
  };
}

exports.createCommandActionService = createCommandActionService;
exports.createCommandAction = onCall(
  {
    region: 'us-central1',
    cors: true,
  },
  createCommandActionService
);
