'use strict';

const admin = require('firebase-admin');
const { HttpsError } = require('firebase-functions/v2/https');
const core = require('./saraCore');
const twilio = require('./saraTwilio');
const TS = () => admin.firestore.FieldValue.serverTimestamp();

function callableValue(value) {
  if (value == null || ['string','number','boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map(callableValue);
  if (typeof value?.toDate === 'function') return value.toDate().toISOString();
  if (typeof value?.path === 'string' && typeof value?.get === 'function') return value.path;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, callableValue(nested)]));
  return String(value);
}
const candidateView = doc => callableValue({ id:doc.id, path:doc.ref.path, ...doc.data() });

async function saveMessage(db, candidateRef, direction, body, extra = {}) {
  const sid = core.clean(extra.twilioSid, 100);
  const ref = sid ? db.collection(core.COLLECTIONS.messages).doc(`twilio_${sid}`) : db.collection(core.COLLECTIONS.messages).doc();
  await ref.set({ candidateRef, candidateId:candidateRef.id, direction, body:core.clean(body, 1600), createdAt:TS(), ...extra }, { merge:true });
  return ref;
}
async function sendCandidateSms(ctx, candidateRef, candidate, body, extra = {}) {
  const result = await twilio.sendSms({ to:candidate.phoneE164, body });
  try {
    await saveMessage(ctx.db, candidateRef, 'outbound', body, { twilioSid:result.sid || '', deliveryStatus:result.status || 'queued', sender:extra.sender || 'sara', ...(ctx.inboundSid ? { inReplyToSid:ctx.inboundSid } : {}), ...extra });
    await candidateRef.set({ lastMessage:body, lastOutboundAt:TS(), lastOutboundTwilioSid:result.sid || '', updatedAt:TS() }, { merge:true });
  } catch (error) {
    error.smsAccepted = true;
    error.twilioSid = result.sid || '';
    throw error;
  }
  return result;
}

async function dashboard(ctx) {
  const [settings, candidateSnap, interviewSnap, users] = await Promise.all([
    core.getSettings(ctx.db),
    ctx.db.collection(core.COLLECTIONS.candidates).orderBy('updatedAt', 'desc').limit(1000).get(),
    ctx.db.collection(core.COLLECTIONS.interviews).limit(1000).get(),
    ctx.db.collection('users').where('userType', '==', 'rep').get(),
  ]);
  const candidates = candidateSnap.docs.map(candidateView);
  const interviews = interviewSnap.docs.map(doc => callableValue({ id:doc.id, ...doc.data() })).sort((a, b) => String(a.startAt || '').localeCompare(String(b.startAt || '')));
  const counts = {
    total:candidates.length,
    ready:candidates.filter(row => row.status === 'ready').length,
    invited:candidates.filter(row => row.status === 'invited').length,
    booked:interviews.filter(row => row.status === 'booked').length,
    needsHuman:candidates.filter(row => row.needsHuman === true || row.status === 'human_help').length,
    deliveryIssues:candidates.filter(row => row.deliveryIssue === true).length,
  };
  const interviewers = users.docs.filter(doc => doc.data()?.active !== false).map(doc => {
    const row = doc.data() || {};
    return { uid:doc.id, name:core.clean(row.fullName || row.displayName || `${row.firstName || ''} ${row.lastName || ''}`), email:core.clean(row.email), role:core.clean(row.role || row.roleId) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { ok:true, settings, counts, candidates, interviews, interviewers };
}
async function saveSettings(ctx) {
  const values = core.sanitizeSettings(ctx.data.settings || ctx.data);
  const merged = { ...(await core.getSettings(ctx.db)), ...values };
  core.assertValidSettings(merged);
  if (merged.publicPageEnabled) {
    const interviewer = await ctx.db.collection('users').doc(merged.defaultInterviewerUid).get();
    if (!interviewer.exists || interviewer.data()?.active === false || interviewer.data()?.userType !== 'rep') throw new HttpsError('failed-precondition', 'Choose an active representative as the default interviewer.');
    const row = interviewer.data() || {};
    values.defaultInterviewerName = core.clean(row.fullName || row.displayName || `${row.firstName || ''} ${row.lastName || ''}`);
    values.defaultInterviewerEmail = core.clean(row.email);
  }
  await ctx.db.collection(core.COLLECTIONS.settings).doc(core.SETTINGS_ID).set({ ...values, updatedAt:TS(), updatedByUid:ctx.uid }, { merge:true });
  return { ok:true, settings:await core.getSettings(ctx.db) };
}
async function upsertCandidate(ctx) {
  const raw = ctx.data.candidate || ctx.data;
  const id = core.clean(raw.id, 200);
  const ref = id ? ctx.db.collection(core.COLLECTIONS.candidates).doc(id) : ctx.db.collection(core.COLLECTIONS.candidates).doc();
  const prior = await ref.get(), priorData = prior.exists ? prior.data() : {};
  const suppliedPhone = core.clean(raw.phone || raw.phoneE164, 30);
  const phoneE164 = suppliedPhone ? core.normalizePhone(suppliedPhone) : core.clean(priorData.phoneE164);
  if (!phoneE164) throw new HttpsError('invalid-argument', 'Candidate phone number is required.');
  const duplicate = await ctx.db.collection(core.COLLECTIONS.candidates).where('phoneE164', '==', phoneE164).limit(2).get();
  if (duplicate.docs.some(doc => doc.id !== ref.id)) throw new HttpsError('already-exists', 'A Sara candidate already uses this phone number.');
  const payload = { phoneE164, updatedAt:TS(), updatedByUid:ctx.uid };
  const fields = { name:200, firstName:100, lastName:100, email:254, positionName:200, applicationInformation:6000, assignedInterviewerUid:200, assignedInterviewerName:200, assignedInterviewerEmail:254 };
  for (const [key, max] of Object.entries(fields)) if (!prior.exists || Object.hasOwn(raw, key)) payload[key] = core.clean(raw[key], max);
  if (!payload.name && (payload.firstName || payload.lastName)) payload.name = `${payload.firstName || ''} ${payload.lastName || ''}`.trim();
  if (Object.hasOwn(raw, 'saraManaged')) payload.saraManaged = raw.saraManaged === true;
  if (Object.hasOwn(raw, 'outreachAllowed')) {
    if ((priorData.status === 'opted_out' || priorData.controlMode === 'stopped') && raw.outreachAllowed === true) throw new HttpsError('failed-precondition', 'This candidate opted out. Record new consent first.');
    payload.outreachAllowed = raw.outreachAllowed === true;
  }
  if (!prior.exists) Object.assign(payload, { status:'ready', saraManaged:raw.saraManaged === true, outreachAllowed:raw.outreachAllowed === true, createdAt:TS(), createdByUid:ctx.uid });
  await ref.set(payload, { merge:true });
  return { ok:true, candidateId:ref.id };
}
async function importCandidates(ctx) {
  const rows = Array.isArray(ctx.data.candidates) ? ctx.data.candidates : [];
  if (!rows.length) throw new HttpsError('invalid-argument', 'Add at least one candidate.');
  if (rows.length > 100) throw new HttpsError('invalid-argument', 'Import at most 100 candidates per batch.');
  const results = [];
  for (let index = 0; index < rows.length; index++) {
    try { results.push({ index, ...(await upsertCandidate({ ...ctx, data:{ candidate:rows[index] } })) }); }
    catch (error) { results.push({ index, ok:false, error:core.clean(error.message, 300) }); }
  }
  return { ok:results.every(row => row.ok), created:results.filter(row => row.ok).length, failed:results.filter(row => !row.ok).length, results };
}
async function conversation(ctx) {
  const id = core.clean(ctx.data.candidateId, 200);
  const candidate = await ctx.db.collection(core.COLLECTIONS.candidates).doc(id).get();
  if (!candidate.exists) throw new HttpsError('not-found', 'Candidate not found.');
  const messages = await ctx.db.collection(core.COLLECTIONS.messages).where('candidateId', '==', id).orderBy('createdAt', 'asc').limit(500).get();
  return { ok:true, candidate:candidateView(candidate), messages:messages.docs.map(doc => callableValue({ id:doc.id, ...doc.data() })) };
}
async function manualReply(ctx) {
  const id = core.clean(ctx.data.candidateId, 200), body = core.clean(ctx.data.body, 1500);
  if (!body) throw new HttpsError('invalid-argument', 'Message is required.');
  const ref = ctx.db.collection(core.COLLECTIONS.candidates).doc(id), snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Candidate not found.');
  if (snap.data().status === 'opted_out' || snap.data().controlMode === 'stopped') throw new HttpsError('failed-precondition', 'This candidate opted out. Record new consent before sending.');
  try {
    await sendCandidateSms(ctx, ref, snap.data(), body, { sender:'human', messageType:'manual' });
  } catch (error) {
    if (!error.smsAccepted) throw error;
    await ref.set({ needsHuman:true, messageTrackingIssue:true, messageTrackingError:core.clean(error.message, 400), updatedAt:TS() }, { merge:true });
    return { ok:true, acceptedUntracked:true };
  }
  await ref.set({ controlMode:'human', needsHuman:false, updatedAt:TS() }, { merge:true });
  return { ok:true };
}
async function setControl(ctx) {
  const mode = core.clean(ctx.data.mode, 20);
  if (!['human','stopped'].includes(mode)) throw new HttpsError('invalid-argument', 'Choose human or stopped. Sara no longer runs automated conversations.');
  const ref = ctx.db.collection(core.COLLECTIONS.candidates).doc(core.clean(ctx.data.candidateId, 200));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Candidate not found.');
  await ref.set({ controlMode:mode, outreachAllowed:mode !== 'stopped', needsHuman:mode === 'human', ...(mode === 'stopped' ? { status:'stopped' } : {}), updatedAt:TS(), updatedByUid:ctx.uid }, { merge:true });
  return { ok:true };
}

function localParts(date, timeZone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year:'numeric', month:'2-digit', day:'2-digit', weekday:'short' }).formatToParts(date).map(part => [part.type, part.value]));
}
function offsetAt(date, timeZone) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName:'shortOffset', hour:'2-digit' }).formatToParts(date).find(part => part.type === 'timeZoneName')?.value || 'GMT';
  const match = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  return match ? `${match[1]}${match[2].padStart(2, '0')}:${match[3] || '00'}` : '+00:00';
}
function slotIso(year, month, day, hour, minute, timeZone) {
  const hh = String(hour).padStart(2, '0'), mm = String(minute).padStart(2, '0');
  return `${year}-${month}-${day}T${hh}:${mm}:00${offsetAt(new Date(`${year}-${month}-${day}T${hh}:${mm}:00Z`), timeZone)}`;
}
function selectOfferedSlots(slots, maximum = 3) {
  const groups = [];
  for (const slot of Array.isArray(slots) ? slots : []) {
    const day = core.clean(slot.startAt, 40).slice(0, 10);
    let group = groups.find(item => item.day === day);
    if (!group) { group = { day, slots:[] }; groups.push(group); }
    group.slots.push(slot);
  }
  const selected = [], used = new Set();
  const add = slot => { if (slot && !used.has(slot.slotId) && selected.length < maximum) { used.add(slot.slotId); selected.push(slot); } };
  const first = groups[0]?.slots || [];
  add(first[0]);
  if (first.length > 1) { const start = Date.parse(first[0].startAt); add(first.find(slot => Date.parse(slot.startAt) - start >= 120 * 60000)); }
  add(groups[1]?.slots?.[0]);
  for (const group of groups) for (const slot of group.slots) add(slot);
  return selected;
}
async function availability(ctx) {
  const settings = await core.getSettings(ctx.db), now = new Date(), allowed = new Set(settings.allowedWeekdays.map(Number)), slots = [];
  let includedDays = 0;
  for (let i = 1; i <= settings.daysAhead && includedDays < settings.offeredDayCount; i++) {
    const parts = localParts(new Date(now.getTime() + i * 86400000), settings.timeZone);
    const weekday = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(parts.weekday);
    if (!allowed.has(weekday)) continue;
    const dateKey = `${parts.year}-${parts.month}-${parts.day}`;
    const blockSnap = await ctx.db.collection(core.COLLECTIONS.blocks).where('dateKey', '==', dateKey).get();
    const blocks = blockSnap.docs.map(doc => doc.data()).filter(row => row.active !== false);
    if (blocks.some(row => row.allDay === true)) continue;
    const blocked = new Set(blocks.map(row => core.clean(row.slotId, 200)).filter(Boolean));
    const before = slots.length;
    for (let minute = settings.dailyStartHour * 60; minute + settings.durationMinutes <= settings.dailyEndHour * 60; minute += settings.durationMinutes) {
      const startAt = slotIso(parts.year, parts.month, parts.day, Math.floor(minute / 60), minute % 60, settings.timeZone);
      const slotId = Buffer.from(startAt).toString('base64url');
      const snap = await ctx.db.collection(core.COLLECTIONS.slots).doc(slotId).get();
      const reserved = Number(snap.data()?.reserved || 0);
      if (!blocked.has(slotId) && reserved < settings.capacityPerSlot) slots.push({ slotId, startAt, remaining:settings.capacityPerSlot - reserved });
    }
    if (slots.length > before) includedDays++;
  }
  return { ok:true, timeZone:settings.timeZone, durationMinutes:settings.durationMinutes, slots };
}

async function candidateForSaraUser(ctx, candidateId) {
  const snap = await ctx.db.collection(core.COLLECTIONS.candidates).doc(core.clean(candidateId, 200)).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Candidate not found.');
  if (!ctx.isAdmin && core.clean(snap.data().assignedInterviewerUid, 200) !== ctx.uid) throw new HttpsError('permission-denied', 'This candidate is not assigned to you.');
  return snap;
}
async function repWorkspace(ctx) {
  const candidates = await (ctx.isAdmin ? ctx.db.collection(core.COLLECTIONS.candidates).limit(1000) : ctx.db.collection(core.COLLECTIONS.candidates).where('assignedInterviewerUid', '==', ctx.uid).limit(500)).get();
  const interviews = await (ctx.isAdmin ? ctx.db.collection(core.COLLECTIONS.interviews).limit(1000) : ctx.db.collection(core.COLLECTIONS.interviews).where('assignedInterviewerUid', '==', ctx.uid).limit(500)).get();
  return { ok:true, candidates:candidates.docs.map(candidateView), interviews:interviews.docs.map(doc => callableValue({ id:doc.id, ...doc.data() })) };
}
async function scopedConversation(ctx) { await candidateForSaraUser(ctx, ctx.data.candidateId); return conversation(ctx); }
async function scopedManualReply(ctx) { await candidateForSaraUser(ctx, ctx.data.candidateId); return manualReply(ctx); }
async function scopedSetControl(ctx) { await candidateForSaraUser(ctx, ctx.data.candidateId); return setControl(ctx); }
async function resolveHumanHelp(ctx) {
  const snap = await candidateForSaraUser(ctx, ctx.data.candidateId);
  await snap.ref.set({ needsHuman:false, controlMode:'human', humanHelpResolvedAt:TS(), humanHelpResolvedByUid:ctx.uid, humanHelpResolution:core.clean(ctx.data.resolution, 1000), humanHelpReason:admin.firestore.FieldValue.delete(), updatedAt:TS() }, { merge:true });
  return { ok:true };
}
async function recordConsent(ctx) {
  if (ctx.data.confirmed !== true) throw new HttpsError('invalid-argument', 'Explicit consent confirmation is required.');
  const ref = ctx.db.collection(core.COLLECTIONS.candidates).doc(core.clean(ctx.data.candidateId, 200));
  const snap = await ref.get(); if (!snap.exists) throw new HttpsError('not-found', 'Candidate not found.');
  await ref.set({ status:'ready', controlMode:'human', outreachAllowed:true, saraManaged:true, needsHuman:false, reconsentedAt:TS(), reconsentedByUid:ctx.uid, optedOutAt:admin.firestore.FieldValue.delete(), optOutMessage:admin.firestore.FieldValue.delete(), updatedAt:TS() }, { merge:true });
  return { ok:true };
}
async function listInterviews(ctx) {
  const snap = await (ctx.isAdmin ? ctx.db.collection(core.COLLECTIONS.interviews).limit(1000) : ctx.db.collection(core.COLLECTIONS.interviews).where('assignedInterviewerUid', '==', ctx.uid).limit(500)).get();
  return { ok:true, interviews:snap.docs.map(doc => callableValue({ id:doc.id, ...doc.data() })).sort((a, b) => String(a.startAt || '').localeCompare(String(b.startAt || ''))) };
}
async function saveAvailabilityBlock(ctx) {
  const dateKey = core.clean(ctx.data.dateKey, 10), allDay = ctx.data.allDay === true, startAt = core.clean(ctx.data.startAt, 80);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw new HttpsError('invalid-argument', 'Use YYYY-MM-DD.');
  if (!allDay && (!startAt || Number.isNaN(Date.parse(startAt)))) throw new HttpsError('invalid-argument', 'A valid start time is required.');
  const id = core.clean(ctx.data.id, 200), ref = id ? ctx.db.collection(core.COLLECTIONS.blocks).doc(id) : ctx.db.collection(core.COLLECTIONS.blocks).doc();
  await ref.set({ dateKey, allDay, startAt, slotId:allDay ? '' : Buffer.from(startAt).toString('base64url'), active:true, reason:core.clean(ctx.data.reason, 500), updatedAt:TS(), ...(id ? {} : { createdAt:TS(), createdByUid:ctx.uid }) }, { merge:true });
  return { ok:true, id:ref.id };
}
async function deleteAvailabilityBlock(ctx) {
  const id = core.clean(ctx.data.id, 200);
  if (!id) throw new HttpsError('invalid-argument', 'Availability block ID is required.');
  await ctx.db.collection(core.COLLECTIONS.blocks).doc(id).delete();
  return { ok:true };
}
async function listAvailabilityBlocks(ctx) {
  const snap = await ctx.db.collection(core.COLLECTIONS.blocks).limit(500).get();
  return { ok:true, blocks:snap.docs.map(doc => callableValue({ id:doc.id, ...doc.data() })).sort((a, b) => String(a.dateKey || '').localeCompare(String(b.dateKey || ''))) };
}
async function updateInterviewOutcome(ctx) {
  const outcome = core.clean(ctx.data.outcome, 40), ref = ctx.db.collection(core.COLLECTIONS.interviews).doc(core.clean(ctx.data.interviewId, 200));
  if (!['completed','no_show','cancelled'].includes(outcome)) throw new HttpsError('invalid-argument', 'Choose completed, no_show or cancelled.');
  const snap = await ref.get(); if (!snap.exists) throw new HttpsError('not-found', 'Interview not found.');
  const row = snap.data();
  if (!ctx.isAdmin && row.assignedInterviewerUid !== ctx.uid) throw new HttpsError('permission-denied', 'This interview is not assigned to you.');
  if (outcome === 'cancelled' && row.status === 'booked' && row.slotId) {
    const slotRef = ctx.db.collection(core.COLLECTIONS.slots).doc(row.slotId);
    await ctx.db.runTransaction(async tx => { const slot = await tx.get(slotRef); tx.set(slotRef, { reserved:Math.max(0, Number(slot.data()?.reserved || 0) - 1), updatedAt:TS() }, { merge:true }); });
  }
  await ref.set({ status:outcome, outcomeNote:core.clean(ctx.data.note, 1000), outcomeAt:TS(), outcomeByUid:ctx.uid, updatedAt:TS() }, { merge:true });
  const candidateRef = row.candidateRef || ctx.db.collection(core.COLLECTIONS.candidates).doc(row.candidateId);
  await candidateRef.set({ status:outcome, interviewOutcome:outcome, needsHuman:false, ...(outcome === 'cancelled' ? { bookedInterviewId:admin.firestore.FieldValue.delete(), bookedInterviewAt:admin.firestore.FieldValue.delete() } : {}), updatedAt:TS() }, { merge:true });
  return { ok:true, status:outcome };
}

module.exports = { callableValue, dashboard, saveSettings, upsertCandidate, importCandidates, conversation, manualReply, setControl, availability, saveMessage, sendCandidateSms, selectOfferedSlots, candidateForSaraUser, repWorkspace, scopedConversation, scopedManualReply, scopedSetControl, resolveHumanHelp, recordConsent, listInterviews, saveAvailabilityBlock, deleteAvailabilityBlock, listAvailabilityBlocks, updateInterviewOutcome, _test:{ slotIso, selectOfferedSlots } };
