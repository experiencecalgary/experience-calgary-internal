'use strict';
const { HttpsError } = require('firebase-functions/v2/https');
const { clean, refPath, documentPath, visible, connectedPaths } = require('../command/commandOutreachSupport');
async function resolveEmailLead(db, actor, raw, relationship) {
  if (!clean(raw.leadRefPath)) return null;
  const ref = db.doc(documentPath(raw.leadRefPath, 'commandLeads'));
  const snap = await ref.get();
  if (!snap.exists || snap.data().archived === true || !visible(actor.uid, actor.userData, snap.data())) throw new HttpsError('permission-denied', 'The selected email Lead is unavailable.');
  const data = snap.data(), person = refPath(relationship.personRef), organization = refPath(relationship.organizationRef);
  if ((!person && !organization) || (person && !connectedPaths(data).includes(person))) throw new HttpsError('failed-precondition', 'Email contacts must belong to the selected Lead.');
  if (organization && organization !== refPath(data.subjectOrganizationRef)) {
    // A Person Lead may not yet have its own Organization. Email relationship
    // resolution can still supply that Person's existing employer automatically.
    const contact = person && !data.subjectOrganizationRef ? await db.doc(person).get() : null;
    const employer = contact?.exists && refPath(contact.data().organizationRef) === organization ? await db.doc(organization).get() : null;
    if (!contact?.exists || contact.data().archived === true || !visible(actor.uid, actor.userData, contact.data()) ||
        !employer?.exists || employer.data().archived === true || !visible(actor.uid, actor.userData, employer.data())) {
      throw new HttpsError('failed-precondition', 'Email contacts must belong to the selected Lead.');
    }
  }
  return ref;
}
module.exports = { resolveEmailLead };
