'use strict';

const admin = require('firebase-admin');
const {
  sanitizeOrganizationInput,
  validateOrganizationFields,
  requireAuth,
  requireCommandAccess,
  resolveReferences,
  findDuplicateMatches,
  buildPublicOrganization,
} = require('./commandOrganizationUtils');
const {
  normalizeAdditionalEmails,
  inspectEmailIdentityConflicts,
} = require('./commandEmailIdentity');

async function validateCommandOrganizationService(request) {
  const db = admin.firestore();
  const uid = requireAuth(request);
  const { userRef } = await requireCommandAccess(db, uid);

  const organization = sanitizeOrganizationInput(request.data || {});
  const errors = validateOrganizationFields(organization);
  let additionalEmails = [];
  try {
    additionalEmails = normalizeAdditionalEmails(
      request.data?.additionalEmails || [],
      organization.emailNormalized
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
      proposed: { ...buildPublicOrganization(organization), additionalEmails },
      matches: [],
    };
  }

  await resolveReferences(db, organization, userRef, null, null);
  const matches = await findDuplicateMatches(db, organization);
  const identityConflicts = await inspectEmailIdentityConflicts(db, {
    recordType: 'organization',
    emails: [organization.emailNormalized, ...additionalEmails],
  });

  return {
    ok: true,
    valid: true,
    result: identityConflicts.length > 0
      ? 'identity_conflict'
      : matches.length > 0
        ? 'duplicate'
        : 'ready',
    proposed: { ...buildPublicOrganization(organization), additionalEmails },
    matches,
    identityConflicts,
    canCreate: matches.length === 0 && identityConflicts.length === 0,
  };
}

module.exports = {
  validateCommandOrganizationService,
};
