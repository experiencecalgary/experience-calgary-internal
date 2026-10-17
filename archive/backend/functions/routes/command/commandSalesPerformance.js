'use strict';

const admin = require('firebase-admin');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { isPlatformAdminUser } = require('../../lib/command/commandPersonUtils');
const { clean, commandActorContext, resolveAllowedRepresentatives, localDayBounds } = require('../../lib/command/commandReportingUtils');
const { buildReport } = require('../../lib/command/commandSalesPerformanceMetrics');

const DEFAULT_TIME_ZONE = 'America/Edmonton';
const refPath = value => clean(value?.path || value);
const timestampMs = value => value?.toMillis ? value.toMillis() : null;

function dateKey(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function calendarDayNumber(value, field) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpsError('invalid-argument', `${field} must use YYYY-MM-DD.`);
  const [year, month, day] = value.split('-').map(Number);
  const number = Date.UTC(year, month - 1, day);
  if (new Date(number).toISOString().slice(0, 10) !== value) throw new HttpsError('invalid-argument', `${field} must be a real calendar date.`);
  return number;
}

function dateRange(input, timeZone) {
  const today = dateKey(new Date(), timeZone);
  const defaultStart = new Date(); defaultStart.setUTCDate(defaultStart.getUTCDate() - 29);
  const startDate = clean(input.startDate) || dateKey(defaultStart, timeZone);
  const endDate = clean(input.endDate) || today;
  const startDayNumber = calendarDayNumber(startDate, 'startDate');
  const endDayNumber = calendarDayNumber(endDate, 'endDate');
  const start = localDayBounds(startDate, timeZone).start;
  const endDay = localDayBounds(endDate, timeZone);
  if (timestampMs(endDay.start) < timestampMs(start)) throw new HttpsError('invalid-argument', 'endDate must be on or after startDate.');
  const calendarDays = Math.round((endDayNumber - startDayNumber) / 86400000) + 1;
  if (calendarDays > 366) throw new HttpsError('invalid-argument', 'Reporting ranges may not exceed 366 days.');
  return { startDate, endDate, start, end: endDay.end };
}

function selectedRepUids(ctx, allowed, input) {
  const scope = clean(input.scope).toLowerCase() || 'mine';
  const platformAdmin = isPlatformAdminUser(ctx.actor.userData);
  let reps;
  if (scope === 'mine') reps = allowed.filter(rep => rep.uid === ctx.uid);
  else if (scope === 'team') reps = allowed.filter(rep => !rep.isMe);
  else if (scope === 'all' && platformAdmin) reps = allowed;
  else throw new HttpsError('permission-denied', 'That reporting scope is not available.');
  const requested = clean(input.selectedRepUid);
  if (requested) {
    const selected = reps.find(rep => rep.uid === requested);
    if (!selected) throw new HttpsError('permission-denied', 'That representative is outside the selected reporting scope.');
    reps = [selected];
  }
  return { scope, reps, repUids: new Set(reps.map(rep => rep.uid)), repIds: new Set(reps.map(rep => rep.repId).filter(Boolean)) };
}

async function fetchDocs(db, paths) {
  const unique = [...new Set(paths.filter(Boolean))];
  const result = new Map();
  for (let index = 0; index < unique.length; index += 250) {
    const refs = unique.slice(index, index + 250).map(path => db.doc(path));
    const docs = refs.length ? await db.getAll(...refs) : [];
    docs.forEach(doc => { if (doc.exists) result.set(doc.ref.path, doc.data() || {}); });
  }
  return result;
}

function leadIndustry(lead = {}, organization = {}) {
  return clean(lead.industryName || lead.industry || lead.organizationIndustry || organization.industry);
}

function meetingType(action = {}) {
  const value = clean(action.locationType || action.meetingType).toLowerCase();
  if (['virtual', 'online', 'google_meet', 'google meet'].includes(value)) return 'Virtual';
  if (['in_person', 'in person', 'onsite', 'on_site'].includes(value)) return 'In person';
  return value ? value : '';
}

function filters(input) {
  return {
    source: clean(input.source).toLowerCase(), leadListId: clean(input.leadListId),
    industry: clean(input.industry).toLowerCase(), meetingType: clean(input.meetingType).toLowerCase(),
  };
}

exports.getCommandSalesPerformance = onCall({ region: 'us-central1', timeoutSeconds: 120, memory: '512MiB' }, async request => {
  const ctx = await commandActorContext(request);
  const input = ctx.input;
  const timeZone = clean(input.timeZone) || DEFAULT_TIME_ZONE;
  const range = dateRange(input, timeZone);
  const allowed = await resolveAllowedRepresentatives(ctx, { includeAllForPlatformAdmin: true });
  const selection = selectedRepUids(ctx, allowed, input);
  const snapshot = selection.reps.length
    ? await ctx.db.collection('commandConnections').where('eventAt', '>=', range.start).where('eventAt', '<', range.end).get()
    : null;
  let events = (snapshot?.docs || []).map(doc => ({ id: doc.id, ...doc.data(), leadPath: refPath(doc.data()?.leadRef), sourcePath: refPath(doc.data()?.sourceRef || doc.data()?.actionRef), meetingPath: refPath(doc.data()?.meetingRef) }))
    .filter(event => selection.repUids.has(clean(event.repUid)) || (event.repId && selection.repIds.has(String(event.repId))));

  const leads = await fetchDocs(ctx.db, events.map(event => event.leadPath));
  const organizations = await fetchDocs(ctx.db, [...leads.values()].map(lead => refPath(lead.subjectOrganizationRef)));
  const actions = await fetchDocs(ctx.db, events.flatMap(event => [event.sourcePath, event.meetingPath]).filter(path => path.startsWith('commandActions/')));
  const typesByLead = new Map();
  events = events.map(event => {
    const lead = leads.get(event.leadPath) || {};
    const organization = organizations.get(refPath(lead.subjectOrganizationRef)) || {};
    const action = actions.get(event.meetingPath) || actions.get(event.sourcePath) || {};
    const type = meetingType(action);
    if (type) {
      const values = typesByLead.get(event.leadPath) || new Set(); values.add(type); typesByLead.set(event.leadPath, values);
    }
    return { ...event, leadSource: clean(event.leadSource) || clean(lead.source), leadListId: clean(event.leadListId) || clean(lead.leadListId), leadListName: clean(event.leadListName) || clean(lead.leadListName), industry: leadIndustry(lead, organization), mainBlocker: clean(event.mainBlocker || action.mainBlocker), meetingType: type };
  }).map(event => {
    if (event.meetingType) return event;
    const types = typesByLead.get(event.leadPath);
    return { ...event, meetingType: !types?.size ? '' : types.size > 1 ? 'Mixed' : [...types][0] };
  });

  const filter = filters(input);
  events = events.filter(event => (!filter.source || clean(event.leadSource).toLowerCase() === filter.source) &&
    (!filter.leadListId || clean(event.leadListId) === filter.leadListId) &&
    (!filter.industry || clean(event.industry).toLowerCase() === filter.industry) &&
    (!filter.meetingType || clean(event.meetingType).toLowerCase() === filter.meetingType));

  return {
    range: { startDate: range.startDate, endDate: range.endDate, timeZone },
    scope: selection.scope,
    representatives: selection.reps,
    appliedFilters: filter,
    definitions: {
      contactRate: 'Connected completed calls divided by all completed calls.',
      bestContactTimes: 'Completed-call connection rate by local weekday and hour; reliable after five attempts.',
      attemptsBeforeConnection: 'Outbound calls and emails through the first connected call or email reply per Lead.',
      callsToMeetings: 'Unique called Leads with a later booked Meeting.',
      meetingAttendance: 'Completed Meetings divided by completed Meetings plus no-shows; reschedules excluded.',
      meetingLength: 'Actual duration recorded by Start Meeting and Finish Meeting.',
      meetingsToAgreements: 'Unique Leads with an Agreement sent after a completed Meeting.',
      agreementsToWon: 'Unique Leads marked Won after an Agreement was sent.',
      followUpReliability: 'Completed Actions on or before their due time divided by completed Actions with measurable timing.',
      timeInStage: 'Time between consecutive recorded stage changes; currently open stage time is not estimated.',
    },
    generatedAt: admin.firestore.Timestamp.now(),
    ...buildReport(events, timeZone),
  };
});

exports._test = { dateRange, calendarDayNumber, selectedRepUids, leadIndustry, meetingType, filters };
