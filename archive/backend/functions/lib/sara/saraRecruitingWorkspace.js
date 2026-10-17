'use strict';

const crypto = require('node:crypto');
const admin = require('firebase-admin');
const { HttpsError } = require('firebase-functions/v2/https');
const core = require('./saraCore');
const service = require('./saraService');

const TS = () => admin.firestore.FieldValue.serverTimestamp();
const ACTIVE_STATUSES = new Set(['booked', 'in_progress']);

function startAtText(value) {
  if (typeof value === 'string') return value;
  if (value?.toDate) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return '';
}

function sessionKey(row = {}) {
  const startAt = startAtText(row.startAt);
  const interviewer = core.clean(row.assignedInterviewerUid, 200);
  return startAt && interviewer ? `${interviewer}|${startAt}` : '';
}

function sessionIdFor(row = {}) {
  const key = sessionKey(row);
  return key ? `session_${crypto.createHash('sha256').update(key).digest('hex').slice(0, 32)}` : '';
}

function cleanAnswers(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output = {};
  for (const [rawKey, rawValue] of Object.entries(value).slice(0, 50)) {
    const key = core.clean(rawKey, 100);
    if (!key) continue;
    if (typeof rawValue === 'string') output[key] = core.clean(rawValue, 3000);
    else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) output[key] = rawValue;
    else if (typeof rawValue === 'boolean') output[key] = rawValue;
  }
  return output;
}

function candidateRefFor(db, row) {
  if (row.candidateRef?.get) return row.candidateRef;
  const id = core.clean(row.candidateId, 200);
  return id ? db.collection(core.COLLECTIONS.candidates).doc(id) : null;
}

async function visibleInterviewDocs(ctx) {
  const collection = ctx.db.collection(core.COLLECTIONS.interviews);
  const query = ctx.isAdmin
    ? collection.limit(1000)
    : collection.where('assignedInterviewerUid', '==', ctx.uid).limit(500);
  return (await query.get()).docs;
}

async function candidateMap(ctx, interviews) {
  const refs = [];
  const seen = new Set();
  for (const interview of interviews) {
    const ref = candidateRefFor(ctx.db, interview.data());
    if (ref && !seen.has(ref.path)) { seen.add(ref.path); refs.push(ref); }
  }
  const docs = refs.length ? await ctx.db.getAll(...refs) : [];
  return new Map(docs.filter(doc => doc.exists).map(doc => [doc.ref.path, { id:doc.id, ...doc.data() }]));
}

function rosterPerson(ctx, interview, candidates) {
  const row = interview.data();
  const ref = candidateRefFor(ctx.db, row);
  const candidate = (ref && candidates.get(ref.path)) || {};
  return service.callableValue({
    id:interview.id,
    interviewId:interview.id,
    candidateId:core.clean(row.candidateId || candidate.id, 200),
    candidateName:core.clean(candidate.name || row.candidateName || 'Candidate', 160),
    name:core.clean(candidate.name || row.candidateName || 'Candidate', 160),
    phone:core.clean(candidate.phoneE164 || candidate.phone || row.phone, 40),
    email:core.clean(candidate.email || row.email, 254),
    status:core.clean(row.status, 40),
    answers:cleanAnswers(row.answers),
    generalInterviewNotes:core.clean(row.generalInterviewNotes, 5000),
    recommendation:core.clean(row.recommendation || row.answers?.advancementRating, 80),
    noShow:row.status === 'no_show' || row.noShow === true,
    completed:row.status === 'completed' || row.completed === true,
    completedAt:row.completedAt || row.outcomeAt || null,
    startAt:row.startAt,
    interviewerName:core.clean(row.assignedInterviewerName, 160),
  });
}

function buildSession(ctx, interviews, candidates) {
  const rows = interviews.map(doc => doc.data());
  const first = rows[0] || {};
  const roster = interviews.map(doc => rosterPerson(ctx, doc, candidates));
  const hasActive = rows.some(row => ACTIVE_STATUSES.has(core.clean(row.status, 40)));
  return service.callableValue({
    id:sessionIdFor(first),
    sessionId:sessionIdFor(first),
    slotId:core.clean(first.slotId, 200),
    startAt:first.startAt,
    status:hasActive ? 'BOOKED' : 'COMPLETED',
    bookedCount:rows.filter(row => ACTIVE_STATUSES.has(core.clean(row.status, 40))).length,
    meetUrl:core.clean(first.interviewRoomUrl, 1000),
    interviewerUid:core.clean(first.assignedInterviewerUid, 200),
    interviewerName:core.clean(first.assignedInterviewerName, 160),
    presentationCompleted:rows.some(row => row.presentationCompleted === true),
    questionIndex:Math.max(0, ...rows.map(row => Number.isInteger(row.questionIndex) ? row.questionIndex : 0)),
    roster,
  });
}

async function loadSessions(ctx) {
  const interviews = await visibleInterviewDocs(ctx);
  const candidates = await candidateMap(ctx, interviews);
  const groups = new Map();
  for (const interview of interviews) {
    const id = sessionIdFor(interview.data());
    if (!id || interview.data().status === 'cancelled') continue;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(interview);
  }
  const sessions = [...groups.values()]
    .map(group => buildSession(ctx, group, candidates))
    .sort((a, b) => String(a.startAt || '').localeCompare(String(b.startAt || '')));
  return { interviews, candidates, sessions };
}

async function getWorkspace(ctx) {
  const { interviews, candidates, sessions } = await loadSessions(ctx);
  const completed = interviews
    .filter(doc => doc.data().status === 'completed')
    .map(doc => rosterPerson(ctx, doc, candidates))
    .sort((a, b) => String(b.completedAt || b.startAt || '').localeCompare(String(a.completedAt || a.startAt || '')));
  return { ok:true, sessions, candidates:completed };
}

async function getSession(ctx) {
  const requested = core.clean(ctx.data.sessionId, 100);
  if (!requested) throw new HttpsError('invalid-argument', 'Session ID is required.');
  const [{ sessions }, settings] = await Promise.all([
    loadSessions(ctx),
    core.getSettings(ctx.db),
  ]);
  const session = sessions.find(item => item.sessionId === requested);
  if (!session) throw new HttpsError('not-found', 'Interview session not found.');
  return {
    ok:true,
    session:{
      ...session,
      presentationUrl:core.clean(settings.interviewPresentationUrl, 1000),
    },
  };
}

async function authorizedInterview(ctx, interviewId, expectedSessionId) {
  const id = core.clean(interviewId, 200);
  if (!id) throw new HttpsError('invalid-argument', 'Interview ID is required.');
  const ref = ctx.db.collection(core.COLLECTIONS.interviews).doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Interview not found.');
  const row = snap.data();
  if (!ctx.isAdmin && core.clean(row.assignedInterviewerUid, 200) !== ctx.uid) {
    throw new HttpsError('permission-denied', 'This interview is not assigned to you.');
  }
  if (expectedSessionId && sessionIdFor(row) !== core.clean(expectedSessionId, 100)) {
    throw new HttpsError('failed-precondition', 'The interview does not belong to this session.');
  }
  return { ref, row };
}

async function saveDraft(ctx) {
  const { ref } = await authorizedInterview(ctx, ctx.data.interviewId, ctx.data.sessionId);
  const questionIndex = Math.max(0, Math.min(50, Math.trunc(Number(ctx.data.questionIndex) || 0)));
  await ref.set({
    answers:cleanAnswers(ctx.data.answers),
    generalInterviewNotes:core.clean(ctx.data.generalInterviewNotes, 5000),
    presentationCompleted:ctx.data.presentationCompleted === true,
    questionIndex,
    interviewDraftUpdatedAt:TS(), interviewDraftUpdatedByUid:ctx.uid, updatedAt:TS(),
  }, { merge:true });
  return { ok:true };
}

async function setOutcome(ctx, outcome) {
  const { ref, row } = await authorizedInterview(ctx, ctx.data.interviewId, ctx.data.sessionId);
  if (row.status === 'cancelled') throw new HttpsError('failed-precondition', 'A cancelled interview cannot be updated.');
  const answers = cleanAnswers(ctx.data.answers);
  const completed = outcome === 'completed';
  await ref.set({
    status:outcome, completed, noShow:outcome === 'no_show',
    ...(completed ? {
      answers,
      generalInterviewNotes:core.clean(ctx.data.generalInterviewNotes, 5000),
      presentationCompleted:ctx.data.presentationCompleted === true,
      recommendation:core.clean(answers.advancementRating, 80),
      completedAt:TS(), completedByUid:ctx.uid,
    } : { noShowAt:TS(), noShowByUid:ctx.uid }),
    outcomeAt:TS(), outcomeByUid:ctx.uid, updatedAt:TS(),
  }, { merge:true });
  const candidateRef = candidateRefFor(ctx.db, row);
  if (candidateRef) await candidateRef.set({ status:outcome, interviewOutcome:outcome, needsHuman:false, updatedAt:TS() }, { merge:true });
  return { ok:true, status:outcome };
}

async function markNoShow(ctx) { return setOutcome(ctx, 'no_show'); }
async function completeInterview(ctx) { return setOutcome(ctx, 'completed'); }

function safeEmail(value) {
  const email = core.clean(value, 254).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpsError('invalid-argument', 'Enter a valid email address or leave it blank.');
  return email;
}

async function addCandidate(ctx) {
  const requested = core.clean(ctx.data.sessionId, 100);
  const name = core.clean(ctx.data.name, 160).replace(/[<>]/g, '');
  if (name.length < 2) throw new HttpsError('invalid-argument', 'Candidate name is required.');
  const phone = core.clean(ctx.data.phone, 40) ? core.normalizePhone(ctx.data.phone) : '';
  const email = safeEmail(ctx.data.email);

  const { interviews, sessions } = await loadSessions(ctx);
  const session = sessions.find(item => item.sessionId === requested);
  if (!session) throw new HttpsError('not-found', 'Interview session not found.');
  const source = interviews.find(doc => sessionIdFor(doc.data()) === requested && doc.data().status !== 'cancelled');
  if (!source) throw new HttpsError('not-found', 'An active interview could not be found for this session.');
  const sourceRow = source.data();
  const settings = await core.getSettings(ctx.db);
  if (session.bookedCount >= settings.capacityPerSlot) throw new HttpsError('failed-precondition', 'This interview session is full.');

  let candidateDoc = null;
  if (phone) {
    const match = await ctx.db.collection(core.COLLECTIONS.candidates).where('phoneE164', '==', phone).limit(1).get();
    if (!match.empty) candidateDoc = match.docs[0];
  }
  if (!candidateDoc && email) {
    const match = await ctx.db.collection(core.COLLECTIONS.candidates).where('email', '==', email).limit(1).get();
    if (!match.empty) candidateDoc = match.docs[0];
  }
  const identity = phone || email;
  const candidateId = identity
    ? `workspace_${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 32)}`
    : '';
  const candidateRef = candidateDoc?.ref || (candidateId
    ? ctx.db.collection(core.COLLECTIONS.candidates).doc(candidateId)
    : ctx.db.collection(core.COLLECTIONS.candidates).doc());
  const existing = candidateDoc?.data() || {};

  const interviewRef = ctx.db.collection(core.COLLECTIONS.interviews).doc();
  const slotRef = sourceRow.slotId ? ctx.db.collection(core.COLLECTIONS.slots).doc(sourceRow.slotId) : null;
  await ctx.db.runTransaction(async tx => {
    const freshCandidate = await tx.get(candidateRef);
    const freshData = freshCandidate.data() || {};
    let activeBooking = null;
    if (freshData.bookedInterviewId) {
      activeBooking = await tx.get(ctx.db.collection(core.COLLECTIONS.interviews).doc(freshData.bookedInterviewId));
    }
    let slot = null;
    if (slotRef) {
      slot = await tx.get(slotRef);
    }
    if (freshData.status === 'opted_out' || freshData.controlMode === 'stopped') {
      throw new HttpsError('failed-precondition', 'This candidate opted out. Contact them outside Sara before booking.');
    }
    if (activeBooking?.exists && ACTIVE_STATUSES.has(core.clean(activeBooking.data().status, 40))) {
      throw new HttpsError('already-exists', 'This candidate already has an active interview booking.');
    }
    if (slotRef) {
      const reserved = Math.max(Number(slot.data()?.reserved || 0), Number(session.bookedCount || 0));
      if (reserved >= settings.capacityPerSlot) throw new HttpsError('failed-precondition', 'This interview session just filled.');
      tx.set(slotRef, { reserved:reserved + 1, capacity:settings.capacityPerSlot, startAt:sourceRow.startAt, updatedAt:TS() }, { merge:true });
    }
    tx.set(interviewRef, {
      candidateRef, candidateId:candidateRef.id, slotId:core.clean(sourceRow.slotId, 200), startAt:sourceRow.startAt,
      durationMinutes:Number(sourceRow.durationMinutes || settings.durationMinutes), timeZone:core.clean(sourceRow.timeZone || settings.timeZone, 100),
      interviewRoomUrl:core.clean(sourceRow.interviewRoomUrl || settings.interviewRoomUrl, 1000),
      assignedInterviewerUid:core.clean(sourceRow.assignedInterviewerUid, 200),
      assignedInterviewerName:core.clean(sourceRow.assignedInterviewerName, 160),
      assignedInterviewerEmail:core.clean(sourceRow.assignedInterviewerEmail, 254),
      status:'booked', bookingSource:'recruitingWorkspace', createdAt:TS(), createdByUid:ctx.uid, updatedAt:TS(),
    });
    tx.set(candidateRef, {
      name, firstName:name.split(/\s+/)[0], ...(phone ? { phoneE164:phone } : {}), ...(email ? { email } : {}),
      positionName:freshData.positionName || existing.positionName || settings.positionName, status:'booked', saraManaged:true,
      bookedInterviewId:interviewRef.id, bookedInterviewAt:sourceRow.startAt,
      assignedInterviewerUid:core.clean(sourceRow.assignedInterviewerUid, 200),
      assignedInterviewerName:core.clean(sourceRow.assignedInterviewerName, 160),
      assignedInterviewerEmail:core.clean(sourceRow.assignedInterviewerEmail, 254),
      updatedAt:TS(), ...(freshCandidate.exists ? {} : { createdAt:TS(), source:'recruitingWorkspace' }),
    }, { merge:true });
  });
  return { ok:true, interviewId:interviewRef.id, candidateId:candidateRef.id };
}

module.exports = {
  getWorkspace, getSession, saveDraft, markNoShow, completeInterview, addCandidate,
  _test:{ startAtText, sessionKey, sessionIdFor, cleanAnswers },
};
