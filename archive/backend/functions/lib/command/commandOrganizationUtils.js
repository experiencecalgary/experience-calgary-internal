'use strict';

const { HttpsError } = require('firebase-functions/v2/https');

const ORGANIZATIONS_COLLECTION = 'commandOrganizations';
const PEOPLE_COLLECTION = 'commandPeople';
const USERS_COLLECTION = 'users';

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
  organization: 200,
  website: 500,
  email: 254,
  phone: 40,
  industry: 150,
  address: 300,
  city: 120,
  province: 120,
  postalCode: 30,
};

function asTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeWhitespace(value) {
  return asTrimmedString(value).replace(/\s+/g, ' ');
}

function normalizeOrganization(value) {
  return normalizeWhitespace(value).toLowerCase();
}

function normalizeStage(value) {
  const normalized = asTrimmedString(value).toLowerCase();
  return STAGE_ALIASES.get(normalized) || asTrimmedString(value);
}

function normalizeEmail(value) {
  return asTrimmedString(value).toLowerCase();
}

function normalizePhone(value) {
  return asTrimmedString(value).replace(/\D/g, '');
}

function isValidEmail(email) {
  if (!email) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidWebsite(website) {
  if (!website) return true;

  try {
    const candidate = /^https?:\/\//i.test(website)
      ? website
      : `https://${website}`;
    const parsed = new URL(candidate);
    return Boolean(parsed.hostname && parsed.hostname.includes('.'));
  } catch (_) {
    return false;
  }
}

function validateLength(field, value, errors) {
  const max = MAX_LENGTHS[field];
  if (max && value.length > max) {
    errors[field] = `Must be ${max} characters or fewer.`;
  }
}

function normalizeEstimatedValue(value) {
  if (value === null || value === undefined || value === '') return 0;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : NaN;
}

function optionalPath(raw, field) {
  const value = raw[field];
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : null;
}

function sanitizeOrganizationInput(raw = {}) {
  const organization = normalizeWhitespace(raw.organization);

  return {
    organization,
    organizationNormalized: normalizeOrganization(organization),
    website: asTrimmedString(raw.website),
    email: asTrimmedString(raw.email),
    emailNormalized: normalizeEmail(raw.email),
    phone: asTrimmedString(raw.phone),
    phoneNormalized: normalizePhone(raw.phone),
    industry: normalizeWhitespace(raw.industry),
    stage: normalizeStage(raw.stage || 'New'),
    estimatedValue: normalizeEstimatedValue(raw.estimatedValue),
    address: normalizeWhitespace(raw.address),
    city: normalizeWhitespace(raw.city),
    province: normalizeWhitespace(raw.province),
    postalCode: normalizeWhitespace(raw.postalCode),
    ownerRefPath: optionalPath(raw, 'ownerRefPath'),
    assignedToRefPath: optionalPath(raw, 'assignedToRefPath'),
    primaryContactRefPath: optionalPath(raw, 'primaryContactRefPath'),
  };
}

function validateOrganizationFields(organization) {
  const errors = {};

  if (!organization.organization) {
    errors.organization = 'Organization name is required.';
  }

  if (organization.email && !isValidEmail(organization.email)) {
    errors.email = 'Enter a valid email address.';
  }

  if (organization.phone && organization.phoneNormalized.length < 7) {
    errors.phone = 'Enter a valid phone number.';
  }

  if (organization.website && !isValidWebsite(organization.website)) {
    errors.website = 'Enter a valid website address.';
  }

  if (!Number.isFinite(organization.estimatedValue) || organization.estimatedValue < 0) {
    errors.estimatedValue = 'Estimated value must be a positive number or zero.';
  }

  if (!ALLOWED_STAGES.has(organization.stage)) {
    errors.stage =
      `Stage must be one of: ${Array.from(ALLOWED_STAGES).join(', ')}.`;
  }

  for (const field of Object.keys(MAX_LENGTHS)) {
    validateLength(field, organization[field] || '', errors);
  }

  return errors;
}

function requireAuth(request) {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError('unauthenticated', 'You must be signed in.');
  }
  return request.auth.uid;
}

async function requireCommandAccess(db, uid) {
  const userRef = db.collection(USERS_COLLECTION).doc(uid);
  const snap = await userRef.get();

  if (!snap.exists) {
    throw new HttpsError(
      'permission-denied',
      'A matching user profile was not found.'
    );
  }

  const userData = snap.data() || {};
  if (userData.userType !== 'rep') {
    throw new HttpsError(
      'permission-denied',
      'Only Experience Calgary representatives can access Experience Command.'
    );
  }

  return { userRef, userData };
}

function validateCollectionPath(path, expectedCollection) {
  if (!path) return null;

  const parts = path.split('/').filter(Boolean);
  if (parts.length !== 2 || parts[0] !== expectedCollection) {
    throw new HttpsError(
      'invalid-argument',
      `Invalid reference path. Expected ${expectedCollection}/{documentId}.`
    );
  }

  return path;
}

function getUserDisplayName(data = {}) {
  const firstName = normalizeWhitespace(data.firstName);
  const lastName = normalizeWhitespace(data.lastName);
  const combined = [firstName, lastName].filter(Boolean).join(' ');

  return (
    normalizeWhitespace(data.displayName) ||
    combined ||
    normalizeWhitespace(data.name) ||
    asTrimmedString(data.email)
  );
}

function getPersonDisplayName(data = {}) {
  const firstName = normalizeWhitespace(data.firstName);
  const lastName = normalizeWhitespace(data.lastName);
  const combined = [firstName, lastName].filter(Boolean).join(' ');

  return (
    normalizeWhitespace(data.fullName) ||
    combined ||
    normalizeWhitespace(data.name) ||
    asTrimmedString(data.email)
  );
}

async function resolveUserReference(db, path, label) {
  validateCollectionPath(path, USERS_COLLECTION);
  const ref = db.doc(path);
  const snap = await ref.get();

  if (!snap.exists) {
    throw new HttpsError(
      'invalid-argument',
      `The selected ${label} does not exist.`
    );
  }

  const data = snap.data() || {};
  if (data.userType !== 'rep') {
    throw new HttpsError(
      'failed-precondition',
      `The selected ${label} is not an Experience Calgary representative.`
    );
  }

  if (data.active === false) {
    throw new HttpsError(
      'failed-precondition',
      `The selected ${label} is inactive.`
    );
  }

  return { ref, name: getUserDisplayName(data) };
}

async function resolvePrimaryContactReference(db, path) {
  if (!path) return { ref: null, name: '' };

  validateCollectionPath(path, PEOPLE_COLLECTION);
  const ref = db.doc(path);
  const snap = await ref.get();

  if (!snap.exists) {
    throw new HttpsError(
      'invalid-argument',
      'The selected primary contact does not exist.'
    );
  }

  const data = snap.data() || {};
  if (data.archived === true) {
    throw new HttpsError(
      'failed-precondition',
      'The selected primary contact is archived.'
    );
  }

  return { ref, name: getPersonDisplayName(data) };
}

async function resolveReferences(
  db,
  organization,
  fallbackOwnerRef,
  fallbackAssignedToRef = null,
  fallbackPrimaryContactRef = null
) {
  let owner;
  if (organization.ownerRefPath) {
    owner = await resolveUserReference(db, organization.ownerRefPath, 'owner');
  } else {
    const snap = await fallbackOwnerRef.get();
    owner = {
      ref: fallbackOwnerRef,
      name: getUserDisplayName(snap.data() || {}),
    };
  }

  let assignee;
  if (organization.assignedToRefPath) {
    assignee = await resolveUserReference(
      db,
      organization.assignedToRefPath,
      'assignee'
    );
  } else if (fallbackAssignedToRef) {
    const snap = await fallbackAssignedToRef.get();
    assignee = {
      ref: fallbackAssignedToRef,
      name: getUserDisplayName(snap.data() || {}),
    };
  } else {
    assignee = owner;
  }

  let primaryContact;
  if (organization.primaryContactRefPath) {
    primaryContact = await resolvePrimaryContactReference(
      db,
      organization.primaryContactRefPath
    );
  } else if (fallbackPrimaryContactRef) {
    const snap = await fallbackPrimaryContactRef.get();
    primaryContact = snap.exists
      ? {
          ref: fallbackPrimaryContactRef,
          name: getPersonDisplayName(snap.data() || {}),
        }
      : { ref: null, name: '' };
  } else {
    primaryContact = { ref: null, name: '' };
  }

  return {
    ownerRef: owner.ref,
    ownerName: owner.name,
    assignedToRef: assignee.ref,
    assignedToName: assignee.name,
    primaryContactRef: primaryContact.ref,
    primaryContactName: primaryContact.name,
  };
}

async function findDuplicateMatches(
  db,
  organization,
  excludeOrganizationId = null
) {
  const matchesById = new Map();

  async function addQueryMatches(field, value, reason) {
    if (!value) return;
    const snap = await db
      .collection(ORGANIZATIONS_COLLECTION)
      .where(field, '==', value)
      .limit(10)
      .get();

    for (const doc of snap.docs) {
      if (excludeOrganizationId && doc.id === excludeOrganizationId) continue;
      const data = doc.data() || {};
      if (data.archived === true) continue;

      const current = matchesById.get(doc.id) || {
        organizationPath: doc.ref.path,
        organization: data.organization || '',
        website: data.website || '',
        email: data.email || '',
        phone: data.phone || '',
        industry: data.industry || '',
        reasons: [],
      };
      if (!current.reasons.includes(reason)) current.reasons.push(reason);
      matchesById.set(doc.id, current);
    }
  }

  await Promise.all([
    addQueryMatches('organizationNormalized', organization.organizationNormalized, 'exact_organization'),
    addQueryMatches('organization', organization.organization, 'exact_organization'),
    addQueryMatches('emailNormalized', organization.emailNormalized, 'exact_email'),
    addQueryMatches('email', organization.email, 'exact_email'),
    addQueryMatches('phoneNormalized', organization.phoneNormalized, 'exact_phone'),
    addQueryMatches('phone', organization.phone, 'exact_phone'),
  ]);

  return Array.from(matchesById.values()).map((match) => ({
    ...match,
    exactOrganization: match.reasons.includes('exact_organization'),
    exactEmail: match.reasons.includes('exact_email'),
    exactPhone: match.reasons.includes('exact_phone'),
  }));
}

function buildPublicOrganization(organization) {
  return {
    organization: organization.organization,
    organizationNormalized: organization.organizationNormalized,
    website: organization.website,
    email: organization.email,
    emailNormalized: organization.emailNormalized,
    phone: organization.phone,
    industry: organization.industry,
    stage: organization.stage,
    estimatedValue: organization.estimatedValue,
    address: organization.address,
    city: organization.city,
    province: organization.province,
    postalCode: organization.postalCode,
    ownerRefPath: organization.ownerRefPath,
    assignedToRefPath: organization.assignedToRefPath,
    primaryContactRefPath: organization.primaryContactRefPath,
  };
}

module.exports = {
  ORGANIZATIONS_COLLECTION,
  PEOPLE_COLLECTION,
  USERS_COLLECTION,
  sanitizeOrganizationInput,
  validateOrganizationFields,
  requireAuth,
  requireCommandAccess,
  resolveReferences,
  findDuplicateMatches,
  buildPublicOrganization,
};
