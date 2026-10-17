'use strict';

const crypto = require('crypto');
const { HttpsError } = require('firebase-functions/v2/https');

const EMAIL_IDENTITY_COLLECTION = 'commandEmailIdentityIndex';
const PEOPLE_COLLECTION = 'commandPeople';
const ORGANIZATIONS_COLLECTION = 'commandOrganizations';
const MAX_ADDITIONAL_EMAILS = 10;

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeEmail(value) {
  return clean(value).toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function emailIdentityId(email) {
  return crypto.createHash('sha256').update(normalizeEmail(email)).digest('hex');
}

function normalizeAdditionalEmails(values, primaryEmail = '') {
  if (values === null || values === undefined) return [];
  if (!Array.isArray(values)) {
    throw new HttpsError('invalid-argument', 'additionalEmails must be a list.');
  }
  if (values.length > MAX_ADDITIONAL_EMAILS) {
    throw new HttpsError(
      'invalid-argument',
      `A record may have at most ${MAX_ADDITIONAL_EMAILS} additional email addresses.`
    );
  }

  const primary = normalizeEmail(primaryEmail);
  const unique = [];
  const seen = new Set(primary ? [primary] : []);

  for (const value of values) {
    const email = normalizeEmail(value);
    if (!email || seen.has(email)) continue;
    if (!isValidEmail(email)) {
      throw new HttpsError('invalid-argument', `Invalid additional email address: ${clean(value)}.`);
    }
    seen.add(email);
    unique.push(email);
  }
  return unique;
}

function recordEmails(data = {}) {
  const primary = normalizeEmail(data.emailNormalized || data.email);
  const additional = normalizeAdditionalEmails(
    data.additionalEmailsNormalized || data.additionalEmails || [],
    primary
  );
  return [...new Set([primary, ...additional].filter(Boolean))];
}

function sameRef(left, right) {
  return Boolean(left && right && left.path === right.path);
}

function identityRef(db, email) {
  return db.collection(EMAIL_IDENTITY_COLLECTION).doc(emailIdentityId(email));
}

async function assertClaimsAvailable(transaction, db, options) {
  const {
    recordType,
    recordRef,
    emails,
    relatedOrganizationRef = null,
  } = options;

  if (!['person', 'organization'].includes(recordType)) {
    throw new HttpsError('internal', 'Unsupported email identity record type.');
  }

  const normalized = [...new Set((emails || []).map(normalizeEmail).filter(Boolean))];
  for (const email of normalized) {
    if (!isValidEmail(email)) {
      throw new HttpsError('invalid-argument', `Invalid email address: ${email}.`);
    }
  }

  const refs = normalized.map((email) => identityRef(db, email));
  const snapshots = refs.length ? await transaction.getAll(...refs) : [];
  const claims = snapshots.map((snapshot, index) => ({
    email: normalized[index],
    ref: refs[index],
    data: snapshot.exists ? snapshot.data() || {} : {},
  }));

  if (recordType === 'person') {
    for (const claim of claims) {
      if (claim.data.personRef && !sameRef(claim.data.personRef, recordRef)) {
        throw new HttpsError(
          'already-exists',
          'That email address already belongs to another person.',
          { email: claim.email, conflictType: 'person' }
        );
      }
      if (
        claim.data.organizationRef &&
        !sameRef(claim.data.organizationRef, relatedOrganizationRef)
      ) {
        throw new HttpsError(
          'already-exists',
          'That email address belongs to an organization that is not connected to this person.',
          { email: claim.email, conflictType: 'organization' }
        );
      }
    }
  } else {
    const personRefs = [];
    for (const claim of claims) {
      if (claim.data.organizationRef && !sameRef(claim.data.organizationRef, recordRef)) {
        throw new HttpsError(
          'already-exists',
          'That email address already belongs to another organization.',
          { email: claim.email, conflictType: 'organization' }
        );
      }
      if (claim.data.personRef) personRefs.push(claim.data.personRef);
    }

    const uniquePeople = [...new Map(personRefs.map((ref) => [ref.path, ref])).values()];
    const personSnapshots = uniquePeople.length
      ? await transaction.getAll(...uniquePeople)
      : [];
    const peopleByPath = new Map(
      personSnapshots.map((snapshot) => [snapshot.ref.path, snapshot.exists ? snapshot.data() || {} : null])
    );

    for (const claim of claims) {
      if (!claim.data.personRef) continue;
      const person = peopleByPath.get(claim.data.personRef.path);
      if (!person || !sameRef(person.organizationRef, recordRef)) {
        throw new HttpsError(
          'already-exists',
          'That email address belongs to a person who is not connected to this organization.',
          { email: claim.email, conflictType: 'person' }
        );
      }
    }
  }

  return claims;
}

async function syncEmailIdentityClaims(transaction, db, options) {
  const {
    recordType,
    recordRef,
    emails,
    previousEmails = [],
    relatedOrganizationRef = null,
    actorRef = null,
    timestamp,
  } = options;

  const nextEmails = [...new Set((emails || []).map(normalizeEmail).filter(Boolean))];
  const oldEmails = [...new Set((previousEmails || []).map(normalizeEmail).filter(Boolean))];
  const claims = await assertClaimsAvailable(transaction, db, {
    recordType,
    recordRef,
    emails: nextEmails,
    relatedOrganizationRef,
  });
  const nextSet = new Set(nextEmails);
  const claimByEmail = new Map(claims.map((claim) => [claim.email, claim]));

  // Read removed claims before issuing any writes; Firestore transactions require
  // every read to happen before the first write.
  const removedEmails = oldEmails.filter((email) => !nextSet.has(email));
  const removedRefs = removedEmails.map((email) => identityRef(db, email));
  const removedSnapshots = removedRefs.length
    ? await transaction.getAll(...removedRefs)
    : [];

  for (const email of nextEmails) {
    const claim = claimByEmail.get(email);
    const update = {
      emailNormalized: email,
      updatedAt: timestamp,
      updatedByRef: actorRef,
    };
    update[recordType === 'person' ? 'personRef' : 'organizationRef'] = recordRef;
    transaction.set(claim.ref, update, { merge: true });
  }

  removedSnapshots.forEach((snapshot) => {
    if (!snapshot.exists) return;
    const data = snapshot.data() || {};
    const ownsClaim = sameRef(
      data[recordType === 'person' ? 'personRef' : 'organizationRef'],
      recordRef
    );
    if (!ownsClaim) return;

    const otherRef = data[recordType === 'person' ? 'organizationRef' : 'personRef'];
    if (otherRef) {
      transaction.update(snapshot.ref, {
        [recordType === 'person' ? 'personRef' : 'organizationRef']: null,
        updatedAt: timestamp,
        updatedByRef: actorRef,
      });
    } else {
      transaction.delete(snapshot.ref);
    }
  });
}

async function resolveEmailIdentity(db, value) {
  const email = normalizeEmail(value);
  if (!email || !isValidEmail(email)) {
    return { emailNormalized: email, personRef: null, organizationRef: null };
  }
  const snapshot = await identityRef(db, email).get();
  const data = snapshot.exists ? snapshot.data() || {} : {};
  return {
    emailNormalized: email,
    personRef: data.personRef || null,
    organizationRef: data.organizationRef || null,
  };
}

async function inspectEmailIdentityConflicts(db, options = {}) {
  const {
    recordType,
    emails = [],
    recordRef = null,
    relatedOrganizationRef = null,
  } = options;

  if (!['person', 'organization'].includes(recordType)) {
    throw new HttpsError('internal', 'Unsupported email identity record type.');
  }

  const normalized = [...new Set(emails.map(normalizeEmail).filter(Boolean))];
  for (const email of normalized) {
    if (!isValidEmail(email)) {
      throw new HttpsError('invalid-argument', `Invalid email address: ${email}.`);
    }
  }

  const refs = normalized.map((email) => identityRef(db, email));
  const snapshots = refs.length ? await db.getAll(...refs) : [];
  const claims = snapshots.map((snapshot, index) => ({
    email: normalized[index],
    data: snapshot.exists ? snapshot.data() || {} : {},
  }));
  const conflicts = [];

  if (recordType === 'person') {
    for (const claim of claims) {
      if (claim.data.personRef && !sameRef(claim.data.personRef, recordRef)) {
        conflicts.push({
          email: claim.email,
          conflictType: 'person',
          personPath: claim.data.personRef.path,
          organizationPath: claim.data.organizationRef?.path || '',
          message: 'That email address already belongs to another person.',
        });
      }
      if (
        claim.data.organizationRef &&
        !sameRef(claim.data.organizationRef, relatedOrganizationRef)
      ) {
        conflicts.push({
          email: claim.email,
          conflictType: 'organization',
          personPath: claim.data.personRef?.path || '',
          organizationPath: claim.data.organizationRef.path,
          message:
            'That email address belongs to an organization that is not connected to this person.',
        });
      }
    }
    return conflicts;
  }

  const personRefs = [
    ...new Map(
      claims
        .filter((claim) => claim.data.personRef)
        .map((claim) => [claim.data.personRef.path, claim.data.personRef])
    ).values(),
  ];
  const personSnapshots = personRefs.length ? await db.getAll(...personRefs) : [];
  const peopleByPath = new Map(
    personSnapshots.map((snapshot) => [
      snapshot.ref.path,
      snapshot.exists ? snapshot.data() || {} : null,
    ])
  );

  for (const claim of claims) {
    if (claim.data.organizationRef && !sameRef(claim.data.organizationRef, recordRef)) {
      conflicts.push({
        email: claim.email,
        conflictType: 'organization',
        personPath: claim.data.personRef?.path || '',
        organizationPath: claim.data.organizationRef.path,
        message: 'That email address already belongs to another organization.',
      });
    }

    if (claim.data.personRef) {
      const person = peopleByPath.get(claim.data.personRef.path);
      if (!recordRef || !person || !sameRef(person.organizationRef, recordRef)) {
        conflicts.push({
          email: claim.email,
          conflictType: 'person',
          personPath: claim.data.personRef.path,
          organizationPath: claim.data.organizationRef?.path || '',
          message:
            'That email address belongs to a person who is not connected to this organization.',
        });
      }
    }
  }

  return conflicts;
}

module.exports = {
  EMAIL_IDENTITY_COLLECTION,
  MAX_ADDITIONAL_EMAILS,
  normalizeEmail,
  normalizeAdditionalEmails,
  recordEmails,
  sameRef,
  identityRef,
  assertClaimsAvailable,
  syncEmailIdentityClaims,
  resolveEmailIdentity,
  inspectEmailIdentityConflicts,
};
