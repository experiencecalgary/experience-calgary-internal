'use strict';

const admin = require('firebase-admin');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { requireAuth, requireCommandAccess, isPlatformAdminUser } = require('../../lib/command/commandPersonUtils');
const { buildCommandAccessMetadata } = require('../../lib/command/commandAccessMetadata');
const { canAssignCommandAction } = require('../../lib/command/commandActionAssignment');
const calendarService = require('../../lib/command/commandGoogleCalendar');

const callable = (handler, usesCalendar = false) => onCall({
  region: 'us-central1',
  cors: true,
  timeoutSeconds: 120,
  memory: '512MiB',
  ...(usesCalendar ? { secrets: calendarService.calendarSecrets } : {}),
}, handler);
const clean = (value) => typeof value === 'string' ? value.trim() : '';
const displayName = (data = {}) => clean(data.fullName) || [clean(data.firstName), clean(data.lastName)].filter(Boolean).join(' ') || clean(data.displayName) || clean(data.email);
const MEETING_STATUSES = new Set(['scheduled', 'in_progress', 'completed', 'no_show', 'cancelled']);
const MEETING_OUTCOMES = new Set(['held', 'ready_for_agreement', 'follow_up_required', 'another_meeting_required', 'nurture', 'not_qualified', 'no_show']);
const MEETING_BLOCKERS = new Set(['none', 'timing', 'budget', 'decision_maker', 'interest', 'competition', 'internal_approval', 'other']);
const MEETING_TYPES = new Set(['partnership', 'sales', 'internal', 'general']);

function meetingStatus(data = {}) {
  const actionStatus = clean(data.status).toLowerCase();
  const outcome = clean(data.meetingOutcome).toLowerCase();
  if (actionStatus === 'cancelled' || outcome === 'cancelled') return 'cancelled';
  if (actionStatus === 'completed') return outcome === 'no_show' ? 'no_show' : 'completed';
  const explicit = clean(data.meetingStatus).toLowerCase();
  if (MEETING_STATUSES.has(explicit)) return explicit;
  if (data.meetingStartedAt) return 'in_progress';
  return 'scheduled';
}

function documentPath(value, collection, field, required = true) {
  const parts = clean(value).split('/').filter(Boolean);
  if ((!parts.length && !required) || (parts.length === 2 && parts[0] === collection)) return parts.join('/');
  throw new HttpsError('invalid-argument', `${field} must use ${collection}/{documentId}.`);
}

function timestamp(value, field) {
  if (value instanceof admin.firestore.Timestamp) return value;
  if (value && Number.isFinite(value.seconds)) return new admin.firestore.Timestamp(value.seconds, Number(value.nanoseconds) || 0);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new HttpsError('invalid-argument', `${field} must be a valid date and time.`);
  return admin.firestore.Timestamp.fromDate(date);
}

function dateKey(value) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Edmonton', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value.toDate());
  const map = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function visible(uid, data, actorData) {
  if (isPlatformAdminUser(actorData)) return true;
  return data.ownerUid === uid || data.assignedToUid === uid || (Array.isArray(data.viewerUids) && data.viewerUids.includes(uid));
}

function leadVisible(uid, data, actorData) {
  if (isPlatformAdminUser(actorData)) return true;
  const repId = clean(String(actorData?.repId ?? ''));
  return data.ownerUid === uid || data.assignedToUid === uid ||
    (Array.isArray(data.viewerUids) && data.viewerUids.includes(uid)) ||
    (repId && Array.isArray(data.teamRepIds) && data.teamRepIds.map(String).includes(repId));
}

async function context(request) {
  const db = admin.firestore();
  const uid = requireAuth(request);
  const actor = await requireCommandAccess(db, uid);
  return { db, uid, actor, input: request.data || {} };
}

async function readMeeting(ctx) {
  const ref = ctx.db.doc(documentPath(ctx.input.meetingRefPath || ctx.input.actionRefPath, 'commandActions', 'meetingRefPath'));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Meeting not found.');
  const data = snap.data() || {};
  if (!visible(ctx.uid, data, ctx.actor.userData)) throw new HttpsError('permission-denied', 'You do not have access to this Meeting.');
  if (clean(data.actionType).toLowerCase() !== 'meeting') throw new HttpsError('failed-precondition', 'This Action is not a Meeting.');
  return { ref, data };
}

async function readPerson(ctx, rawPath, required = true) {
  const path = documentPath(rawPath, 'commandPeople', 'personRefPath', required);
  if (!path) return null;
  const ref = ctx.db.doc(path);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Person not found.');
  const data = snap.data() || {};
  if (!visible(ctx.uid, data, ctx.actor.userData)) throw new HttpsError('permission-denied', 'You do not have access to this Person.');
  const email = clean(data.emailNormalized) || clean(data.email).toLowerCase();
  return { ref, data, email };
}

async function readLead(ctx, rawPath, personRef) {
  const path = documentPath(rawPath, 'commandLeads', 'leadRefPath', false);
  if (!path) return null;
  const ref = ctx.db.doc(path); const snap = await ref.get(); const data = snap.data() || {};
  if (!snap.exists) throw new HttpsError('not-found', 'Lead not found.');
  if (!leadVisible(ctx.uid, data, ctx.actor.userData)) throw new HttpsError('permission-denied', 'You do not have access to this Lead.');
  if (data.archived === true || clean(data.status) !== 'active') throw new HttpsError('failed-precondition', 'Meetings can be booked only for an active Lead.');
  if (personRef) {
    const connected = [data.subjectPersonRef, data.primaryContactRef, ...(data.connectedPersonRefs || [])]
      .some((candidate) => candidate?.path === personRef.path);
    if (!connected) throw new HttpsError('failed-precondition', 'The Meeting Person must be connected to the selected Lead.');
  }
  return { ref, data };
}

function meetingType(input, hasLead, hasRevival) {
  if (hasRevival) return 'partnership';
  const explicit = clean(input.meetingType).toLowerCase();
  if (explicit && !MEETING_TYPES.has(explicit)) {
    throw new HttpsError('invalid-argument', 'meetingType must be partnership, sales, internal, or general.');
  }
  return explicit || (hasLead ? 'sales' : 'general');
}

async function resolveOrganization(ctx, lead, person) {
  const leadRef = lead?.data?.subjectOrganizationRef || lead?.data?.organizationRef || null;
  const inputPath = documentPath(ctx.input.organizationRefPath, 'commandOrganizations', 'organizationRefPath', false);
  const inputRef = inputPath ? ctx.db.doc(inputPath) : null;
  const personRef = person?.data?.organizationRef || null;
  const ref = leadRef || inputRef || personRef;
  if (!ref) return null;
  if (leadRef && inputRef && leadRef.path !== inputRef.path) {
    throw new HttpsError('failed-precondition', 'The selected Organization does not match this Lead.');
  }
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Organization not found.');
  const data = snap.data() || {};
  if (!visible(ctx.uid, data, ctx.actor.userData) && !leadVisible(ctx.uid, lead?.data || {}, ctx.actor.userData)) {
    throw new HttpsError('permission-denied', 'You do not have access to this Organization.');
  }
  return { ref, data };
}

async function readRevivalLink(ctx, personRef) {
  const campaignPath = clean(ctx.input.revivalCampaignRefPath);
  const opportunityPath = clean(ctx.input.revivalOpportunityRefPath);
  if (!campaignPath && !opportunityPath) return null;
  if (ctx.actor.userData?.active === false) {
    throw new HttpsError('permission-denied', 'Inactive representatives cannot manage VIP Revival Meetings.');
  }
  if (!campaignPath || !opportunityPath) {
    throw new HttpsError('invalid-argument', 'Both revivalCampaignRefPath and revivalOpportunityRefPath are required.');
  }
  const campaignRef = ctx.db.doc(documentPath(campaignPath, 'commandRevivalCampaigns', 'revivalCampaignRefPath'));
  const opportunityRef = ctx.db.doc(documentPath(opportunityPath, 'commandRevivalOpportunities', 'revivalOpportunityRefPath'));
  const [campaignSnap, opportunitySnap] = await Promise.all([campaignRef.get(), opportunityRef.get()]);
  const campaign = campaignSnap.data() || {};
  const opportunity = opportunitySnap.data() || {};
  if (!campaignSnap.exists || !opportunitySnap.exists) throw new HttpsError('not-found', 'Revival campaign or opportunity not found.');
  if (!visible(ctx.uid, campaign, ctx.actor.userData) || !visible(ctx.uid, opportunity, ctx.actor.userData)) throw new HttpsError('permission-denied', 'You do not have access to this Revival campaign.');
  if (campaign.status !== 'active') throw new HttpsError('failed-precondition', 'The Revival campaign must be active before booking Meetings.');
  if (!['delivered', 'follow_up'].includes(opportunity.status)) throw new HttpsError('failed-precondition', 'Deliver the VIP gift before booking the Revival Meeting.');
  if (opportunity.campaignRef?.path !== campaignRef.path || opportunity.personRef?.path !== personRef.path) {
    throw new HttpsError('failed-precondition', 'The Revival opportunity does not match this campaign and Person.');
  }
  return { campaignRef, opportunityRef, campaign, opportunity };
}

async function internalAttendees(ctx, rawPaths) {
  const paths = [...new Set((Array.isArray(rawPaths) ? rawPaths : []).map((value) => documentPath(value, 'users', 'internalAttendeeRefPaths')).filter(Boolean))];
  const users = [];
  for (const path of paths) {
    const ref = ctx.db.doc(path); const snap = await ref.get(); const data = snap.data() || {};
    if (!snap.exists || data.active === false || data.userType !== 'rep') throw new HttpsError('failed-precondition', 'Every internal attendee must be an active representative.');
    if (!canAssignCommandAction({ actorUid: ctx.uid, actorData: ctx.actor.userData, assigneeUid: ref.id, assigneeData: data })) throw new HttpsError('permission-denied', 'You may invite only yourself or an active representative on your team.');
    const email = clean(data.email).toLowerCase();
    if (!email) throw new HttpsError('failed-precondition', `${displayName(data) || 'An internal attendee'} does not have an email address.`);
    users.push({ ref, data, email });
  }
  if (!users.some((user) => user.ref.id === ctx.uid)) {
    const email = clean(ctx.actor.userData?.email).toLowerCase();
    if (!email) throw new HttpsError('failed-precondition', 'Your user profile needs an email address before scheduling Meetings.');
    users.push({ ref: ctx.actor.userRef, data: ctx.actor.userData, email });
  }
  return users;
}

function schedule(input) {
  const start = timestamp(input.startAt, 'startAt');
  const end = timestamp(input.endAt, 'endAt');
  if (end.toMillis() <= start.toMillis()) throw new HttpsError('invalid-argument', 'endAt must be after startAt.');
  const timeZone = clean(input.timeZone) || 'America/Edmonton';
  const locationType = clean(input.locationType).toLowerCase();
  if (!['virtual', 'in_person'].includes(locationType)) throw new HttpsError('invalid-argument', 'locationType must be virtual or in_person.');
  const location = clean(input.location);
  if (locationType === 'in_person' && !location) throw new HttpsError('invalid-argument', 'An in-person Meeting requires a location.');
  return { start, end, timeZone, locationType, location };
}

function calendarInput(title, agenda, timing, attendees, requestId) {
  return { title, agenda, startAt: timing.start.toDate().toISOString(), endAt: timing.end.toDate().toISOString(), timeZone: timing.timeZone, locationType: timing.locationType, location: timing.location, attendees: attendees.map((email) => ({ email })), requestId };
}

function connectionData(ctx, type, target, summary, details = {}) {
  const personName = clean(target.data.personName);
  const organizationName = clean(target.data.organizationName);
  return {
    type, summary, body: clean(details.notes || details.reason), details,
    actionRef: target.ref, sourceRef: target.ref,
    ...(target.data.leadRef ? { leadRef: target.data.leadRef } : {}),
    personRef: target.data.personRef || null, personName,
    organizationRef: target.data.organizationRef || null, organizationName,
    recordType: target.data.personRef ? 'person' : (target.data.organizationRef ? 'organization' : 'general'),
    recordName: personName || organizationName || clean(target.data.title),
    ownerRef: target.data.ownerRef || ctx.actor.userRef,
    ownerUid: target.data.ownerUid || ctx.uid, ownerName: clean(target.data.ownerName),
    teamRepIds: target.data.teamRepIds || [], viewerUids: target.data.viewerUids || [ctx.uid],
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    createdByRef: ctx.actor.userRef, createdByUid: ctx.uid,
    createdByName: displayName(ctx.actor.userData) || 'Experience Command',
  };
}

function emailInsert(data) {
  const start = data.startAt.toDate().toLocaleString('en-CA', { timeZone: data.timeZone, dateStyle: 'full', timeStyle: 'short' });
  const join = data.meetingLink ? `\nJoin with Google Meet: ${data.meetingLink}` : `\nLocation: ${data.location}`;
  const plainText = `${data.title}\n${start} (${data.timeZone})${join}`;
  const target = data.meetingLink || data.calendarEventLink;
  const html = `<div><strong>${data.title}</strong><br>${start} (${data.timeZone})<br>${data.meetingLink ? `<a href="${target}">Join with Google Meet</a>` : data.location}</div>`;
  return { plainText, html };
}

// Omission preserves invitations for existing callers with a usable Person email.
// Booking without a contact still creates the internal calendar event/Meet link.
function meetingExternalEmail(person, sendExternalInvitation) {
  if (sendExternalInvitation !== undefined && typeof sendExternalInvitation !== 'boolean') {
    throw new HttpsError('invalid-argument', 'sendExternalInvitation must be a boolean.');
  }
  const email = clean(person?.email).toLowerCase();
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (sendExternalInvitation === true && !valid) {
    throw new HttpsError('failed-precondition', 'Connect a Person with a valid email to send an external invitation, or book without one.');
  }
  return sendExternalInvitation === false || !valid ? '' : email;
}

async function createCommandMeetingService(request) {
  const ctx = await context(request); const title = clean(ctx.input.title); const agenda = clean(ctx.input.agenda);
  if (!title || title.length > 200) throw new HttpsError('invalid-argument', 'A Meeting title of 200 characters or fewer is required.');
  if (agenda.length > 5000) throw new HttpsError('invalid-argument', 'The agenda must be 5,000 characters or fewer.');
  const timing = schedule(ctx.input);
  const hasRevivalInput = Boolean(clean(ctx.input.revivalCampaignRefPath) || clean(ctx.input.revivalOpportunityRefPath));
  const type = meetingType(ctx.input, Boolean(clean(ctx.input.leadRefPath)), hasRevivalInput);
  // Revival opportunities remain tied to a specific Person.
  const personRequired = hasRevivalInput;
  const person = await readPerson(ctx, ctx.input.personRefPath, personRequired);
  const lead = await readLead(ctx, ctx.input.leadRefPath, person?.ref || null);
  if ((type === 'partnership' || type === 'sales') && !lead) {
    throw new HttpsError('failed-precondition', `${type === 'partnership' ? 'Partnership' : 'Sales'} Meetings require an active Lead.`);
  }
  const externalEmail = meetingExternalEmail(person, ctx.input.sendExternalInvitation);
  const revival = hasRevivalInput ? await readRevivalLink(ctx, person.ref) : null;
  const organization = await resolveOrganization(ctx, lead, person);
  if (type === 'partnership' && !organization) {
    throw new HttpsError('failed-precondition', 'Partnership Meetings require an Organization connected to the Lead.');
  }
  const users = await internalAttendees(ctx, ctx.input.internalAttendeeRefPaths);
  const assigned = users.find((user) => user.ref.path === clean(ctx.input.assignedToRefPath)) || users.find((user) => user.ref.id === ctx.uid);
  const access = await buildCommandAccessMetadata(ctx.db, { actorRef: ctx.actor.userRef, ownerRef: ctx.actor.userRef, assignedToRef: assigned.ref });
  const organizationRef = organization?.ref || null;
  const organizationName = organization ? (clean(organization.data.organization) || clean(organization.data.name)) : '';
  const presentationType = type === 'partnership' ? (clean(ctx.input.presentationType).toLowerCase() || 'partner_reveal') : '';
  const actionRef = ctx.db.collection('commandActions').doc();
  const attendees = [...new Set([externalEmail, ...users.map((user) => user.email)].filter(Boolean))];
  let calendar;
  const warnings = [];
  try {
    calendar = await calendarService.createCalendarEvent(calendarInput(title, agenda, timing, attendees, actionRef.id));
  } catch (error) {
    throw new HttpsError('failed-precondition', `The calendar invitation could not be created: ${error.message}`);
  }
  let meetArtifacts = null;
  const requestArtifacts = timing.locationType === 'virtual' && ['sales', 'partnership'].includes(type);
  if (requestArtifacts) {
    try {
      meetArtifacts = await calendarService.configureMeetArtifacts(calendar.meetingLink, {
        transcription: true,
        smartNotes: true,
        attendance: true,
      });
    } catch (error) {
      warnings.push(`Google Meet was created, but automatic Meeting artifacts could not be enabled: ${clean(error.message) || 'Unknown Google error.'}`);
    }
  }
  const now = admin.firestore.FieldValue.serverTimestamp();
  const data = { title, description: agenda, agenda, actionType: 'meeting', meetingType: type, presentationType, priority: 'Medium', status: 'open', meetingStatus: 'scheduled', relatedType: person ? 'Person' : (organization ? 'Organization' : 'General'), personRef: person?.ref || null, personName: person ? displayName(person.data) : '', externalAttendeeEmail: externalEmail, externalInvitationEnabled: Boolean(externalEmail), organizationRef, organizationName, ...(lead ? { leadRef: lead.ref, leadSource: clean(lead.data.source), leadListId: clean(lead.data.leadListId), leadListName: clean(lead.data.leadListName), industry: clean(lead.data.industry || organization?.data?.industry) } : {}), ownerRef: access.ownerRef, ownerUid: access.ownerUid, ownerName: access.ownerName, assignedToRef: access.assignedToRef, assignedToUid: access.assignedToUid, assignedToName: access.assignedToName, internalAttendeeRefs: users.map((user) => user.ref), internalAttendeeUids: users.map((user) => user.ref.id), internalAttendeeNames: users.map((user) => displayName(user.data)), teamRepIds: access.teamRepIds, viewerUids: [...new Set([...access.viewerUids, ...users.map((user) => user.ref.id)])], startAt: timing.start, endAt: timing.end, dueAt: timing.end, dueDateKey: dateKey(timing.end), timeZone: timing.timeZone, locationType: timing.locationType, location: timing.location, meetingLink: calendar.meetingLink, calendarEventId: calendar.id, calendarEventLink: calendar.htmlLink, calendarSyncStatus: 'synced', meetingOutcome: '', transcriptionRequested: requestArtifacts, smartNotesRequested: requestArtifacts, attendanceReportRequested: requestArtifacts, transcriptionConfigurationStatus: requestArtifacts ? (meetArtifacts ? 'configured' : 'warning') : 'not_requested', smartNotesConfigurationStatus: requestArtifacts ? (meetArtifacts ? 'configured' : 'warning') : 'not_requested', attendanceConfigurationStatus: requestArtifacts ? (meetArtifacts ? 'configured' : 'warning') : 'not_requested', meetSpaceName: meetArtifacts?.meetSpaceName || '', googleMeetCode: meetArtifacts?.meetingCode || calendarService._test.meetingCode(calendar.meetingLink), transcriptStatus: requestArtifacts ? 'pending' : 'not_requested', smartNotesStatus: requestArtifacts ? 'pending' : 'not_requested', artifactSyncAttempts: 0, artifactSyncError: warnings.join(' '), ...(revival ? { revivalCampaignRef: revival.campaignRef, revivalOpportunityRef: revival.opportunityRef } : {}), createdAt: now, updatedAt: now, createdByRef: ctx.actor.userRef, updatedByRef: ctx.actor.userRef };
  const activityRef = ctx.db.collection('commandConnections').doc();
  try {
    if (revival) {
      await ctx.db.runTransaction(async (transaction) => {
        const [campaignSnap, opportunitySnap] = await Promise.all([
          transaction.get(revival.campaignRef),
          transaction.get(revival.opportunityRef),
        ]);
        const campaign = campaignSnap.data() || {};
        const opportunity = opportunitySnap.data() || {};
        if (!campaignSnap.exists || campaign.status !== 'active') {
          throw new HttpsError('failed-precondition', 'The Revival campaign is no longer active.');
        }
        if (!opportunitySnap.exists || !['delivered', 'follow_up'].includes(opportunity.status)) {
          throw new HttpsError('failed-precondition', 'This Revival opportunity is no longer available for Meeting booking.');
        }
        if (opportunity.meetingActionRef) {
          throw new HttpsError('already-exists', 'A Meeting is already booked for this Revival opportunity.');
        }
        transaction.create(actionRef, data);
        transaction.create(activityRef, connectionData(ctx, 'meeting_scheduled', { ref: actionRef, data }, `Scheduled Meeting: ${title}`, { startAt: timing.start, endAt: timing.end }));
        if (lead) transaction.update(lead.ref, { nextActionRef: actionRef, nextActionTitle: title, nextActionType: 'Meeting', nextActionAt: timing.start, updatedAt: now, updatedByRef: ctx.actor.userRef });
        transaction.update(revival.opportunityRef, { meetingActionRef: actionRef, updatedAt: now, updatedByRef: ctx.actor.userRef });
      });
    } else {
      const batch = ctx.db.batch();
      batch.create(actionRef, data);
      batch.create(activityRef, connectionData(ctx, 'meeting_scheduled', { ref: actionRef, data }, `Scheduled Meeting: ${title}`, { startAt: timing.start, endAt: timing.end }));
      if (lead) batch.update(lead.ref, { nextActionRef: actionRef, nextActionTitle: title, nextActionType: 'Meeting', nextActionAt: timing.start, updatedAt: now, updatedByRef: ctx.actor.userRef });
      await batch.commit();
    }
  } catch (error) {
    try { await calendarService.cancelCalendarEvent(calendar.id); } catch (_) { /* best-effort compensation */ }
    if (error instanceof HttpsError) throw error;
    throw new HttpsError('internal', 'The Meeting could not be saved; its calendar event was cancelled.');
  }
  return { ok: true, result: 'success', meetingRefPath: actionRef.path, meetingType: type, presentationType, meetingLink: calendar.meetingLink, calendarEventId: calendar.id, calendarEventLink: calendar.htmlLink, meetSpaceName: data.meetSpaceName, transcriptionConfigurationStatus: data.transcriptionConfigurationStatus, emailInsert: emailInsert(data), warnings };
}

// Resolve external and internal attendees independently so neither group disappears
// when the other is populated. Older meetings may not have the explicit opt-out.
async function rescheduleAttendeeEmails(data, users = []) {
  const emails = [];
  if (data.externalInvitationEnabled !== false) {
    let external = clean(data.externalAttendeeEmail);
    if (!external && data.personRef?.get) {
      const person = await data.personRef.get();
      external = meetingExternalEmail({ email: clean(person.data()?.emailNormalized) || clean(person.data()?.email) });
    }
    if (external) emails.push(external);
  }
  if (users.length) {
    emails.push(...users.map(user => user.email));
  } else {
    for (const ref of data.internalAttendeeRefs || []) {
      const snap = await ref.get();
      const email = clean(snap.data()?.email).toLowerCase();
      if (email) emails.push(email);
    }
  }
  return [...new Set(emails.filter(Boolean))];
}

async function rescheduleCommandMeetingService(request) {
  const ctx = await context(request); const target = await readMeeting(ctx);
  if (meetingStatus(target.data) !== 'scheduled') throw new HttpsError('failed-precondition', 'Only scheduled Meetings can be rescheduled.');
  const timing = schedule(ctx.input); const title = clean(ctx.input.title) || clean(target.data.title); const agenda = Object.hasOwn(ctx.input, 'agenda') ? clean(ctx.input.agenda) : clean(target.data.agenda);
  const users = Object.hasOwn(ctx.input, 'internalAttendeeRefPaths') ? await internalAttendees(ctx, ctx.input.internalAttendeeRefPaths) : [];
  const attendeeEmails = await rescheduleAttendeeEmails(target.data, users);
  const leadSnap = target.data.leadRef ? await target.data.leadRef.get() : null;
  let calendar;
  try { calendar = await calendarService.updateCalendarEvent(clean(target.data.calendarEventId), calendarInput(title, agenda, timing, [...new Set(attendeeEmails)], `${target.ref.id}-${Date.now()}`)); }
  catch (error) { throw new HttpsError('failed-precondition', `The calendar invitation could not be updated: ${error.message}`); }
  const warnings = [];
  const requestArtifacts = timing.locationType === 'virtual' && ['sales', 'partnership'].includes(clean(target.data.meetingType).toLowerCase());
  let meetArtifacts = null;
  if (requestArtifacts) {
    try {
      meetArtifacts = await calendarService.configureMeetArtifacts(calendar.meetingLink, { transcription: true, smartNotes: true, attendance: true });
    } catch (error) {
      warnings.push(`Google Calendar was updated, but automatic Meeting artifacts could not be enabled: ${clean(error.message) || 'Unknown Google error.'}`);
    }
  }
  const now = admin.firestore.FieldValue.serverTimestamp(); const updates = { title, description: agenda, agenda, meetingStatus: 'scheduled', startAt: timing.start, endAt: timing.end, dueAt: timing.end, dueDateKey: dateKey(timing.end), timeZone: timing.timeZone, locationType: timing.locationType, location: timing.location, meetingLink: calendar.meetingLink || clean(target.data.meetingLink), calendarEventLink: calendar.htmlLink || clean(target.data.calendarEventLink), calendarSyncStatus: 'synced', transcriptionRequested: requestArtifacts, smartNotesRequested: requestArtifacts, attendanceReportRequested: requestArtifacts, transcriptionConfigurationStatus: requestArtifacts ? (meetArtifacts ? 'configured' : 'warning') : 'not_requested', smartNotesConfigurationStatus: requestArtifacts ? (meetArtifacts ? 'configured' : 'warning') : 'not_requested', attendanceConfigurationStatus: requestArtifacts ? (meetArtifacts ? 'configured' : 'warning') : 'not_requested', meetSpaceName: meetArtifacts?.meetSpaceName || '', googleMeetCode: meetArtifacts?.meetingCode || calendarService._test.meetingCode(calendar.meetingLink), transcriptStatus: requestArtifacts ? 'pending' : 'not_requested', smartNotesStatus: requestArtifacts ? 'pending' : 'not_requested', artifactSyncAttempts: 0, artifactSyncError: warnings.join(' '), updatedAt: now, updatedByRef: ctx.actor.userRef };
  if (users.length) { updates.internalAttendeeRefs = users.map((user) => user.ref); updates.internalAttendeeUids = users.map((user) => user.ref.id); updates.internalAttendeeNames = users.map((user) => displayName(user.data)); updates.viewerUids = [...new Set([...(target.data.viewerUids || []), ...users.map((user) => user.ref.id)])]; }
  const batch = ctx.db.batch(); batch.update(target.ref, updates); batch.create(ctx.db.collection('commandConnections').doc(), connectionData(ctx, 'meeting_rescheduled', target, `Rescheduled Meeting: ${title}`, { oldStartAt: target.data.startAt || null, oldEndAt: target.data.endAt || null, newStartAt: timing.start, newEndAt: timing.end }));
  if (target.data.leadRef && leadSnap?.exists && leadSnap.data()?.nextActionRef?.path === target.ref.path) {
    batch.update(target.data.leadRef, { nextActionTitle: title, nextActionType: 'Meeting', nextActionAt: timing.start, updatedAt: now, updatedByRef: ctx.actor.userRef });
  }
  try {
    await batch.commit();
  } catch (error) {
    try {
      const oldTiming = { start: target.data.startAt, end: target.data.endAt, timeZone: target.data.timeZone || 'America/Edmonton', locationType: target.data.locationType || 'virtual', location: target.data.location || '' };
      await calendarService.updateCalendarEvent(clean(target.data.calendarEventId), calendarInput(clean(target.data.title), clean(target.data.agenda), oldTiming, [...new Set(attendeeEmails)], `${target.ref.id}-rollback-${Date.now()}`));
    } catch (_) { /* best-effort rollback; the caller receives a failure */ }
    throw new HttpsError('internal', 'Google was updated, but Command Center could not save the reschedule. A calendar rollback was attempted.');
  }
  return { ok: true, result: 'success', meetingRefPath: target.ref.path, meetingLink: updates.meetingLink, calendarEventLink: updates.calendarEventLink, transcriptionConfigurationStatus: updates.transcriptionConfigurationStatus, emailInsert: emailInsert({ ...target.data, ...updates }), warnings };
}

async function cancelCommandMeetingService(request) {
  const ctx = await context(request); const target = await readMeeting(ctx); const reason = clean(ctx.input.reason);
  if (!['scheduled', 'in_progress'].includes(meetingStatus(target.data))) throw new HttpsError('failed-precondition', 'Only scheduled or in-progress Meetings can be cancelled.');
  if (!reason) throw new HttpsError('invalid-argument', 'A cancellation reason is required.');
  let warning = '';
  try { await calendarService.cancelCalendarEvent(clean(target.data.calendarEventId)); }
  catch (error) { warning = `The Meeting was cancelled in Command Center, but Google could not confirm guest notification: ${error.message}`; }
  const now = admin.firestore.FieldValue.serverTimestamp(); const updates = { status: 'cancelled', meetingStatus: 'cancelled', meetingOutcome: 'cancelled', meetingOutcomeNotes: reason, outcomeSetAt: now, outcomeSetByRef: ctx.actor.userRef, outcomeSetByName: displayName(ctx.actor.userData), cancelledAt: now, cancelledByRef: ctx.actor.userRef, cancellationReason: reason, calendarSyncStatus: warning ? 'cancel_failed' : 'cancelled', calendarSyncError: warning, updatedAt: now, updatedByRef: ctx.actor.userRef };
  const activityRef = ctx.db.collection('commandConnections').doc();
  await ctx.db.runTransaction(async (transaction) => {
    const [currentSnap, opportunitySnap, leadSnap] = await Promise.all([
      transaction.get(target.ref),
      target.data.revivalOpportunityRef ? transaction.get(target.data.revivalOpportunityRef) : Promise.resolve(null),
      target.data.leadRef ? transaction.get(target.data.leadRef) : Promise.resolve(null),
    ]);
    if (!currentSnap.exists || currentSnap.data()?.status !== 'open') {
      throw new HttpsError('aborted', 'This Meeting changed. Refresh and try again.');
    }
    if (opportunitySnap && (!opportunitySnap.exists || opportunitySnap.data()?.meetingActionRef?.path !== target.ref.path)) {
      throw new HttpsError('aborted', 'This Revival opportunity changed. Refresh and try again.');
    }
    transaction.update(target.ref, updates);
    transaction.create(activityRef, connectionData(ctx, 'meeting_cancelled', target, `Cancelled Meeting: ${clean(target.data.title)}`, { reason, calendarWarning: warning }));
    if (target.data.revivalOpportunityRef) {
      transaction.update(target.data.revivalOpportunityRef, { status: 'follow_up', meetingActionRef: admin.firestore.FieldValue.delete(), meetingBookingReservationId: admin.firestore.FieldValue.delete(), meetingBookingReservedAt: admin.firestore.FieldValue.delete(), updatedAt: now, updatedByRef: ctx.actor.userRef });
    }
    if (target.data.leadRef && leadSnap?.exists && leadSnap.data()?.nextActionRef?.path === target.ref.path) {
      transaction.update(target.data.leadRef, { nextActionRef: admin.firestore.FieldValue.delete(), nextActionTitle: '', nextActionType: '', nextActionAt: admin.firestore.FieldValue.delete(), updatedAt: now, updatedByRef: ctx.actor.userRef });
    }
  });
  return { ok: true, result: 'success', meetingRefPath: target.ref.path, warnings: warning ? [warning] : [] };
}

function prepareFollowUp(ctx, target) {
  if (!ctx.input.createFollowUp) return null;
  const dueAt = timestamp(ctx.input.followUpDueAt, 'followUpDueAt'); const ref = ctx.db.collection('commandActions').doc(); const now = admin.firestore.FieldValue.serverTimestamp();
  const data = { title: clean(ctx.input.followUpTitle) || `Follow up: ${clean(target.data.title)}`, description: '', actionType: clean(ctx.input.followUpType) || 'Follow-up', priority: 'Medium', status: 'open', dueAt, dueDateKey: dateKey(dueAt), relatedType: 'Person', personRef: target.data.personRef || null, personName: target.data.personName || '', organizationRef: target.data.organizationRef || null, organizationName: target.data.organizationName || '', ...(target.data.leadRef ? { leadRef: target.data.leadRef } : {}), ownerRef: target.data.ownerRef, ownerUid: target.data.ownerUid, ownerName: target.data.ownerName || '', assignedToRef: target.data.assignedToRef, assignedToUid: target.data.assignedToUid, assignedToName: target.data.assignedToName || '', teamRepIds: target.data.teamRepIds || [], viewerUids: target.data.viewerUids || [], ...(target.data.revivalCampaignRef ? { revivalCampaignRef: target.data.revivalCampaignRef } : {}), ...(target.data.revivalOpportunityRef ? { revivalOpportunityRef: target.data.revivalOpportunityRef } : {}), createdAt: now, updatedAt: now, createdByRef: ctx.actor.userRef, updatedByRef: ctx.actor.userRef, sourceActionRef: target.ref };
  return { ref, data };
}

async function recordCommandMeetingOutcomeService(request) {
  const ctx = await context(request); const target = await readMeeting(ctx); const outcome = clean(ctx.input.outcome).toLowerCase(); const notes = clean(ctx.input.notes);
  const mainBlocker = clean(ctx.input.mainBlocker).toLowerCase() || 'none'; const blockerNotes = clean(ctx.input.blockerNotes);
  const currentMeetingStatus = meetingStatus(target.data);
  if (['completed', 'no_show'].includes(currentMeetingStatus)) return { ok: true, result: 'success', duplicate: true, meetingRefPath: target.ref.path, meetingStatus: currentMeetingStatus, outcome: clean(target.data.meetingOutcome), mainBlocker: clean(target.data.mainBlocker) || 'none', followUpRefPath: '', actualStartAt: target.data.meetingStartedAt?.toDate?.().toISOString() || null, actualFinishAt: target.data.meetingFinishedAt?.toDate?.().toISOString() || null, durationSeconds: Number.isFinite(target.data.meetingDurationSeconds) ? target.data.meetingDurationSeconds : null };
  if (!MEETING_OUTCOMES.has(outcome)) throw new HttpsError('invalid-argument', `outcome must be one of: ${[...MEETING_OUTCOMES].join(', ')}.`);
  if (!MEETING_BLOCKERS.has(mainBlocker)) throw new HttpsError('invalid-argument', `mainBlocker must be one of: ${[...MEETING_BLOCKERS].join(', ')}.`);
  if (notes.length > 5000 || blockerNotes.length > 2000) throw new HttpsError('invalid-argument', 'Meeting notes must be 5,000 characters or fewer and blocker notes 2,000 characters or fewer.');
  const legacyHeldWithoutStart = outcome === 'held' && currentMeetingStatus === 'scheduled';
  if (outcome === 'no_show' ? currentMeetingStatus !== 'scheduled' : currentMeetingStatus !== 'in_progress' && !legacyHeldWithoutStart) throw new HttpsError('failed-precondition', outcome === 'no_show' ? 'Only a scheduled Meeting can be marked no-show.' : 'Start the Meeting before finishing it.');
  if (!notes) throw new HttpsError('invalid-argument', 'Meeting outcome notes are required.');
  const followUp = prepareFollowUp(ctx, target); const followUpRefPath = followUp?.ref.path || ''; const finishedAt = admin.firestore.Timestamp.now(); const now = finishedAt; const qualifiedMeeting = outcome !== 'no_show' && ctx.input.qualifiedMeeting === true; const startedAt = target.data.meetingStartedAt; const durationSeconds = startedAt?.toMillis ? Math.max(0, Math.round((finishedAt.toMillis() - startedAt.toMillis()) / 1000)) : null; const artifactPending = target.data.transcriptionRequested === true && outcome !== 'no_show'; const updates = { status: 'completed', meetingStatus: outcome === 'no_show' ? 'no_show' : 'completed', meetingOutcome: outcome, meetingOutcomeNotes: notes, mainBlocker, blockerNotes, outcomeSetAt: now, outcomeSetByRef: ctx.actor.userRef, outcomeSetByName: displayName(ctx.actor.userData), completedAt: now, meetingFinishedAt: finishedAt, ...(durationSeconds !== null ? { meetingDurationSeconds: durationSeconds } : {}), ...(artifactPending ? { artifactSyncStatus: 'pending', artifactSyncNextAttemptAt: now } : {}), completedByRef: ctx.actor.userRef, updatedAt: now, updatedByRef: ctx.actor.userRef };
  if (target.data.revivalOpportunityRef) updates.qualifiedMeeting = qualifiedMeeting;
  const activityRef = ctx.db.collection('commandConnections').doc();
  await ctx.db.runTransaction(async (transaction) => {
    const [currentSnap, opportunitySnap, leadSnap] = await Promise.all([
      transaction.get(target.ref),
      target.data.revivalOpportunityRef ? transaction.get(target.data.revivalOpportunityRef) : Promise.resolve(null),
      target.data.leadRef ? transaction.get(target.data.leadRef) : Promise.resolve(null),
    ]);
    const currentStatus = currentSnap.exists ? meetingStatus(currentSnap.data()) : '';
    const legacyCurrent = outcome === 'held' && currentStatus === 'scheduled';
    if (!currentSnap.exists || (outcome === 'no_show' ? currentStatus !== 'scheduled' : currentStatus !== 'in_progress' && !legacyCurrent)) {
      throw new HttpsError('aborted', 'This Meeting changed. Refresh and try again.');
    }
    if (opportunitySnap && (!opportunitySnap.exists || opportunitySnap.data()?.meetingActionRef?.path !== target.ref.path)) {
      throw new HttpsError('aborted', 'This Revival opportunity changed. Refresh and try again.');
    }
    transaction.update(target.ref, updates);
    if (followUp) transaction.create(followUp.ref, followUp.data);
    const eventType = outcome === 'no_show' ? 'meeting_no_show' : (outcome === 'held' ? 'meeting_held' : 'meeting_finished');
    transaction.create(activityRef, connectionData(ctx, eventType, target, `${outcome === 'no_show' ? 'No-show' : 'Finished'} Meeting: ${clean(target.data.title)}`, { outcome, mainBlocker, blockerNotes, notes, followUpRefPath, qualifiedMeeting, startedAt: startedAt || null, finishedAt, durationSeconds }));
    if (target.data.revivalOpportunityRef) {
      transaction.update(target.data.revivalOpportunityRef, { ...(outcome === 'no_show' ? { status: 'follow_up' } : {}), meetingActionRef: admin.firestore.FieldValue.delete(), meetingBookingReservationId: admin.firestore.FieldValue.delete(), meetingBookingReservedAt: admin.firestore.FieldValue.delete(), updatedAt: now, updatedByRef: ctx.actor.userRef });
    }
    if (target.data.leadRef && leadSnap?.exists) {
      if (followUp) transaction.update(target.data.leadRef, { nextActionRef: followUp.ref, nextActionTitle: followUp.data.title, nextActionType: followUp.data.actionType, nextActionAt: followUp.data.dueAt, updatedAt: now, updatedByRef: ctx.actor.userRef });
      else if (leadSnap.data()?.nextActionRef?.path === target.ref.path) transaction.update(target.data.leadRef, { nextActionRef: admin.firestore.FieldValue.delete(), nextActionTitle: '', nextActionType: '', nextActionAt: admin.firestore.FieldValue.delete(), updatedAt: now, updatedByRef: ctx.actor.userRef });
    }
  });
  return { ok: true, result: 'success', meetingRefPath: target.ref.path, meetingStatus: updates.meetingStatus, outcome, mainBlocker, followUpRefPath, actualStartAt: startedAt?.toDate?.().toISOString() || null, actualFinishAt: finishedAt.toDate().toISOString(), durationSeconds };
}

exports.createCommandMeetingService = createCommandMeetingService;
exports.rescheduleCommandMeetingService = rescheduleCommandMeetingService;
exports.cancelCommandMeetingService = cancelCommandMeetingService;
exports.recordCommandMeetingOutcomeService = recordCommandMeetingOutcomeService;
exports.meetingStatus = meetingStatus;
exports.meetingType = meetingType;
exports.createCommandMeeting = callable(createCommandMeetingService, true);
exports.rescheduleCommandMeeting = callable(rescheduleCommandMeetingService, true);
exports.cancelCommandMeeting = callable(cancelCommandMeetingService, true);
exports.recordCommandMeetingOutcome = callable(recordCommandMeetingOutcomeService);
// Clear UI-facing name for the Start → Finish Meeting workflow.
exports.finishCommandMeeting = callable(recordCommandMeetingOutcomeService);


exports.meetingExternalEmail = meetingExternalEmail;

exports.rescheduleAttendeeEmails = rescheduleAttendeeEmails;
