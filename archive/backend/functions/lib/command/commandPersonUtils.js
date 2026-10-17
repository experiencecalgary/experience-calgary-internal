'use strict';

const { HttpsError } = require('firebase-functions/v2/https');

const PEOPLE_COLLECTION = 'commandPeople';
const USERS_COLLECTION = 'users';
const ORGANIZATIONS_COLLECTION = 'commandOrganizations';

const ALLOWED_STAGES = new Set([
  'New',
  'Opened',
  'Engaged',
  'Closing',
  'Won',
  'Lost',
]);

const STAGE_ALIASES = new Map([
  ['new', 'New'],
  ['opened', 'Opened'],
  ['engaged', 'Engaged'],
  ['closing', 'Closing'],
  ['won', 'Won'],
  ['lost', 'Lost'],
]);

const MAX_LENGTHS = {
  firstName: 100,
  lastName: 100,
  email: 254,
  phone: 40,
  organizationName: 200,
};

function asTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeEmail(value) {
  return asTrimmedString(value).toLowerCase();
}

function normalizePhone(value) {
  return asTrimmedString(value).replace(/\D/g, '');
}

function normalizeStage(value) {
  const normalized = asTrimmedString(value).toLowerCase();
  return STAGE_ALIASES.get(normalized) || asTrimmedString(value);
}

function normalizeName(value) {
  return asTrimmedString(value).replace(/\s+/g, ' ');
}

function normalizeOrganizationName(value) {
  return asTrimmedString(value).replace(/\s+/g, ' ');
}

function isValidEmail(email) {
  if (!email) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validateLength(field, value, errors) {
  const max = MAX_LENGTHS[field];

  if (max && value.length > max) {
    errors[field] = `Must be ${max} characters or fewer.`;
  }
}

function sanitizePersonInput(raw = {}) {
  const firstName = normalizeName(raw.firstName);
  const lastName = normalizeName(raw.lastName);
  const person = {
    firstName,
    lastName,
    fullNameNormalized: [firstName, lastName].filter(Boolean).join(' ').toLowerCase(),
    email: asTrimmedString(raw.email),
    emailNormalized: normalizeEmail(raw.email),
    phone: normalizePhone(raw.phone),
    phoneNormalized: normalizePhone(raw.phone),
    phoneProvided: asTrimmedString(raw.phone).length > 0,
    organizationName: normalizeOrganizationName(raw.organizationName),
    stage: normalizeStage(raw.stage || 'New'),
  };

  if (
    typeof raw.organizationRefPath === 'string' &&
    raw.organizationRefPath.trim()
  ) {
    person.organizationRefPath = raw.organizationRefPath.trim();
  }

  if (
    typeof raw.ownerRefPath === 'string' &&
    raw.ownerRefPath.trim()
  ) {
    person.ownerRefPath = raw.ownerRefPath.trim();
  }

  return person;
}

function validatePersonFields(person) {
  const errors = {};

  if (!person.firstName) {
    errors.firstName = 'First name is required.';
  }

  if (!person.emailNormalized && !person.phoneNormalized) {
    errors.contact = 'Enter at least an email address or phone number.';
  }

  if (
    person.emailNormalized &&
    !isValidEmail(person.emailNormalized)
  ) {
    errors.email = 'Enter a valid email address.';
  }

  if (
    person.phoneProvided &&
    person.phoneNormalized.length !== 10
  ) {
    errors.phone = 'Phone numbers must contain exactly 10 digits.';
  }

  if (!ALLOWED_STAGES.has(person.stage)) {
    errors.stage =
      `Stage must be one of: ${Array.from(ALLOWED_STAGES).join(', ')}.`;
  }

  validateLength('firstName', person.firstName, errors);
  validateLength('lastName', person.lastName, errors);
  validateLength('email', person.email, errors);
  validateLength('phone', person.phone, errors);
  validateLength(
    'organizationName',
    person.organizationName,
    errors
  );

  return errors;
}

function isPlatformAdminUser(userData = {}) {
  return asTrimmedString(userData.role).toLowerCase() === 'platform_admin';
}

function requireAuth(request) {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError(
      'unauthenticated',
      'You must be signed in.'
    );
  }

  return request.auth.uid;
}

async function requireCommandAccess(db, uid) {
  const userRef = db
    .collection(USERS_COLLECTION)
    .doc(uid);

  const snap = await userRef.get();

  if (!snap.exists) {
    throw new HttpsError(
      'permission-denied',
      'A matching user profile was not found.'
    );
  }

  const user = snap.data() || {};

  if (user.userType !== 'rep') {
    throw new HttpsError(
      'permission-denied',
      'Only Experience Calgary representatives can access Experience Command.'
    );
  }

  return {
    userRef,
    userData: user,
  };
}

function validateCollectionPath(path, expectedCollection) {
  if (!path) return null;

  const parts = path
    .split('/')
    .filter(Boolean);

  if (
    parts.length !== 2 ||
    parts[0] !== expectedCollection
  ) {
    throw new HttpsError(
      'invalid-argument',
      `Invalid reference path. Expected ${expectedCollection}/{documentId}.`
    );
  }

  return path;
}

async function resolveReferences(
  db,
  person,
  fallbackOwnerRef
) {
  let ownerRef = fallbackOwnerRef;
  let organizationRef = null;

  if (person.ownerRefPath) {
    validateCollectionPath(
      person.ownerRefPath,
      USERS_COLLECTION
    );

    ownerRef = db.doc(person.ownerRefPath);

    const ownerSnap = await ownerRef.get();

    if (!ownerSnap.exists) {
      throw new HttpsError(
        'invalid-argument',
        'The selected owner does not exist.'
      );
    }

    const owner = ownerSnap.data() || {};

    if (owner.active === false) {
      throw new HttpsError(
        'failed-precondition',
        'The selected owner is inactive.'
      );
    }
  }

  if (person.organizationRefPath) {
    validateCollectionPath(
      person.organizationRefPath,
      ORGANIZATIONS_COLLECTION
    );

    organizationRef = db.doc(
      person.organizationRefPath
    );

    const organizationSnap =
      await organizationRef.get();

    if (!organizationSnap.exists) {
      throw new HttpsError(
        'invalid-argument',
        'The selected organization does not exist.'
      );
    }
  }

  return {
    ownerRef,
    organizationRef,
  };
}

async function findDuplicateMatches(
  db,
  person,
  excludePersonId = null
) {
  const matchesById = new Map();

  async function addQueryMatches(field, value, reason) {
    if (!value) return;
    const snap = await db
      .collection(PEOPLE_COLLECTION)
      .where(field, '==', value)
      .limit(10)
      .get();

    for (const doc of snap.docs) {
      if (excludePersonId && doc.id === excludePersonId) continue;
      const data = doc.data() || {};
      if (data.archived === true) continue;

      const current = matchesById.get(doc.id) || {
        personPath: doc.ref.path,
        firstName: data.firstName || '',
        lastName: data.lastName || '',
        email: data.email || '',
        phone: data.phone || '',
        organizationName: data.organizationName || '',
        reasons: [],
      };
      if (!current.reasons.includes(reason)) current.reasons.push(reason);
      matchesById.set(doc.id, current);
    }
  }

  await Promise.all([
    addQueryMatches('emailNormalized', person.emailNormalized, 'exact_email'),
    addQueryMatches('email', person.email, 'exact_email'),
    addQueryMatches('phoneNormalized', person.phoneNormalized, 'exact_phone'),
    addQueryMatches('phone', person.phone, 'exact_phone'),
  ]);

  return Array.from(matchesById.values()).map((match) => ({
    ...match,
    exactName: false,
    exactEmail: match.reasons.includes('exact_email'),
    exactPhone: match.reasons.includes('exact_phone'),
  }));
}

function hasExactEmailDuplicate(matches) {
  return matches.some(
    (match) => match.exactEmail === true
  );
}

function buildPublicPerson(person) {
  return {
    firstName: person.firstName,
    lastName: person.lastName,
    fullNameNormalized: person.fullNameNormalized,
    email: person.email,
    emailNormalized: person.emailNormalized,
    phone: person.phone,
    phoneNormalized: person.phoneNormalized,
    organizationName: person.organizationName,
    stage: person.stage,
    organizationRefPath:
      person.organizationRefPath || null,
    ownerRefPath:
      person.ownerRefPath || null,
  };
}

module.exports = {
  PEOPLE_COLLECTION,
  USERS_COLLECTION,
  ORGANIZATIONS_COLLECTION,
  ALLOWED_STAGES,
  sanitizePersonInput,
  validatePersonFields,
  requireAuth,
  requireCommandAccess,
  isPlatformAdminUser,
  resolveReferences,
  findDuplicateMatches,
  hasExactEmailDuplicate,
  buildPublicPerson,
};
