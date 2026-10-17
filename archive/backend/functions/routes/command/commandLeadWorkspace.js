'use strict';

const admin = require('firebase-admin');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { commandActorContext } = require('../../lib/command/commandReportingUtils');
const { clean, refPath, iso, visible } = require('../../lib/command/commandOutreachSupport');
const { isPlatformAdminUser } = require('../../lib/command/commandPersonUtils');
const workspace = require('../../lib/command/commandLeadWorkspace');
const { refreshNextAction } = workspace;
// Existing commandMaintenance namespace is server-only under repository rules.
// Keep new note bodies/revisions there; root commandNotes remain readable as legacy data.
const NOTES = 'commandMaintenance/leadWorkspace/commandNotes';
const callable = fn => onCall({ region: 'us-central1', cors: true, timeoutSeconds: 60 }, fn);
const context = (request, deps) => (deps.context || commandActorContext)(request);

async function overviewService(request, deps = {}) { return workspace.overview(await context(request, deps)); }
async function sectionService(request, deps = {}) { return workspace.section(await context(request, deps)); }
function noteText(raw, field, required = false) {
  if (typeof raw !== 'string' || raw.length > (field === 'title' ? 200 : 10000) || (required && !raw.trim()))
    throw new HttpsError('invalid-argument', `Enter a valid ${field}.`);
  return raw.trim();
}
function notePath(raw) {
  if (!/^(commandNotes|commandMaintenance\/leadWorkspace\/commandNotes)\/[^/]+$/.test(clean(raw))) throw new HttpsError('invalid-argument', 'A valid note is required.');
  return raw;
}
function revisionCollection(path) { return `commandMaintenance/leadNote_${workspace.digest(path).slice(0, 40)}/revisions`; }
function authorName(ctx) { const d = ctx.actor.userData; return clean(d.fullName || d.displayName) || [clean(d.firstName), clean(d.lastName)].filter(Boolean).join(' ') || 'Representative'; }
function canEditNote(ctx, lead, note) {
  return note.createdByUid === ctx.uid || lead.ownerUid === ctx.uid || lead.assignedToUid === ctx.uid || isPlatformAdminUser(ctx.actor.userData);
}
async function saveNoteService(request, deps = {}) {
  const ctx = await context(request, deps), i = ctx.input;
  const title = i.title === undefined ? undefined : noteText(i.title, 'title');
  const body = i.body === undefined ? undefined : noteText(i.body, 'body', true);
  const updating = Boolean(i.noteRefPath);
  if (!updating && body === undefined) throw new HttpsError('invalid-argument', 'A note body is required.');
  if (i.pinned !== undefined && typeof i.pinned !== 'boolean') throw new HttpsError('invalid-argument', 'pinned must be boolean.');
  const requestId = clean(i.clientRequestId);
  if (!updating && (!requestId || requestId.length > 100)) throw new HttpsError('invalid-argument', 'A clientRequestId is required.');
  const ref = ctx.db.doc(updating ? notePath(i.noteRefPath) : `${NOTES}/lead_${workspace.digest([ctx.uid, requestId]).slice(0, 40)}`);
  const payloadHash = workspace.digest([i.leadRefPath, title || '', body || '', i.pinned === true]);
  return ctx.db.runTransaction(async tx => {
    const lead = await workspace.leadFor(ctx, i.leadRefPath, true, tx);
    const snap = await tx.get(ref), previous = snap.exists ? snap.data() : null;
    if (previous && refPath(previous.leadRef) !== lead.ref.path) throw new HttpsError('invalid-argument', 'Note does not belong to this Lead.');
    if (!updating && previous) {
      if (previous.createPayloadHash !== payloadHash) throw new HttpsError('already-exists', 'Request ID was already used for a different note.');
      return { ok: true, duplicate: true, noteRefPath: ref.path, revision: previous.revision };
    }
    if (updating && !previous) throw new HttpsError('not-found', 'Note not found.');
    if (previous && ((previous.managedByLeadWorkspace !== true && !visible(ctx.uid, ctx.actor.userData, previous)) || !canEditNote(ctx, lead.data, previous)))
      throw new HttpsError('permission-denied', 'You cannot edit this note.');
    if (updating && (!Number.isInteger(i.expectedRevision) || i.expectedRevision !== (previous.revision || 0)))
      throw new HttpsError('aborted', 'This note changed. Reload before saving.');
    const at = admin.firestore.Timestamp.now(), revision = (previous?.revision || 0) + 1;
    const data = { ...(previous || {}), leadRef: lead.ref, title: title ?? previous?.title ?? '', body: body ?? clean(previous?.body || previous?.notes),
      pinned: i.pinned ?? previous?.pinned ?? false, revision, managedByLeadWorkspace: true,
      ownerUid: lead.data.ownerUid || ctx.uid, ownerRef: lead.data.ownerRef || ctx.actor.userRef,
      assignedToUid: lead.data.assignedToUid || '', viewerUids: [...new Set([...(lead.data.viewerUids || []), ctx.uid])],
      teamRepIds: lead.data.teamRepIds || [], personRef: lead.data.primaryContactRef || lead.data.subjectPersonRef || null,
      organizationRef: lead.data.subjectOrganizationRef || null, createdAt: previous?.createdAt || at,
      createdByRef: previous?.createdByRef || ctx.actor.userRef, createdByUid: previous?.createdByUid || ctx.uid,
      createdByName: previous?.createdByName || authorName(ctx), updatedAt: at, updatedByRef: ctx.actor.userRef,
      updatedByName: authorName(ctx), createPayloadHash: previous?.createPayloadHash || payloadHash };
    if (previous) tx.create(ctx.db.doc(`${revisionCollection(ref.path)}/${previous.revision || 0}`), {
      title: clean(previous.title), body: clean(previous.body || previous.notes), pinned: previous.pinned === true, revision: previous.revision || 0,
      createdAt: at, previousUpdatedAt: previous.updatedAt || null, editedByName: authorName(ctx), editedByRef: ctx.actor.userRef,
    });
    if (updating) tx.set(ref, data); else tx.create(ref, data);
    tx.set(ctx.db.doc(`commandConnections/note_created_${ref.id}`), {
      type: 'note', managedByLeadWorkspace: true, summary: data.title || 'Note added', body: data.body, sourceRef: ref, leadRef: lead.ref,
      personRef: data.personRef, organizationRef: data.organizationRef, ownerUid: data.ownerUid, ownerRef: data.ownerRef,
      assignedToUid: data.assignedToUid, viewerUids: data.viewerUids, teamRepIds: data.teamRepIds,
      createdByRef: data.createdByRef, createdByUid: data.createdByUid, createdByName: data.createdByName,
      createdAt: data.createdAt, updatedAt: at, noteRevision: revision, pinned: data.pinned,
    });
    return { ok: true, noteRefPath: ref.path, revision, updatedAt: iso(at) };
  });
}
async function noteHistoryService(request, deps = {}) {
  const ctx = await context(request, deps), lead = await workspace.leadFor(ctx);
  const ref = ctx.db.doc(notePath(ctx.input.noteRefPath)), snap = await ref.get();
  if (!snap.exists || refPath(snap.data().leadRef) !== lead.ref.path || (snap.data().managedByLeadWorkspace !== true && !visible(ctx.uid, ctx.actor.userData, snap.data())))
    throw new HttpsError('permission-denied', 'Note is not accessible.');
  const result = await workspace.scanPage({ queries: [ctx.db.collection(revisionCollection(ref.path))], field: 'createdAt',
    fingerprint: workspace.digest([ctx.uid, ref.path, 'revisions']), token: ctx.input.pageToken,
    pageSize: workspace.sizeOf(ctx.input.pageSize), matches: () => true, serialize: d => ({ revision: d.data().revision,
      title: clean(d.data().title), body: clean(d.data().body), pinned: d.data().pinned === true,
      changedAt: iso(d.data().createdAt), editedByName: clean(d.data().editedByName) }) });
  return { ...result, current: { noteRefPath: ref.path, title: clean(snap.data().title), body: clean(snap.data().body || snap.data().notes),
    pinned: snap.data().pinned === true, revision: snap.data().revision || 0, createdByName: clean(snap.data().createdByName), updatedAt: iso(snap.data().updatedAt) } };
}
async function highlightsService(request, deps = {}) {
  const ctx = await context(request, deps), lead = await workspace.leadFor(ctx);
  const [pinSnapshots, conversations] = await Promise.all([
    Promise.all([NOTES, 'commandNotes'].map(c => ctx.db.collection(c).where('leadRef', '==', lead.ref).where('pinned', '==', true).limit(21).get())),
    workspace.section({ ...ctx, input: { leadRefPath: lead.ref.path, section: 'conversations', pageSize: 1 } }),
  ]);
  const pins = { docs: pinSnapshots.flatMap(s => s.docs), size: pinSnapshots.reduce((n, s) => n + s.size, 0) };
  return { ok: true, pinnedNotes: pins.docs.filter(d => d.data().managedByLeadWorkspace === true || visible(ctx.uid, ctx.actor.userData, d.data())).slice(0, 20)
    .map(d => ({ noteRefPath: d.ref.path, title: clean(d.data().title), body: clean(d.data().body), revision: d.data().revision,
      createdByName: clean(d.data().createdByName), createdAt: iso(d.data().createdAt), updatedAt: iso(d.data().updatedAt) })),
    morePinnedNotesAvailable: pins.size > 20, latestConversation: conversations.records[0] || null,
    conversationScanComplete: !conversations.scanLimited };
}

async function actionChanged(event, deps = {}) {
  const paths = [...new Set([event.data?.before?.data()?.leadRef, event.data?.after?.data()?.leadRef].map(refPath).filter(p => /^commandLeads\/[^/]+$/.test(p)))];
  const db = deps.db || admin.firestore();
  for (const path of paths) await refreshNextAction(db, db.doc(path));
}
exports.getCommandLeadOverview = callable(overviewService);
exports.listCommandLeadSection = callable(sectionService);
exports.saveCommandLeadNote = callable(saveNoteService);
exports.getCommandLeadNoteHistory = callable(noteHistoryService);
exports.getCommandLeadHighlights = callable(highlightsService);
exports.commandLeadNextActionSync = onDocumentWritten({ region: 'us-central1', document: 'commandActions/{actionId}', retry: true }, actionChanged);
exports._test = { overviewService, sectionService, saveNoteService, noteHistoryService, highlightsService, refreshNextAction, actionChanged, revisionCollection };
