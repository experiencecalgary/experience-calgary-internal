'use strict';

const admin = require('firebase-admin');
const {
  sanitizePersonInput,
  validatePersonFields,
  requireAuth,
  requireCommandAccess,
  resolveReferences,
  findDuplicateMatches,
  buildPublicPerson,
} = require('./commandPersonUtils');
const {
  normalizeAdditionalEmails,
  inspectEmailIdentityConflicts,
} = require('./commandEmailIdentity');

async function validateCommandPersonService(request) {
  const db = admin.firestore();
  const uid = requireAuth(request);
  const { userRef } = await requireCommandAccess(db, uid);

  const person = sanitizePersonInput(request.data || {});
  const errors = validatePersonFields(person);
  let additionalEmails = [];
  try {
    additionalEmails = normalizeAdditionalEmails(
      request.data?.additionalEmails || [],
      person.emailNormalized
    );
  } catch (error) {
    errors.additionalEmails =
      error?.message || 'One or more additional email addresses are invalid.';
  }

  if (Object.keys(errors).length > 0) {
    return {
      ok: false,
      valid: false,
      result: 'invalid',
      errors,
      proposed: { ...buildPublicPerson(person), additionalEmails },
      matches: [],
    };
  }

  const references = await resolveReferences(db, person, userRef);
  const matches = await findDuplicateMatches(db, person);
  const identityConflicts = await inspectEmailIdentityConflicts(db, {
    recordType: 'person',
    emails: [person.emailNormalized, ...additionalEmails],
    relatedOrganizationRef: references.organizationRef,
  });

  const result = identityConflicts.length > 0
    ? 'identity_conflict'
    : matches.length > 0
      ? 'duplicate'
      : 'ready';

  return {
    ok: true,
    valid: true,
    result,
    proposed: { ...buildPublicPerson(person), additionalEmails },
    matches,
    identityConflicts,
    canCreate: matches.length === 0 && identityConflicts.length === 0,
  };
}

module.exports = {
  validateCommandPersonService,
};
