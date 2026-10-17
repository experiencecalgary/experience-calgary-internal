'use strict';

const admin = require('firebase-admin');
const { HttpsError } = require('firebase-functions/v2/https');
const { requireAuth, requireCommandAccess, isPlatformAdminUser } = require('../command/commandPersonUtils');

const COLLECTIONS = Object.freeze({
  settings: 'saraSettings', candidates: 'saraCandidates', messages: 'saraMessages',
  interviews: 'saraInterviews', slots: 'saraInterviewSlots', blocks: 'saraAvailabilityBlocks',
  receipts: 'saraWebhookReceipts', rateLimits: 'saraPublicRateLimits',
});
const SETTINGS_ID = 'primary';
const DEFAULTS = Object.freeze({
  active: false,
  publicPageEnabled: false,
  assistantName: 'Sara',
  positionName: 'Experience Calgary Representative',
  bookingPageUrl: 'https://app.experiencecalgary.ca/publicInterview',
  invitationMessage: 'Hi {{firstName}} — this is Experience Calgary. You recently applied for our {{positionName}} opportunity, and we would like to invite you to a short virtual interview.\n\nLearn about the opportunity and choose your interview time here:\n{{bookingPageUrl}}\n\nReply if you need help. Reply STOP to opt out.',
  helpMessage: 'For interview help, contact curator@experiencecalgary.ca or 587-897-8521. Reply STOP to opt out.',
  inboundAcknowledgementMessage: 'Thanks for your message. Our team will review it. You can view the opportunity and book an interview here: {{bookingPageUrl}}',
  confirmationMessage: 'Your {{positionName}} virtual interview is booked for {{dateTime}}. Join here: {{interviewRoomUrl}}',
  reminderMessage: 'Reminder: your {{positionName}} interview starts in {{reminderLeadTime}}. Join here: {{interviewRoomUrl}}',
  heroHeadline: 'Build connections. Represent Calgary. Create memorable experiences.',
  heroSubheadline: 'Discover the opportunity and choose a virtual interview time that works for you.',
  promoVideoUrl: '',
  companyInformation: 'Experience Calgary connects members with curated, award-winning local experiences.',
  positionDescription: '',
  responsibilities: '',
  idealCandidateDescription: '',
  compensationInformation: '',
  employmentQuestion: 'Are you looking for full-time or part-time work?',
  screeningQuestion: 'What interested you most about this opportunity?',
  interviewDescription: 'A short virtual conversation with our team to learn more about you and answer your questions.',
  confirmationPageMessage: 'You’re booked. We have sent the interview details to your phone.',
  consentText: 'I agree to receive interview-related text messages from Experience Calgary. Message and data rates may apply. Reply STOP to opt out.',
  defaultInterviewerUid: '', defaultInterviewerName: '', defaultInterviewerEmail: '',
  interviewRoomUrl: 'https://meet.google.com/jfb-fvjk-wzh',
  interviewPresentationUrl: '',
  timeZone: 'America/Edmonton', durationMinutes: 60, capacityPerSlot: 4,
  daysAhead: 14, offeredDayCount: 3, allowedWeekdays: [2, 3, 4, 5, 6],
  dailyStartHour: 11, dailyEndHour: 16, reminderMinutesBefore: 60,
  outreachStartHour: 9, outreachEndHour: 19, invitationCooldownHours: 24,
  maximumPublicBookingsPerHour: 8,
});

const clean = (value, max = 4000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
function normalizePhone(value) {
  const digits = clean(value, 30).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  throw new HttpsError('invalid-argument', 'Enter a valid mobile phone number including area code.');
}
function render(template, values) {
  return clean(template, 2000).replace(/{{\s*([A-Za-z0-9_]+)\s*}}/g, (_, key) => clean(values[key], 700));
}
function platformAdmin(userData = {}) {
  return isPlatformAdminUser(userData) || clean(userData.roleId, 100).toLowerCase() === 'platform_admin';
}
async function userContext(request, { adminOnly = false } = {}) {
  const db = admin.firestore();
  const uid = requireAuth(request);
  const access = await requireCommandAccess(db, uid);
  const isAdmin = platformAdmin(access.userData);
  if (adminOnly && !isAdmin) throw new HttpsError('permission-denied', 'Only platform administrators can manage Sara.');
  return { db, uid, userRef: access.userRef, userData: access.userData, isAdmin, data: request.data || {} };
}
const adminContext = request => userContext(request, { adminOnly: true });
const saraUserContext = request => userContext(request);
async function getSettings(db) {
  const snap = await db.collection(COLLECTIONS.settings).doc(SETTINGS_ID).get();
  return { ...DEFAULTS, ...(snap.exists ? snap.data() : {}) };
}
function sanitizeSettings(raw = {}) {
  const output = {};
  const strings = [
    'assistantName','positionName','bookingPageUrl','invitationMessage','helpMessage','inboundAcknowledgementMessage',
    'confirmationMessage','reminderMessage','heroHeadline','heroSubheadline','promoVideoUrl','companyInformation',
    'positionDescription','responsibilities','idealCandidateDescription','compensationInformation','employmentQuestion',
    'screeningQuestion','interviewDescription','confirmationPageMessage','consentText','defaultInterviewerUid',
    'defaultInterviewerName','defaultInterviewerEmail','interviewRoomUrl','interviewPresentationUrl','timeZone',
  ];
  for (const key of strings) if (Object.hasOwn(raw, key)) output[key] = clean(raw[key]);
  for (const key of ['active','publicPageEnabled']) if (Object.hasOwn(raw, key)) output[key] = raw[key] === true;
  for (const key of ['durationMinutes','capacityPerSlot','daysAhead','offeredDayCount','dailyStartHour','dailyEndHour','reminderMinutesBefore','outreachStartHour','outreachEndHour','invitationCooldownHours','maximumPublicBookingsPerHour']) {
    if (Object.hasOwn(raw, key)) output[key] = Number(raw[key]);
  }
  if (Array.isArray(raw.allowedWeekdays)) output.allowedWeekdays = raw.allowedWeekdays.map(Number).filter(v => v >= 0 && v <= 6);
  return output;
}
function assertValidSettings(settings) {
  const required = ['positionName','bookingPageUrl','invitationMessage','helpMessage','confirmationMessage','reminderMessage','heroHeadline','interviewRoomUrl','timeZone','consentText'];
  for (const key of required) if (!clean(settings[key])) throw new HttpsError('invalid-argument', `${key} cannot be blank.`);
  for (const key of ['bookingPageUrl','interviewRoomUrl']) if (!/^https:\/\//i.test(settings[key])) throw new HttpsError('invalid-argument', `${key} must be a secure HTTPS URL.`);
  if (clean(settings.promoVideoUrl) && !/^https:\/\//i.test(settings.promoVideoUrl)) throw new HttpsError('invalid-argument', 'promoVideoUrl must be a secure HTTPS URL or blank.');
  if (clean(settings.interviewPresentationUrl) && !/^https:\/\//i.test(settings.interviewPresentationUrl)) throw new HttpsError('invalid-argument', 'interviewPresentationUrl must be a secure HTTPS URL or blank.');
  if (settings.publicPageEnabled && !clean(settings.defaultInterviewerUid)) throw new HttpsError('invalid-argument', 'Choose a default interviewer before enabling public booking.');
  if (!settings.invitationMessage.includes('{{bookingPageUrl}}')) throw new HttpsError('invalid-argument', 'The invitation message must include {{bookingPageUrl}}.');
  try { new Intl.DateTimeFormat('en-CA', { timeZone: settings.timeZone }).format(new Date()); } catch (_) { throw new HttpsError('invalid-argument', 'Choose a valid timezone.'); }
  for (const key of ['durationMinutes','capacityPerSlot','daysAhead','offeredDayCount','dailyStartHour','dailyEndHour','reminderMinutesBefore','outreachStartHour','outreachEndHour','invitationCooldownHours','maximumPublicBookingsPerHour']) {
    if (!Number.isInteger(settings[key])) throw new HttpsError('invalid-argument', `${key} must be a whole number.`);
  }
  if (settings.durationMinutes < 15 || settings.durationMinutes > 240) throw new HttpsError('invalid-argument', 'Interview duration must be 15–240 minutes.');
  if (settings.capacityPerSlot < 1 || settings.capacityPerSlot > 20) throw new HttpsError('invalid-argument', 'Slot capacity must be 1–20.');
  if (settings.daysAhead < 1 || settings.daysAhead > 90 || settings.offeredDayCount < 1 || settings.offeredDayCount > 14) throw new HttpsError('invalid-argument', 'Availability range is invalid.');
  if (settings.dailyStartHour < 0 || settings.dailyEndHour > 24 || settings.dailyStartHour >= settings.dailyEndHour) throw new HttpsError('invalid-argument', 'Daily interview hours are invalid.');
  if (settings.outreachStartHour < 0 || settings.outreachEndHour > 24 || settings.outreachStartHour >= settings.outreachEndHour) throw new HttpsError('invalid-argument', 'Outreach hours are invalid.');
  if (settings.invitationCooldownHours < 0 || settings.invitationCooldownHours > 720) throw new HttpsError('invalid-argument', 'Invitation cooldown must be 0–720 hours.');
  if (settings.reminderMinutesBefore < 15 || settings.reminderMinutesBefore > 10080) throw new HttpsError('invalid-argument', 'Reminder timing must be 15 minutes to 7 days before the interview.');
  if (settings.maximumPublicBookingsPerHour < 1 || settings.maximumPublicBookingsPerHour > 50) throw new HttpsError('invalid-argument', 'Public booking attempts per hour must be 1–50.');
  if (!Array.isArray(settings.allowedWeekdays) || !settings.allowedWeekdays.length) throw new HttpsError('invalid-argument', 'Select at least one interview weekday.');
}

module.exports = { COLLECTIONS, SETTINGS_ID, DEFAULTS, clean, normalizePhone, render, platformAdmin, userContext, adminContext, saraUserContext, getSettings, sanitizeSettings, assertValidSettings };
