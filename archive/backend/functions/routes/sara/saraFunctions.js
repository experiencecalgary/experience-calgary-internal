'use strict';

const admin = require('firebase-admin');
const { onCall, onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const core = require('../../lib/sara/saraCore');
const twilio = require('../../lib/sara/saraTwilio');
const service = require('../../lib/sara/saraService');
const publicService = require('../../lib/sara/saraPublicService');
const recruitingWorkspace = require('../../lib/sara/saraRecruitingWorkspace');

const adminOptions = { region:'us-central1', cors:true, timeoutSeconds:120, memory:'512MiB', secrets:twilio.twilioSecrets };
const publicOptions = { region:'us-central1', cors:true, timeoutSeconds:60, memory:'256MiB', secrets:twilio.twilioSecrets, enforceAppCheck:false };
const adminCallable = fn => onCall(adminOptions, async request => fn(await core.adminContext(request)));
const userCallable = fn => onCall(adminOptions, async request => fn(await core.saraUserContext(request)));
const publicCallable = fn => onCall(publicOptions, async request => fn({ db:admin.firestore(), data:request.data || {}, ip:request.rawRequest?.ip || '' }));

exports.getSaraDashboard = adminCallable(service.dashboard);
exports.saveSaraSettings = adminCallable(service.saveSettings);
exports.updateSaraCandidate = adminCallable(service.upsertCandidate);
exports.importSaraCandidates = adminCallable(service.importCandidates);
exports.startSaraOutreach = adminCallable(publicService.startOutreach);
exports.getSaraConversation = adminCallable(service.conversation);
exports.sendSaraManualReply = adminCallable(service.manualReply);
exports.setSaraConversationControl = adminCallable(service.setControl);
exports.getSaraAvailability = adminCallable(service.availability);
exports.getMySaraWorkspace = userCallable(service.repWorkspace);
exports.getMySaraConversation = userCallable(service.scopedConversation);
exports.sendMySaraManualReply = userCallable(service.scopedManualReply);
exports.setMySaraConversationControl = userCallable(service.scopedSetControl);
exports.resolveMySaraHumanHelp = userCallable(service.resolveHumanHelp);
exports.listSaraInterviews = userCallable(service.listInterviews);
exports.updateSaraInterviewOutcome = userCallable(service.updateInterviewOutcome);
exports.getRecruitingInterviewWorkspace = userCallable(recruitingWorkspace.getWorkspace);
exports.getRecruitingInterviewSession = userCallable(recruitingWorkspace.getSession);
exports.saveRecruitingInterviewDraft = userCallable(recruitingWorkspace.saveDraft);
exports.markRecruitingInterviewNoShow = userCallable(recruitingWorkspace.markNoShow);
exports.completeRecruitingInterview = userCallable(recruitingWorkspace.completeInterview);
exports.addRecruitingInterviewCandidate = userCallable(recruitingWorkspace.addCandidate);
exports.recordSaraConsent = adminCallable(service.recordConsent);
exports.saveSaraAvailabilityBlock = adminCallable(service.saveAvailabilityBlock);
exports.deleteSaraAvailabilityBlock = adminCallable(service.deleteAvailabilityBlock);
exports.listSaraAvailabilityBlocks = adminCallable(service.listAvailabilityBlocks);

exports.getPublicInterviewPage = publicCallable(publicService.getPublicInterviewPage);
exports.getPublicInterviewAvailability = publicCallable(publicService.getPublicInterviewAvailability);
exports.bookPublicInterview = publicCallable(publicService.bookPublicInterview);

exports.getSaraSystemHealth = adminCallable(async ctx => {
  const settings = await core.getSettings(ctx.db);
  return {
    ok:true, twilio:twilio.configurationStatus(),
    publicPageEnabled:settings.publicPageEnabled === true,
    bookingPageUrl:settings.bookingPageUrl,
  };
});

function isStop(text) {
  return /^\s*(?:stop|unsubscribe|cancel|end|quit|stopall|please\s+stop|remove\s+me|do\s+not\s+text\s+me|don['’]?t\s+text\s+me)[.!\s]*$/i.test(core.clean(text, 500));
}
function isHelp(text) { return /^\s*help[.!\s]*$/i.test(core.clean(text, 100)); }
async function findCandidate(db, phone) {
  const normalized = core.normalizePhone(phone);
  const snap = await db.collection(core.COLLECTIONS.candidates).where('phoneE164', '==', normalized).limit(1).get();
  return snap.empty ? null : snap.docs[0];
}
async function claimReceipt(db, sid) {
  if (!sid) return true;
  const ref = db.collection(core.COLLECTIONS.receipts).doc(sid);
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const row = snap.data() || {};
    if (row.state === 'processed') return false;
    const claimedAt = row.claimedAt?.toMillis?.() || 0;
    if (row.state === 'processing' && Date.now() - claimedAt < 5 * 60000) return false;
    tx.set(ref, { type:'inbound', state:'processing', claimedAt:admin.firestore.FieldValue.serverTimestamp(), attempts:admin.firestore.FieldValue.increment(1), ...(snap.exists ? {} : { createdAt:admin.firestore.FieldValue.serverTimestamp() }) }, { merge:true });
    return true;
  });
}

exports.receiveSaraSms = onRequest({ region:'us-central1', secrets:twilio.twilioSecrets, timeoutSeconds:30 }, async (req, res) => {
  res.type('text/xml');
  if (req.method !== 'POST' || !twilio.validateSignature(req)) return res.status(403).send('<Response/>');
  const db = admin.firestore();
  const sid = core.clean(req.body.MessageSid, 100);
  try {
    if (!(await claimReceipt(db, sid))) return res.status(200).send('<Response/>');
    const candidateDoc = await findCandidate(db, req.body.From);
    if (!candidateDoc) {
      await db.collection(core.COLLECTIONS.receipts).doc(sid || db.collection('_').doc().id).set({ type:'unmatched_inbound', state:'processed', from:core.clean(req.body.From, 40), body:core.clean(req.body.Body, 1600), processedAt:admin.firestore.FieldValue.serverTimestamp() }, { merge:true });
      return res.status(200).send('<Response/>');
    }
    const body = core.clean(req.body.Body, 1600);
    await service.saveMessage(db, candidateDoc.ref, 'inbound', body, { twilioSid:sid, deliveryStatus:'received', processedAt:admin.firestore.FieldValue.serverTimestamp() });
    const settings = await core.getSettings(db);
    if (isStop(body)) {
      const booked = candidateDoc.data().status === 'booked' || Boolean(candidateDoc.data().bookedInterviewId);
      await candidateDoc.ref.set({ status:booked ? 'booked' : 'opted_out', controlMode:'stopped', outreachAllowed:false, needsHuman:booked, humanHelpReason:booked ? 'Booked candidate opted out; review whether the interview should be cancelled.' : '', optedOutAt:admin.firestore.FieldValue.serverTimestamp(), optOutMessage:body, lastInboundAt:admin.firestore.FieldValue.serverTimestamp(), updatedAt:admin.firestore.FieldValue.serverTimestamp() }, { merge:true });
    } else if (isHelp(body)) {
      await service.sendCandidateSms({ db, inboundSid:sid }, candidateDoc.ref, candidateDoc.data(), core.render(settings.helpMessage, { bookingPageUrl:settings.bookingPageUrl, positionName:candidateDoc.data().positionName || settings.positionName }), { messageType:'help' });
    } else {
      const lastAck = candidateDoc.data().inboundAcknowledgedAt?.toMillis?.() || 0;
      await candidateDoc.ref.set({ needsHuman:true, status:candidateDoc.data().status === 'booked' ? 'booked' : 'human_help', controlMode:'human', humanHelpReason:`Candidate replied: ${body}`, lastInboundAt:admin.firestore.FieldValue.serverTimestamp(), updatedAt:admin.firestore.FieldValue.serverTimestamp() }, { merge:true });
      if (Date.now() - lastAck > 12 * 3600000) {
        await service.sendCandidateSms({ db, inboundSid:sid }, candidateDoc.ref, candidateDoc.data(), core.render(settings.inboundAcknowledgementMessage, { bookingPageUrl:settings.bookingPageUrl, positionName:candidateDoc.data().positionName || settings.positionName }), { messageType:'inbound_acknowledgement' });
        await candidateDoc.ref.set({ inboundAcknowledgedAt:admin.firestore.FieldValue.serverTimestamp() }, { merge:true });
      }
    }
    if (sid) await db.collection(core.COLLECTIONS.receipts).doc(sid).set({ state:'processed', processedAt:admin.firestore.FieldValue.serverTimestamp() }, { merge:true });
    return res.status(200).send('<Response/>');
  } catch (error) {
    console.error('receiveSaraSms failed', error);
    if (sid) await db.collection(core.COLLECTIONS.receipts).doc(sid).set({ state:error.smsAccepted ? 'processed' : 'failed', error:core.clean(error.message, 500), ...(error.smsAccepted ? { processedAt:admin.firestore.FieldValue.serverTimestamp(), trackingWarning:true } : { failedAt:admin.firestore.FieldValue.serverTimestamp() }) }, { merge:true }).catch(() => {});
    if (error.smsAccepted) return res.status(200).send('<Response/>');
    return res.status(500).send('<Response/>');
  }
});

exports.updateSaraSmsDelivery = onRequest({ region:'us-central1', secrets:twilio.twilioSecrets, timeoutSeconds:30 }, async (req, res) => {
  if (req.method !== 'POST' || !twilio.validateSignature(req)) return res.status(403).send('forbidden');
  const sid = core.clean(req.body.MessageSid, 100), status = core.clean(req.body.MessageStatus, 40), errorCode = core.clean(req.body.ErrorCode, 40);
  if (sid) {
    const snap = await admin.firestore().collection(core.COLLECTIONS.messages).where('twilioSid', '==', sid).limit(1).get();
    if (!snap.empty) {
      const message = snap.docs[0], row = message.data();
      await message.ref.set({ deliveryStatus:status, deliveryErrorCode:errorCode, deliveryUpdatedAt:admin.firestore.FieldValue.serverTimestamp() }, { merge:true });
      const candidateRef = row.candidateRef || admin.firestore().collection(core.COLLECTIONS.candidates).doc(core.clean(row.candidateId, 200));
      if (['failed','undelivered'].includes(status)) await candidateRef.set({ deliveryIssue:true, deliveryIssueStatus:status, deliveryIssueCode:errorCode, needsHuman:true, updatedAt:admin.firestore.FieldValue.serverTimestamp() }, { merge:true });
      if (errorCode === '21610') {
        const candidate = await candidateRef.get(), booked = candidate.data()?.status === 'booked' || Boolean(candidate.data()?.bookedInterviewId);
        await candidateRef.set({ status:booked ? 'booked' : 'opted_out', controlMode:'stopped', outreachAllowed:false, needsHuman:booked, humanHelpReason:booked ? 'Booked candidate opted out; review whether the interview should be cancelled.' : '', optedOutAt:admin.firestore.FieldValue.serverTimestamp() }, { merge:true });
      }
    }
  }
  return res.status(204).send('');
});

function leadTimeText(minutes) {
  const value = Number(minutes) || 60;
  if (value % 1440 === 0) return `${value / 1440} ${value === 1440 ? 'day' : 'days'}`;
  if (value % 60 === 0) return `${value / 60} ${value === 60 ? 'hour' : 'hours'}`;
  return `${value} minutes`;
}

async function claimReminder(db, interviewRef) {
  return db.runTransaction(async tx => {
    const snap = await tx.get(interviewRef);
    if (!snap.exists || snap.data().reminderSentAt) return false;
    const claimedAt = snap.data().reminderClaimedAt?.toMillis?.() || 0;
    if (snap.data().reminderStatus === 'sending' && Date.now() - claimedAt < 30 * 60000) return false;
    tx.set(interviewRef, { reminderStatus:'sending', reminderClaimedAt:admin.firestore.FieldValue.serverTimestamp(), updatedAt:admin.firestore.FieldValue.serverTimestamp() }, { merge:true });
    return true;
  });
}

exports.processSaraRemindersAndFollowUps = onSchedule({ region:'us-central1', schedule:'every 15 minutes', timeZone:'America/Edmonton', secrets:twilio.twilioSecrets, timeoutSeconds:300 }, async () => {
  const db = admin.firestore(), settings = await core.getSettings(db);
  if (!settings.active) return;
  const now = Date.now(), lead = Math.max(15, settings.reminderMinutesBefore) * 60000;
  const interviews = await db.collection(core.COLLECTIONS.interviews).where('status', '==', 'booked').where('startAt', '>=', new Date(now).toISOString()).where('startAt', '<=', new Date(now + lead).toISOString()).limit(100).get();
  for (const interview of interviews.docs) {
    const row = interview.data();
    if (row.reminderSentAt) continue;
    const candidateRef = row.candidateRef || db.collection(core.COLLECTIONS.candidates).doc(core.clean(row.candidateId, 200));
    const candidate = await candidateRef.get();
    if (!candidate.exists || candidate.data().status === 'opted_out' || candidate.data().controlMode === 'stopped') {
      await interview.ref.set({ reminderStatus:'skipped', reminderSkipReason:!candidate.exists ? 'candidate_missing' : 'candidate_opted_out', updatedAt:admin.firestore.FieldValue.serverTimestamp() }, { merge:true });
      continue;
    }
    if (!(await claimReminder(db, interview.ref))) continue;
    const dateTime = new Date(row.startAt).toLocaleString('en-CA', { timeZone:settings.timeZone, weekday:'long', month:'long', day:'numeric', hour:'numeric', minute:'2-digit' });
    try {
      await service.sendCandidateSms({ db }, candidateRef, candidate.data(), core.render(settings.reminderMessage, { firstName:candidate.data().firstName || candidate.data().name?.split(/\s+/)[0] || 'there', candidateName:candidate.data().name || '', positionName:candidate.data().positionName || settings.positionName, dateTime, reminderLeadTime:leadTimeText(settings.reminderMinutesBefore), interviewRoomUrl:settings.interviewRoomUrl }), { messageType:'reminder' });
      await interview.ref.set({ reminderSentAt:admin.firestore.FieldValue.serverTimestamp(), reminderStatus:'sent' }, { merge:true });
    } catch (error) {
      await interview.ref.set({ reminderStatus:error.smsAccepted ? 'accepted_untracked' : 'failed', ...(error.smsAccepted ? { reminderSentAt:admin.firestore.FieldValue.serverTimestamp() } : {}), reminderError:core.clean(error.message, 300), needsHuman:true, updatedAt:admin.firestore.FieldValue.serverTimestamp() }, { merge:true });
    }
  }
});

exports._test = { isStop, isHelp, leadTimeText, claimReminder };
