'use strict';

const admin = require('firebase-admin');
const { HttpsError } = require('firebase-functions/v2/https');
const { requireAuth, requireCommandAccess, isPlatformAdminUser } = require('./commandPersonUtils');
const { buildCommandAccessMetadata } = require('./commandAccessMetadata');
const { canAssignTo } = require('./commandRecordAssignment');
const { scanPage, digest } = require('./commandLeadWorkspace');
const { connectedPaths, clean, iso, visible } = require('./commandOutreachSupport');

const DAYS = 30;
const AGE = DAYS * 86400000;
const CONFIG = 'commandMaintenance/staleLeads';
const ms = value => value?.toMillis?.() ?? null;
const timestamp = () => admin.firestore.FieldValue.serverTimestamp();
const inPool = data => data.status === 'stale' || (data.archived === true && data.statusBeforeArchive === 'stale');
function dormant(data, now = Date.now()) {
  if (data.archived === true || data.status !== 'active' || !['New', 'Opened', 'Engaged', 'Closing'].includes(data.stage)) return false;
  if (!clean(data.assignedToUid) || ms(data.updatedAt) === null || ms(data.createdAt) === null) return false;
  const latest = Math.max(ms(data.createdAt), ms(data.updatedAt), ms(data.lastActivityAt) || 0);
  return latest < now - AGE;
}
function assertAdmin(ctx) {
  if (!isPlatformAdminUser(ctx.actor.userData)) throw new HttpsError('permission-denied', 'Stale Lead Management is available to platform administrators only.');
}
async function context(request) {
  const db = admin.firestore(), uid = requireAuth(request), actor = await requireCommandAccess(db, uid);
  const ctx = { db, uid, actor, input: request.data || {} }; assertAdmin(ctx); return ctx;
}
function row(doc) {
  const d = doc.data();
  return { leadRefPath: doc.ref.path, displayName: clean(d.displayName), leadType: clean(d.leadType), stage: clean(d.stage), status: clean(d.status),
    ownerName: clean(d.ownerName), assignedToName: clean(d.assignedToName), leadListName: clean(d.leadListName),
    primaryContactName: clean(d.primaryContactName), lastActivityAt: iso(d.lastActivityAt), updatedAt: iso(d.updatedAt), createdAt: iso(d.createdAt) };
}
function audit(db, leadRef, before, type, summary, actor, details = {}) {
  return { type, summary, leadRef, leadName: clean(before.displayName), sourceRef: leadRef, recordType: 'lead',
    personRef: before.subjectPersonRef || before.primaryContactRef || null, organizationRef: before.subjectOrganizationRef || null,
    ownerRef: before.ownerRef || null, ownerUid: clean(before.ownerUid), ownerName: clean(before.ownerName),
    assignedToRef: before.assignedToRef || null, assignedToUid: clean(before.assignedToUid), assignedToName: clean(before.assignedToName),
    viewerUids: before.viewerUids || [], teamRepIds: before.teamRepIds || [],
    createdAt: timestamp(), createdByRef: actor?.userRef || null, createdByUid: actor?.userRef?.id || '',
    createdByName: actor ? clean(actor.userData.fullName || actor.userData.displayName) : 'Automatic stale lead cleanup',
    details: { previousAssignedToUid: clean(before.assignedToUid), previousAssignedToName: clean(before.assignedToName), previousOwnerUid: clean(before.ownerUid),
      lastActivityAt: iso(before.lastActivityAt), previousUpdatedAt: iso(before.updatedAt), ...details } };
}
// Check live records, not a potentially delayed next-action summary. Legacy work
// linked only to a contact also protects the lead, conservatively.
async function protection(db, tx, ref, data, now) {
  if (data.connectedPersonRefs != null && !Array.isArray(data.connectedPersonRefs)) return 'Invalid contact relationship; review required';
  const contacts = connectedPaths(data);
  if (contacts.some(p => !/^command(People|Organizations)\/[^/]+$/.test(p))) return 'Invalid contact relationship; review required';
  const relations = [['leadRef', ref], ...contacts
    .map(p => [p.startsWith('commandPeople/') ? 'personRef' : 'organizationRef', db.doc(p)])];
  if (relations.length > 101) return 'Too many related contacts to verify safely';
  for (const [field, value] of relations) {
    for (const [collection, status, reason] of [['commandActions', 'open', 'Open action or meeting'], ['commandCalls', 'in_progress', 'Active call'], ['commandAgreements', 'pending', 'Pending agreement']]) {
      const snap = await tx.get(db.collection(collection).where(field, '==', value).where('status', '==', status).limit(1));
      if (snap.size) return reason;
    }
  }
  const recent = await tx.get(db.collection('commandConnections').where('leadRef', '==', ref)
    .where('createdAt', '>=', admin.firestore.Timestamp.fromMillis(now - AGE)).limit(1));
  return recent.size ? 'Recent activity in history' : '';
}
async function inspect(db, ref, now, commit) {
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists || !dormant(snap.data(), now)) return { ...(snap.exists ? row(snap) : {}), eligible: false, reason: 'No longer eligible' };
    const data = snap.data(), reason = await protection(db, tx, ref, data, now);
    if (reason) return { ...row(snap), eligible: false, reason };
    if (commit) {
      tx.update(ref, { status: 'stale', assignedToRef: null, assignedToUid: '', assignedToName: '', updatedAt: timestamp() });
      tx.create(db.collection('commandConnections').doc(), audit(db, ref, data, 'lead_marked_stale', 'Lead returned to admin after 30 days without activity or updates', null, { reason: '30 days without activity or updates; no open work' }));
    }
    return { ...row(snap), eligible: true, reason: '30 days without activity or updates; no open work' };
  });
}
function pageSize(value, fallback = 50) { return Number.isInteger(value) ? Math.max(1, Math.min(100, value)) : fallback; }
function decode(raw) {
  if (!raw) return null;
  try {
    if (typeof raw !== 'string' || raw.length > 1024) throw Error();
    const p = JSON.parse(Buffer.from(raw, 'base64url').toString());
    if (!Number.isSafeInteger(p.seconds) || !Number.isInteger(p.nanoseconds) || p.nanoseconds < 0 || p.nanoseconds >= 1e9 || !/^[^/]{1,200}$/.test(p.id)) throw Error();
    return p;
  } catch (_) { throw new HttpsError('invalid-argument', 'Invalid page token. Refresh the preview.'); }
}
async function sweepPage(db, { now = Date.now(), token = '', limit = 50, commit = false } = {}) {
  const cursor = decode(token);
  let q = db.collection('commandLeads').where('status', '==', 'active')
    .where('updatedAt', '<', admin.firestore.Timestamp.fromMillis(now - AGE)).orderBy('updatedAt').orderBy(admin.firestore.FieldPath.documentId());
  if (cursor) q = q.startAfter(new admin.firestore.Timestamp(cursor.seconds, cursor.nanoseconds), cursor.id);
  const snap = await q.limit(limit).get(), records = [];
  for (const doc of snap.docs) records.push(await inspect(db, doc.ref, now, commit));
  const last = snap.docs.at(-1), at = last?.data().updatedAt;
  return { ok: true, records, scanned: snap.size, eligible: records.filter(r => r.eligible).length,
    nextPageToken: snap.size === limit && last ? Buffer.from(JSON.stringify({ seconds: at.seconds, nanoseconds: at.nanoseconds, id: last.id })).toString('base64url') : '' };
}
async function preview(ctx) { assertAdmin(ctx); return sweepPage(ctx.db, { token: ctx.input.pageToken, limit: pageSize(ctx.input.pageSize) }); }
async function list(ctx) {
  assertAdmin(ctx);
  const search = clean(ctx.input.search).toLowerCase();
  if (search.length > 200) throw new HttpsError('invalid-argument', 'Search is too long.');
  const page = await scanPage({ queries: [ctx.db.collection('commandLeads').where('status', '==', 'stale')], field: 'updatedAt',
    fingerprint: digest([ctx.uid, 'stale', search]), token: ctx.input.pageToken, pageSize: pageSize(ctx.input.pageSize),
    matches: d => !search || [d.displayName, d.primaryContactName, d.leadListName].some(v => clean(v).toLowerCase().includes(search)), serialize: row });
  for (let i = 0; i < page.records.length; i += 5) {
    await Promise.all(page.records.slice(i, i + 5).map(async item => {
      const history = await ctx.db.collection('commandConnections').where('leadRef', '==', ctx.db.doc(item.leadRefPath))
        .where('type', '==', 'lead_marked_stale').orderBy('createdAt', 'desc').limit(1).get();
      const event = history.docs[0]?.data();
      item.previousRepName = clean(event?.details?.previousAssignedToName);
      item.previousRepUid = clean(event?.details?.previousAssignedToUid);
      item.reason = clean(event?.details?.reason);
      item.staleAt = iso(event?.createdAt);
      item.lastUpdatedBeforeStale = event?.details?.previousUpdatedAt || null;
    }));
  }
  return page;
}
function paths(input) {
  const values = input.leadRefPaths;
  if (!Array.isArray(values) || !values.length || values.length > 50 || values.some(p => typeof p !== 'string' || !/^commandLeads\/[^/]+$/.test(p)))
    throw new HttpsError('invalid-argument', 'Select between 1 and 50 Leads.');
  return [...new Set(values)];
}
async function manage(ctx) {
  assertAdmin(ctx);
  const selected = paths(ctx.input), operation = clean(ctx.input.operation);
  if (!['assign', 'archive'].includes(operation)) throw new HttpsError('invalid-argument', 'Choose assign or archive.');
  let target = null, access = null;
  if (operation === 'assign') {
    if (!/^users\/[^/]+$/.test(clean(ctx.input.assignedToRefPath))) throw new HttpsError('invalid-argument', 'Select an active representative.');
    target = ctx.db.doc(ctx.input.assignedToRefPath);
    const user = await target.get();
    if (!user.exists || !canAssignTo({ uid: ctx.uid, userData: ctx.actor.userData }, target.id, user.data())) throw new HttpsError('failed-precondition', 'Select an active representative.');
    access = await buildCommandAccessMetadata(ctx.db, { actorRef: ctx.actor.userRef, ownerRef: target, assignedToRef: target });
  }
  const results = [];
  for (const path of selected) {
    try {
      const result = await ctx.db.runTransaction(async tx => {
        const ref = ctx.db.doc(path), snap = await tx.get(ref);
        if (!snap.exists || snap.data().status !== 'stale') return { leadRefPath: path, changed: false, reason: 'Lead is no longer stale' };
        const data = snap.data();
        if (target) {
          const user = await tx.get(target);
          if (!user.exists || !canAssignTo({ uid: ctx.uid, userData: ctx.actor.userData }, target.id, user.data())) throw new HttpsError('failed-precondition', 'Representative is no longer active.');
          // Do not silently hand over an unusable Lead, or transfer shared contacts.
          const contacts = connectedPaths(data);
          if (contacts.length > 100 || contacts.some(p => !/^command(People|Organizations)\/[^/]+$/.test(p))) throw new HttpsError('failed-precondition', 'Review this Lead’s contact relationships before reassignment.');
          for (const contactPath of contacts) {
            const contact = await tx.get(ctx.db.doc(contactPath));
            if (!contact.exists || contact.data().archived === true || !visible(target.id, user.data(), contact.data()))
              throw new HttpsError('failed-precondition', 'The selected rep cannot access a linked contact. Assign that Person or Organization to the rep first, then retry.');
          }
        }
        const update = operation === 'archive' ? { status: 'archived', archived: true, statusBeforeArchive: 'stale', archivedAt: timestamp(), archivedByRef: ctx.actor.userRef }
          : { ...access, status: 'active', archived: false };
        tx.update(ref, { ...update, updatedAt: timestamp(), updatedByRef: ctx.actor.userRef });
        tx.create(ctx.db.collection('commandConnections').doc(), audit(ctx.db, ref, data, operation === 'archive' ? 'lead_archived' : 'lead_assigned',
          operation === 'archive' ? 'Stale Lead archived by admin' : `Stale Lead reassigned to ${access.assignedToName}`, ctx.actor,
          { fromStalePool: true, assignedToUid: target?.id || '' }));
        return { leadRefPath: path, changed: true };
      });
      results.push(result);
    } catch (error) { results.push({ leadRefPath: path, changed: false, reason: error.message, code: error.code || 'internal' }); }
  }
  return { ok: true, results, changed: results.filter(r => r.changed).length };
}
async function settings(ctx, write = false) {
  assertAdmin(ctx); const ref = ctx.db.doc(CONFIG);
  if (write) {
    if (typeof ctx.input.enabled !== 'boolean') throw new HttpsError('invalid-argument', 'enabled must be true or false.');
    await ref.set({ enabled: ctx.input.enabled, updatedAt: timestamp(), updatedByRef: ctx.actor.userRef }, { merge: true });
  }
  const data = (await ref.get()).data() || {};
  return { ok: true, enabled: data.enabled === true, days: DAYS, lastRunAt: iso(data.lastRunAt), lastScanned: data.lastScanned || 0, lastMoved: data.lastMoved || 0 };
}
async function scheduled(db) {
  const ref = db.doc(CONFIG), config = (await ref.get()).data() || {};
  if (config.enabled !== true) return { enabled: false, moved: 0 };
  // A bounded rolling cursor ensures protected early records cannot starve later leads.
  let token = config.pageToken || '', moved = 0, scanned = 0;
  const now = Date.now();
  for (let page = 0; page < 5; page++) {
    if ((await ref.get()).data()?.enabled !== true) break;
    const result = await sweepPage(db, { now, token, limit: 100, commit: true });
    moved += result.eligible; scanned += result.scanned; token = result.nextPageToken;
    await ref.set({ pageToken: token, lastRunAt: timestamp(), lastScanned: scanned, lastMoved: moved }, { merge: true });
    if (!token) break;
  }
  return { enabled: true, moved, scanned };
}
module.exports = { context, preview, list, manage, settings, scheduled, dormant, inPool, inspect, sweepPage, assertAdmin };
