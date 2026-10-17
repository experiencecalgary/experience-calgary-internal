'use strict';

const admin = require('firebase-admin');
const { HttpsError } = require('firebase-functions/v2/https');
const { isPlatformAdminUser } = require('./commandPersonUtils');
const clean = value => typeof value === 'string' ? value.trim() : '';
const refPath = value => clean(value?.path || value);
const ms = value => value?.toMillis ? value.toMillis() : null;
const iso = value => ms(value) === null ? null : new Date(ms(value)).toISOString();
function visible(uid, actor, data = {}) {
  if ((data.status === 'stale' || data.archived === true && data.statusBeforeArchive === 'stale') && !isPlatformAdminUser(actor)) return false;
  return isPlatformAdminUser(actor) || data.ownerUid === uid || data.assignedToUid === uid ||
    (data.viewerUids || []).includes(uid) || (actor.repId != null && (data.teamRepIds || []).map(String).includes(String(actor.repId)));
}
function documentPath(value, collection) {
  const path = refPath(value);
  if (!new RegExp(`^${collection}/[^/]+$`).test(path)) throw new HttpsError('invalid-argument', `Expected ${collection}/{id}.`);
  return path;
}
function connectedPaths(lead) {
  return [...new Set([lead.primaryContactRef, lead.subjectPersonRef, ...(lead.connectedPersonRefs || []), lead.subjectOrganizationRef].map(refPath).filter(Boolean))];
}
function restricted(data = {}) { return data.doNotCall === true || clean(data.phoneStatus).toLowerCase() === 'do_not_call'; }
function callablePhone(data = {}) { return !restricted(data) && clean(data.phoneStatus).toLowerCase() !== 'wrong_number' && clean(data.phone).replace(/\D/g, '').length >= 10; }
function contactName(data = {}) { return clean(data.fullName) || [clean(data.firstName), clean(data.lastName)].filter(Boolean).join(' ') || clean(data.organization || data.name || data.displayName || data.email); }
async function readLead(ctx, raw, active = true) {
  const ref = ctx.db.doc(documentPath(raw, 'commandLeads')); const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Lead not found.');
  const data = snap.data();
  if (!visible(ctx.uid, ctx.actor.userData, data)) throw new HttpsError('permission-denied', 'You do not have access to this Lead.');
  if (data.archived === true || (active && data.status !== 'active')) throw new HttpsError('failed-precondition', 'This Lead is no longer active.');
  return { ref, data };
}
async function readContacts(ctx, lead) {
  const paths = connectedPaths(lead);
  if (paths.length > 100) throw new HttpsError('resource-exhausted', 'This Lead has too many connected contacts.');
  for (const path of paths) if (!/^command(People|Organizations)\/[^/]+$/.test(path)) throw new HttpsError('failed-precondition', 'Invalid contact relationship.');
  const docs = paths.length ? await ctx.db.getAll(...paths.map(p => ctx.db.doc(p))) : [];
  const allowed = docs.filter(doc => doc.exists && doc.data().archived !== true && visible(ctx.uid, ctx.actor.userData, doc.data()));
  allowed.restrictionRefs = paths.map(p => ctx.db.doc(p));
  allowed.blockBusinessFallback = docs.some(doc => doc.exists && doc.data().archived !== true && doc.ref.path.startsWith('commandPeople/') && restricted(doc.data()));
  return allowed;
}
function futureTime(raw) {
  const time = typeof raw === 'string' ? Date.parse(raw) : NaN;
  if (!Number.isFinite(time) || time <= Date.now()) throw new HttpsError('invalid-argument', 'Choose a future next-step time.');
  return admin.firestore.Timestamp.fromMillis(time);
}
function contactFields(doc, lead) {
  const data = doc.data(); const organization = doc.ref.path.startsWith('commandOrganizations/');
  return { refPath: doc.ref.path, recordType: organization ? 'organization' : 'person', name: contactName(data),
    position: clean(data.position || data.jobTitle), phone: clean(data.phone), email: clean(data.email),
    phoneStatus: clean(data.phoneStatus), doNotCall: restricted(data) || restricted(lead),
    canCall: !restricted(lead) && callablePhone(data), canEmail: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(data.email)),
    isPrimary: doc.ref.path === refPath(lead.primaryContactRef) };
}
module.exports = { clean, refPath, ms, iso, visible, documentPath, connectedPaths, restricted, callablePhone, contactName, readLead, readContacts, futureTime, contactFields };

