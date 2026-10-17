'use strict';

const crypto = require('node:crypto');
const admin = require('firebase-admin');
const { HttpsError } = require('firebase-functions/v2/https');
const { isPlatformAdminUser } = require('./commandPersonUtils');
const { clean, refPath, iso, visible, readContacts, contactFields } = require('./commandOutreachSupport');

const { projectWork } = require('./commandLeadWorkState');

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sizeOf = (raw, fallback = 20) => Number.isFinite(Number(raw)) ? Math.min(50, Math.max(1, Math.trunc(Number(raw)) || fallback)) : fallback;
function timestampKey(doc, field) {
  const at = doc.data()[field];
  return { seconds: at?.seconds ?? Math.floor((at?.toMillis?.() || 0) / 1000), nanoseconds: at?.nanoseconds || 0, id: doc.id };
}
function compareKeys(a, b) {
  return b.seconds - a.seconds || b.nanoseconds - a.nanoseconds || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}
function encodeCursor(key, fingerprint) { return Buffer.from(JSON.stringify({ v: 1, key, fingerprint })).toString('base64url'); }
function decodeCursor(raw, fingerprint) {
  if (!clean(raw)) return null;
  try {
    if (raw.length > 2048) throw Error();
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString());
    const k = parsed.key;
    if (parsed.v !== 1 || parsed.fingerprint !== fingerprint || !Number.isSafeInteger(k?.seconds) ||
        !Number.isInteger(k?.nanoseconds) || k.nanoseconds < 0 || k.nanoseconds >= 1e9 ||
        !clean(k?.id) || k.id.includes('/')) throw Error();
    return k;
  } catch (_) { throw new HttpsError('invalid-argument', 'This page token does not match this account and view. Refresh the list.'); }
}

// Bounded merge of independently indexed ownership/visibility queries. Every
// shard starts after the same full-precision ordering key; discarded lookahead
// is fetched again, never skipped. Sparse filters can return an empty page.
async function scanPage({ queries, field, fingerprint, token, pageSize, matches, serialize, rounds = 5 }) {
  let cursor = decodeCursor(token, fingerprint), exhausted = false, scanned = 0;
  const records = [], batchSize = Math.max(20, pageSize);
  for (let round = 0; round < rounds && records.length < pageSize; round++) {
    const snapshots = await Promise.all(queries.map(base => {
      let q = base.orderBy(field, 'desc').orderBy(admin.firestore.FieldPath.documentId(), 'desc');
      if (cursor) q = q.startAfter(new admin.firestore.Timestamp(cursor.seconds, cursor.nanoseconds), cursor.id);
      return q.limit(batchSize).get();
    }));
    scanned += snapshots.reduce((sum, snap) => sum + snap.size, 0);
    const merged = [...new Map(snapshots.flatMap(s => s.docs).map(d => [d.ref.path, d])).values()]
      .sort((a, b) => compareKeys(timestampKey(a, field), timestampKey(b, field)));
    const candidates = merged.slice(0, batchSize);
    if (!candidates.length) { exhausted = true; break; }
    let used = 0;
    for (const doc of candidates) {
      cursor = timestampKey(doc, field); used++;
      if (matches(doc.data(), doc)) records.push(serialize(doc));
      if (records.length === pageSize) break;
    }
    exhausted = used === merged.length && snapshots.every(s => s.size < batchSize);
    if (exhausted) break;
  }
  return { ok: true, result: 'success', records, returnedRecords: records.length, scannedRecords: scanned,
    hasMore: !exhausted, nextPageToken: !exhausted && cursor ? encodeCursor(cursor, fingerprint) : '',
    scanLimited: !exhausted && records.length < pageSize, totalRecords: null };
}

async function listLeads(ctx, { serializeLead, matchesFilters }) {
  if (ctx.actor.userData.active === false) throw new HttpsError('permission-denied', 'Inactive representatives cannot access Leads.');
  const i = ctx.input, scope = clean(i.scope || 'mine').toLowerCase();
  const isAdmin = isPlatformAdminUser(ctx.actor.userData);
  if (!['mine', 'team', 'all'].includes(scope) || (scope === 'all' && !isAdmin))
    throw new HttpsError('permission-denied', 'Choose an available Lead scope.');
  const c = ctx.db.collection('commandLeads'), repId = String(ctx.actor.userData.repId ?? '').trim();
  const repIds = repId ? [repId, ...(String(Number(repId)) === repId ? [Number(repId)] : [])] : [];
  let queries = scope === 'mine' ? [c.where('ownerUid', '==', ctx.uid), c.where('assignedToUid', '==', ctx.uid)]
    : isAdmin ? [c] : [c.where('viewerUids', 'array-contains', ctx.uid), ...(repId ? [c.where('teamRepIds', 'array-contains-any', repIds)] : [])];
  const filters = { scope, archived: i.archived === true, leadType: clean(i.leadType), stage: clean(i.stage),
    status: clean(i.status), assignedToUid: clean(i.assignedToUid), leadListId: clean(i.leadListId), search: clean(i.search || i.query) };
  if (filters.status === 'stale' && !isAdmin) throw new HttpsError('permission-denied', 'Stale Leads are managed by platform administrators.');
  const requestedStatus = filters.status.toLowerCase();
  if (requestedStatus && !['all', 'active', 'won', 'lost', 'archived', 'stale'].includes(requestedStatus)) throw new HttpsError('invalid-argument', 'Invalid Lead status.');
  filters.status = requestedStatus === 'all' ? '' : requestedStatus;
  queries = queries.map(q => {
    q = q.where('archived', '==', filters.archived);
    if (filters.status) return q.where('status', '==', filters.status);
    return filters.archived ? q.where('status', '==', 'archived') : q.where('status', 'in', ['active', 'won', 'lost']);
  });
  if (filters.stage) {
    const canonical = ['New', 'Opened', 'Engaged', 'Closing', 'Won', 'Lost'].find(v => v.toLowerCase() === filters.stage.toLowerCase());
    if (!canonical) throw new HttpsError('invalid-argument', 'Invalid Lead stage.');
    queries = queries.map(q => q.where('stage', '==', canonical));
  }
  if (filters.leadListId) queries = queries.map(q => q.where('leadListId', '==', filters.leadListId));
  if (filters.search.length > 200) throw new HttpsError('invalid-argument', 'Search is too long.');
  return scanPage({ queries, field: 'updatedAt', fingerprint: digest([ctx.uid, 'leads', filters]), token: i.pageToken,
    pageSize: sizeOf(i.pageSize), matches: d => {
      const mine = d.ownerUid === ctx.uid || d.assignedToUid === ctx.uid;
      return visible(ctx.uid, ctx.actor.userData, d) && (scope !== 'mine' || mine) && (scope !== 'team' || !mine) && matchesFilters(d, filters);
    }, serialize: doc => {
      const row = serializeLead(doc.ref, doc.data());
      if (i.summaryOnly === true) {
        const keys = ['id', 'refPath', 'displayName', 'leadType', 'stage', 'status', 'archived', 'primaryContactName',
          'subjectPersonName', 'subjectOrganizationName', 'assignedToName', 'nextActionTitle', 'nextActionType', 'nextActionAt', 'updatedAt'];
        return { ...Object.fromEntries(keys.map(k => [k, row[k] ?? null])), nextActionResolutionIncomplete: doc.data().nextActionResolutionIncomplete === true };
      }
      return row;
    } });
}

async function leadFor(ctx, raw = ctx.input.leadRefPath, writable = false, tx = null) {
  if (ctx.actor.userData.active === false) throw new HttpsError('permission-denied', 'Inactive representatives cannot access Leads.');
  if (!/^commandLeads\/[^/]+$/.test(clean(raw))) throw new HttpsError('invalid-argument', 'A Lead is required.');
  const ref = ctx.db.doc(raw), snap = await (tx ? tx.get(ref) : ref.get());
  if (!snap.exists) throw new HttpsError('not-found', 'Lead not found.');
  const data = snap.data();
  if (!visible(ctx.uid, ctx.actor.userData, data)) throw new HttpsError('permission-denied', 'Lead is not accessible.');
  if (writable && data.archived === true) throw new HttpsError('failed-precondition', 'Restore this Lead before editing.');
  return { ref, data };
}

function serializeRecord(doc) {
  const d = doc.data(), out = { refPath: doc.ref.path };
  // Explicit allowlist: never return private agreement tokens or email routing data.
  for (const key of ['title', 'description', 'actionType', 'status', 'priority', 'assignedToName', 'ownerName',
    'personName', 'organizationName', 'meetingStatus', 'meetingOutcome', 'meetingOutcomeNotes', 'mainBlocker', 'blockerNotes',
    'locationType', 'location', 'meetingLink', 'documentTitle', 'contactName', 'email', 'subject', 'snippet', 'lastMessagePreview',
    'type', 'eventType', 'summary', 'body', 'createdByName', 'dialedPhone', 'previousStage', 'nextStage',
    'lostReason', 'completionNotes', 'cancellationReason', 'meetingType', 'presentationType']) out[key] = clean(d[key]);
  for (const key of ['createdAt', 'updatedAt', 'dueAt', 'startAt', 'endAt', 'meetingStartedAt', 'meetingFinishedAt',
    'sentAt', 'signedAt', 'lastMessageAt', 'eventAt', 'startedAt', 'finishedAt', 'completedAt']) out[key] = iso(d[key]);
  for (const key of ['leadRef', 'personRef', 'organizationRef', 'sourceRef', 'actionRef', 'callRef', 'threadRef', 'assignedToRef']) out[key + 'Path'] = refPath(d[key]);
  out.notes = clean(d.body || d.details?.notes || d.meetingOutcomeNotes || d.completionNotes);
  out.mainBlocker = clean(d.mainBlocker || d.details?.mainBlocker);
  out.blockerNotes = clean(d.blockerNotes || d.details?.blockerNotes);
  out.noteRevision = Number.isInteger(d.noteRevision) ? d.noteRevision : 0;
  out.pinned = d.pinned === true;
  out.outcome = clean(d.outcome || d.details?.outcome);
  out.durationSeconds = Number.isFinite(d.durationSeconds) ? d.durationSeconds : null;
  out.meetingDurationSeconds = Number.isFinite(d.meetingDurationSeconds) ? d.meetingDurationSeconds : null;
  return out;
}

function chooseNext(docs, now = Date.now()) {
  return docs.filter(doc => { const d = doc.data(); return d.status === 'open' && d.archived !== true &&
    !['completed', 'cancelled', 'no_show'].includes(clean(d.meetingStatus)); })
    .sort((a, b) => {
      const time = doc => (doc.data().actionType?.toLowerCase() === 'meeting' ? doc.data().startAt || doc.data().dueAt : doc.data().dueAt)?.toMillis?.() ?? Number.MAX_SAFE_INTEGER;
      const priority = doc => doc.data().meetingStatus === 'in_progress' ? 0 : time(doc) <= now ? 1 : 2;
      return priority(a) - priority(b) || time(a) - time(b) || a.id.localeCompare(b.id);
    })[0] || null;
}
async function nextWork(ctx, lead, tx = null) {
  const q = ctx.db.collection('commandActions').where('leadRef', '==', lead.ref).where('status', '==', 'open').limit(201);
  const snap = await (tx ? tx.get(q) : q.get());
  const allowed = snap.docs.filter(d => visible(ctx.uid, ctx.actor.userData, d.data()));
  return { complete: snap.size <= 200, doc: snap.size <= 200 ? chooseNext(allowed) : null };
}
async function overview(ctx) {
  const lead = await leadFor(ctx);
  const [contacts, next] = await Promise.all([readContacts(ctx, lead.data), nextWork(ctx, lead)]);
  const org = contacts.find(d => d.ref.path === refPath(lead.data.subjectOrganizationRef));
  const fields = ['organization', 'website', 'phone', 'email', 'industry', 'address', 'city', 'province', 'postalCode', 'notes'];
  return { ok: true, lead: { refPath: lead.ref.path, name: clean(lead.data.displayName), leadType: clean(lead.data.leadType),
      stage: clean(lead.data.stage), status: clean(lead.data.status), archived: lead.data.archived === true, updatedAt: iso(lead.data.updatedAt),
      assignedToName: clean(lead.data.assignedToName), source: clean(lead.data.source), leadListId: clean(lead.data.leadListId),
      leadListName: clean(lead.data.leadListName), notes: clean(lead.data.notes), opportunityDetails: clean(lead.data.opportunityDetails),
      primaryContactRefPath: refPath(lead.data.primaryContactRef), organizationRefPath: refPath(lead.data.subjectOrganizationRef) },
    organization: org ? { refPath: org.ref.path, updatedAt: iso(org.data().updatedAt), ...Object.fromEntries(fields.map(k => [k, clean(org.data()[k])])) } : null,
    organizationUnavailable: Boolean(lead.data.subjectOrganizationRef && !org),
    contacts: contacts.map(d => ({ ...contactFields(d, lead.data), firstName: clean(d.data().firstName), lastName: clean(d.data().lastName),
      notes: clean(d.data().notes), updatedAt: iso(d.data().updatedAt),
      ...(d.ref.path.startsWith('commandOrganizations/') && contacts.blockBusinessFallback ? { canCall: false } : {}) })),
    nextAction: next.doc ? serializeRecord(next.doc) : null, nextActionComplete: next.complete,
    editEndpoints: { person: 'updateCommandPerson', organization: 'updateCommandOrganization', lead: 'updateCommandLead' } };
}

const CONVERSATIONS = ['call_finished', 'call', 'meeting_held', 'meeting_finished', 'meeting_no_show', 'email_received', 'email_sent'];
const SECTIONS = { conversations: ['commandConnections', 'createdAt'], activity: ['commandConnections', 'createdAt'], notes: ['commandConnections', 'createdAt'],
  actions: ['commandActions', 'createdAt'], meetings: ['commandActions', 'createdAt'], agreements: ['commandAgreements', 'createdAt'],
  emails: ['commandEmailThreads', 'lastMessageAt'] };
async function section(ctx) {
  const lead = await leadFor(ctx), kind = clean(ctx.input.section), config = SECTIONS[kind];
  if (!config) throw new HttpsError('invalid-argument', 'Choose activity, notes, actions, meetings, agreements, or emails.');
  const search = clean(ctx.input.search).toLowerCase(), status = clean(ctx.input.status || 'all');
  if (search.length > 200) throw new HttpsError('invalid-argument', 'Search is too long.');
  let query = ctx.db.collection(config[0]).where('leadRef', '==', lead.ref);
  if (kind === 'conversations') query = query.where('type', 'in', CONVERSATIONS);
  const result = await scanPage({ queries: [query], field: config[1],
    fingerprint: digest([ctx.uid, lead.ref.path, kind, search, status]), token: ctx.input.pageToken, pageSize: sizeOf(ctx.input.pageSize),
    matches: d => {
      // A rep taking over a Lead needs its recorded calls, meetings and notes.
      // Preserve separate ExMail visibility and open Action assignment rules.
      const leadWorker = lead.data.assignedToUid === ctx.uid || lead.data.ownerUid === ctx.uid;
      const leadHistory = config[0] === 'commandConnections' && !/^email/.test(clean(d.eventType || d.type).toLowerCase());
      const permitted = kind === 'emails'
        ? isPlatformAdminUser(ctx.actor.userData) || d.ownerUid === ctx.uid || (d.viewerUids || []).includes(ctx.uid) || (d.teamRepIds || []).includes(String(ctx.actor.userData.repId ?? ''))
        : leadWorker && leadHistory || (d.type === 'note' && d.managedByLeadWorkspace === true) || visible(ctx.uid, ctx.actor.userData, d);
      if (!permitted || d.archived === true) return false;
      if (status !== 'all' && d.status !== status) return false;
      const type = clean(d.eventType || d.type).toLowerCase();
      if (kind === 'notes' && (!['note', 'lead_details_updated', 'call_finished', 'call', 'meeting_held', 'meeting_completed', 'meeting_finished', 'meeting_outcome', 'meeting_no_show'].includes(type) || !clean(d.body || d.details?.notes))) return false;
      if (kind === 'actions' && clean(d.actionType).toLowerCase() === 'meeting') return false;
      if (kind === 'meetings' && clean(d.actionType).toLowerCase() !== 'meeting') return false;
      return !search || [d.title, d.summary, d.body, d.description, d.subject, d.details?.notes].some(v => clean(v).toLowerCase().includes(search));
    }, serialize: doc => ({ ...serializeRecord(doc), ...(kind === 'emails' ? { unread: (doc.data().unreadBy || []).includes(ctx.uid) } : {}) }) });
  return { ...result, section: kind };
}

async function refreshNextAction(db, leadRef) {
  return db.runTransaction(async tx => {
    const lead = await tx.get(leadRef);
    if (!lead.exists) return;
    const actions = await tx.get(db.collection('commandActions').where('leadRef', '==', leadRef).where('status', '==', 'open').limit(201));
    if (actions.size > 200) { tx.update(leadRef, { nextActionResolutionIncomplete: true, flowWork: projectWork(actions.docs), flowWorkUpdatedAt: admin.firestore.Timestamp.now() }); return; }
    const next = chooseNext(actions.docs), data = next?.data();
    const at = data ? (clean(data.actionType).toLowerCase() === 'meeting' ? data.startAt || data.dueAt : data.dueAt) : null;
    tx.update(leadRef, { nextActionRef: next?.ref || null, nextActionTitle: clean(data?.title), nextActionType: clean(data?.actionType),
      nextActionAt: at || null, nextActionResolutionIncomplete: false,
      flowWork: projectWork(actions.docs), flowWorkUpdatedAt: admin.firestore.Timestamp.now() });
  });
}

module.exports = { refreshNextAction, digest, sizeOf, scanPage, listLeads, leadFor, serializeRecord, chooseNext, nextWork, overview, section, encodeCursor, decodeCursor };


