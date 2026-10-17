'use strict';

const crypto = require('node:crypto');
const admin = require('firebase-admin');
const { HttpsError } = require('firebase-functions/v2/https');
const core = require('./saraCore');
const service = require('./saraService');
const TS = () => admin.firestore.FieldValue.serverTimestamp();

function publicSettings(settings) {
  return {
    enabled: settings.active === true && settings.publicPageEnabled === true,
    heroHeadline: settings.heroHeadline,
    heroSubheadline: settings.heroSubheadline,
    promoVideoUrl: settings.promoVideoUrl,
    companyInformation: settings.companyInformation,
    positionName: settings.positionName,
    positionDescription: settings.positionDescription,
    responsibilities: settings.responsibilities,
    idealCandidateDescription: settings.idealCandidateDescription,
    compensationInformation: settings.compensationInformation,
    employmentQuestion: settings.employmentQuestion,
    screeningQuestion: settings.screeningQuestion,
    interviewDescription: settings.interviewDescription,
    confirmationPageMessage: settings.confirmationPageMessage,
    consentText: settings.consentText,
    timeZone: settings.timeZone,
    durationMinutes: settings.durationMinutes,
  };
}

async function getPublicInterviewPage({ db }) {
  const settings = await core.getSettings(db);
  if (!settings.active || !settings.publicPageEnabled) throw new HttpsError('unavailable', 'Interview booking is temporarily unavailable.');
  return { ok: true, page: publicSettings(settings) };
}

async function getPublicInterviewAvailability({ db }) {
  const settings = await core.getSettings(db);
  if (!settings.active || !settings.publicPageEnabled) throw new HttpsError('unavailable', 'Interview booking is temporarily unavailable.');
  const result = await service.availability({ db });
  return { ...result, featuredSlots: service.selectOfferedSlots(result.slots, 3) };
}

function firstName(candidate) {
  return core.clean(candidate.firstName) || core.clean(candidate.name).split(/\s+/)[0] || 'there';
}
function values(candidate, settings, extras = {}) {
  return {
    firstName: firstName(candidate), candidateName: candidate.name || firstName(candidate),
    positionName: candidate.positionName || settings.positionName,
    bookingPageUrl: settings.bookingPageUrl, interviewRoomUrl: settings.interviewRoomUrl,
    interviewerName: candidate.assignedInterviewerName || settings.defaultInterviewerName || '',
    ...extras,
  };
}
function localHour(date, timeZone) {
  return Number(new Intl.DateTimeFormat('en-CA', { timeZone, hour:'2-digit', hourCycle:'h23' }).format(date));
}
function withinOutreachWindow(date, settings) {
  const hour = localHour(date, settings.timeZone);
  return hour >= settings.outreachStartHour && hour < settings.outreachEndHour;
}

async function startOutreach(ctx) {
  const ids = Array.isArray(ctx.data.candidateIds) ? [...new Set(ctx.data.candidateIds.map(id => core.clean(id, 200)).filter(Boolean))] : [];
  if (!ids.length) throw new HttpsError('invalid-argument', 'Select at least one candidate.');
  if (ids.length > 50) throw new HttpsError('invalid-argument', 'Send no more than 50 invitations at once.');
  const settings = await core.getSettings(ctx.db);
  core.assertValidSettings(settings);
  if (!settings.active) throw new HttpsError('failed-precondition', 'Sara outreach is paused.');
  if (!settings.publicPageEnabled) throw new HttpsError('failed-precondition', 'Enable the public interview page before sending invitations.');
  if (!withinOutreachWindow(new Date(), settings)) throw new HttpsError('failed-precondition', `Invitations may be sent only between ${settings.outreachStartHour}:00 and ${settings.outreachEndHour}:00 ${settings.timeZone}.`);
  const cooldownMs = settings.invitationCooldownHours * 3600000;
  let sent = 0;
  const errors = [], skipped = [];
  for (const candidateId of ids) {
    try {
      const ref = ctx.db.collection(core.COLLECTIONS.candidates).doc(candidateId);
      const snap = await ref.get();
      if (!snap.exists) throw new Error('Candidate not found.');
      const candidate = snap.data();
      if (!candidate.saraManaged || !candidate.outreachAllowed) throw new Error('Invitation sending is not enabled for this candidate.');
      if (candidate.status === 'opted_out' || candidate.controlMode === 'stopped') throw new Error('Candidate opted out.');
      if (candidate.bookedInterviewId || candidate.status === 'booked') { skipped.push({ candidateId, reason:'already_booked' }); continue; }
      const lastInviteMs = candidate.invitationSentAt?.toMillis?.() || 0;
      if (lastInviteMs && Date.now() - lastInviteMs < cooldownMs) { skipped.push({ candidateId, reason:'invited_recently' }); continue; }
      const body = core.render(settings.invitationMessage, values(candidate, settings));
      try {
        await service.sendCandidateSms(ctx, ref, candidate, body, { messageType:'interview_invitation' });
      } catch (error) {
        // Twilio may accept the SMS even if our tracking write fails. Mark the invite
        // as sent so an admin retry cannot send the same candidate a duplicate.
        if (!error.smsAccepted) throw error;
        await ref.set({ invitationTrackingStatus:'accepted_untracked', invitationTrackingError:core.clean(error.message, 300) }, { merge:true });
      }
      await ref.set({ status:'invited', invitationSentAt:TS(), invitationSentByUid:ctx.uid, bookingPageUrl:settings.bookingPageUrl, updatedAt:TS() }, { merge:true });
      sent++;
    } catch (error) {
      errors.push({ candidateId, error:core.clean(error.message, 300) });
    }
  }
  return { ok:errors.length === 0, sent, skipped:skipped.length, failed:errors.length, skippedCandidates:skipped, errors };
}

function safeName(value) {
  const name = core.clean(value, 160).replace(/[<>]/g, '');
  if (name.length < 2) throw new HttpsError('invalid-argument', 'Enter your full name.');
  return name;
}
function safeEmail(value) {
  const email = core.clean(value, 254).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpsError('invalid-argument', 'Enter a valid email address or leave it blank.');
  return email;
}
function rateKey(value) {
  return crypto.createHash('sha256').update(String(value || 'unknown')).digest('hex');
}
async function claimCounter(db, id, maximum) {
  const hourKey = Math.floor(Date.now() / 3600000);
  const ref = db.collection(core.COLLECTIONS.rateLimits).doc(`${hourKey}_${id}`);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const count = Number(snap.data()?.count || 0);
    if (count >= maximum) throw new HttpsError('resource-exhausted', 'Too many booking attempts. Please wait and try again.');
    tx.set(ref, { count:count + 1, hourKey, expiresAtMs:(hourKey + 2) * 3600000, updatedAt:TS(), ...(snap.exists ? {} : { createdAt:TS() }) }, { merge:true });
  });
}
async function claimRateLimit(db, phone, ip, maximum) {
  await claimCounter(db, `phone_${rateKey(phone)}`, maximum);
  if (core.clean(ip, 200)) await claimCounter(db, `ip_${rateKey(ip)}`, Math.min(50, maximum * 5));
}
async function findOrCreateCandidate(db, input, settings) {
  const match = await db.collection(core.COLLECTIONS.candidates).where('phoneE164', '==', input.phoneE164).limit(1).get();
  if (!match.empty) {
    const doc = match.docs[0];
    if (doc.data().status === 'opted_out' || doc.data().controlMode === 'stopped') throw new HttpsError('failed-precondition', 'This phone number previously opted out. Please contact our team for help.');
    return doc;
  }
  const id = `public_${crypto.createHash('sha256').update(input.phoneE164).digest('hex').slice(0, 32)}`;
  const ref = db.collection(core.COLLECTIONS.candidates).doc(id);
  await ref.set({
    name:input.name, firstName:input.name.split(/\s+/)[0], email:input.email, phoneE164:input.phoneE164,
    positionName:settings.positionName, employmentPreference:input.employmentPreference,
    screeningAnswer:input.screeningAnswer, smsConsentAccepted:true, smsConsentAt:TS(),
    saraManaged:true, outreachAllowed:true, status:'booking', source:'publicInterview',
    assignedInterviewerUid:settings.defaultInterviewerUid, assignedInterviewerName:settings.defaultInterviewerName,
    assignedInterviewerEmail:settings.defaultInterviewerEmail, createdAt:TS(), updatedAt:TS(),
  }, { merge:true });
  return ref.get();
}

async function resolveInterviewer(db, preferredUid, settings) {
  const uids = [...new Set([core.clean(preferredUid, 200), core.clean(settings.defaultInterviewerUid, 200)].filter(Boolean))];
  for (const uid of uids) {
    const snap = await db.collection('users').doc(uid).get();
    if (snap.exists && snap.data()?.active !== false && snap.data()?.userType === 'rep') return snap;
  }
  throw new HttpsError('failed-precondition', 'The interview calendar is temporarily unavailable.');
}

async function bookPublicInterview(ctx) {
  const data = ctx.data || {};
  if (core.clean(data.website, 100)) throw new HttpsError('failed-precondition', 'Unable to process this booking.');
  if (data.consentAccepted !== true) throw new HttpsError('invalid-argument', 'SMS consent is required to book and receive interview details.');
  const settings = await core.getSettings(ctx.db);
  if (!settings.active || !settings.publicPageEnabled) throw new HttpsError('unavailable', 'Interview booking is temporarily unavailable.');
  const input = {
    name:safeName(data.name), phoneE164:core.normalizePhone(data.phone), email:safeEmail(data.email),
    employmentPreference:core.clean(data.employmentPreference, 40), screeningAnswer:core.clean(data.screeningAnswer, 1200),
  };
  if (input.employmentPreference && !['full_time','part_time','either'].includes(input.employmentPreference)) throw new HttpsError('invalid-argument', 'Choose full-time, part-time or either.');
  const slotId = core.clean(data.slotId, 200);
  if (!slotId) throw new HttpsError('invalid-argument', 'Choose an interview time.');
  await claimRateLimit(ctx.db, input.phoneE164, ctx.ip, Math.max(1, settings.maximumPublicBookingsPerHour));
  const available = await service.availability({ db:ctx.db });
  const selected = available.slots.find(slot => slot.slotId === slotId);
  if (!selected) throw new HttpsError('failed-precondition', 'That interview time is no longer available. Please choose another time.');
  const candidateDoc = await findOrCreateCandidate(ctx.db, input, settings);
  const candidateRef = candidateDoc.ref;
  const candidate = candidateDoc.data();
  if (candidate.bookedInterviewId) {
    const existing = await ctx.db.collection(core.COLLECTIONS.interviews).doc(candidate.bookedInterviewId).get();
    if (existing.exists && existing.data().status === 'booked') return { ok:true, alreadyBooked:true };
  }
  const interviewer = await resolveInterviewer(ctx.db, candidate.assignedInterviewerUid, settings);
  const interviewerUid = interviewer.id;
  const interviewerData = interviewer.data();
  const interviewerName = core.clean(interviewerData.fullName || interviewerData.displayName || `${interviewerData.firstName || ''} ${interviewerData.lastName || ''}`);
  const interviewRef = ctx.db.collection(core.COLLECTIONS.interviews).doc();
  const slotRef = ctx.db.collection(core.COLLECTIONS.slots).doc(slotId);
  await ctx.db.runTransaction(async tx => {
    const [freshCandidate, slot] = await Promise.all([tx.get(candidateRef), tx.get(slotRef)]);
    if (freshCandidate.data()?.bookedInterviewId) throw new HttpsError('already-exists', 'You already have an interview booking.');
    const reserved = Number(slot.data()?.reserved || 0);
    if (reserved >= settings.capacityPerSlot) throw new HttpsError('failed-precondition', 'That interview time just filled. Please choose another time.');
    tx.set(slotRef, { startAt:selected.startAt, reserved:reserved + 1, capacity:settings.capacityPerSlot, updatedAt:TS() }, { merge:true });
    tx.set(interviewRef, {
      candidateRef, candidateId:candidateRef.id, slotId, startAt:selected.startAt,
      durationMinutes:settings.durationMinutes, timeZone:settings.timeZone,
      interviewRoomUrl:settings.interviewRoomUrl, status:'booked', bookingSource:'publicInterview',
      employmentPreference:input.employmentPreference, screeningAnswer:input.screeningAnswer,
      assignedInterviewerUid:interviewerUid, assignedInterviewerName:interviewerName,
      assignedInterviewerEmail:core.clean(interviewerData.email),
      createdAt:TS(), updatedAt:TS(),
    });
    tx.set(candidateRef, {
      name:input.name, firstName:input.name.split(/\s+/)[0], email:input.email,
      employmentPreference:input.employmentPreference, screeningAnswer:input.screeningAnswer,
      smsConsentAccepted:true, smsConsentAt:TS(),
      bookedInterviewId:interviewRef.id, bookedInterviewAt:selected.startAt, status:'booked',
      assignedInterviewerUid:interviewerUid, assignedInterviewerName:interviewerName,
      assignedInterviewerEmail:core.clean(interviewerData.email), updatedAt:TS(),
    }, { merge:true });
  });
  const dateTime = new Date(selected.startAt).toLocaleString('en-CA', { timeZone:settings.timeZone, weekday:'long', month:'long', day:'numeric', hour:'numeric', minute:'2-digit' });
  let confirmationSent = false;
  try {
    await service.sendCandidateSms(ctx, candidateRef, { ...candidate, name:input.name, phoneE164:input.phoneE164 }, core.render(settings.confirmationMessage, values({ ...candidate, name:input.name }, settings, { dateTime })), { messageType:'confirmation' });
    confirmationSent = true;
    await interviewRef.set({ confirmationStatus:'sent', updatedAt:TS() }, { merge:true });
  } catch (error) {
    confirmationSent = error.smsAccepted === true;
    await interviewRef.set({ confirmationStatus:error.smsAccepted ? 'accepted_untracked' : 'failed', confirmationError:core.clean(error.message, 400), needsHuman:true, updatedAt:TS() }, { merge:true });
  }
  return { ok:true, interviewId:interviewRef.id, startAt:selected.startAt, timeZone:settings.timeZone, durationMinutes:settings.durationMinutes, interviewerName, interviewRoomUrl:settings.interviewRoomUrl, confirmationSent };
}

module.exports = { publicSettings, getPublicInterviewPage, getPublicInterviewAvailability, startOutreach, bookPublicInterview, _test:{ safeName, safeEmail, rateKey, withinOutreachWindow } };
