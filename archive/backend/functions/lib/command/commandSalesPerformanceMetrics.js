'use strict';

const clean = value => typeof value === 'string' ? value.trim() : '';
const ms = value => {
  if (!value) return null;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (Number.isFinite(value.seconds)) return value.seconds * 1000;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
};
const round = (value, places = 1) => Number(Number(value || 0).toFixed(places));
const ratio = (numerator, denominator) => denominator ? round(numerator * 100 / denominator) : null;
const median = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const leadKey = event => clean(event.leadPath || event.leadRef?.path || event.leadRef);
const eventTime = event => ms(event.eventAt);
const callConnected = event => event.eventType === 'call_finished' &&
  ['connected', 'answered', 'booked'].includes(clean(event.outcome).toLowerCase());
const meaningful = event => callConnected(event) || event.eventType === 'email_received';
const attempt = event => ['call_finished', 'email_sent'].includes(event.eventType);

function sequenceConversion(events, fromType, toType) {
  const leads = new Map();
  for (const event of events) {
    const key = leadKey(event); const time = eventTime(event);
    if (!key || time === null) continue;
    const row = leads.get(key) || { from: [], to: [] };
    if (event.eventType === fromType) row.from.push(time);
    if (event.eventType === toType) row.to.push(time);
    leads.set(key, row);
  }
  let started = 0; let converted = 0;
  for (const row of leads.values()) {
    if (!row.from.length) continue;
    started += 1;
    if (row.to.some(to => row.from.some(from => to >= from))) converted += 1;
  }
  return { started, converted, rate: ratio(converted, started) };
}

function contactTiming(events, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', hour: '2-digit', hourCycle: 'h23',
  });
  const slots = new Map();
  for (const event of events.filter(e => e.eventType === 'call_finished')) {
    const time = eventTime(event); if (time === null) continue;
    const parts = Object.fromEntries(formatter.formatToParts(new Date(time))
      .filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    const key = `${parts.weekday} ${parts.hour}:00`;
    const row = slots.get(key) || { label: key, attempts: 0, connections: 0 };
    row.attempts += 1; if (callConnected(event)) row.connections += 1;
    slots.set(key, row);
  }
  return [...slots.values()].map(row => ({ ...row, rate: ratio(row.connections, row.attempts), reliable: row.attempts >= 5 }))
    .sort((a, b) => (b.rate || 0) - (a.rate || 0) || b.attempts - a.attempts).slice(0, 12);
}

function attemptsBeforeConnection(events) {
  const byLead = new Map();
  for (const event of events.filter(e => attempt(e) || meaningful(e))) {
    const key = leadKey(event); if (!key) continue;
    const list = byLead.get(key) || []; list.push(event); byLead.set(key, list);
  }
  const counts = [];
  for (const list of byLead.values()) {
    list.sort((a, b) => (eventTime(a) || 0) - (eventTime(b) || 0));
    let attempts = 0;
    for (const event of list) {
      if (attempt(event)) attempts += 1;
      // An inbound reply can belong to outreach before the selected reporting
      // window. Do not call that "zero attempts" and skew the period average.
      if (meaningful(event) && attempts > 0) { counts.push(attempts); break; }
    }
  }
  return { connectedLeads: counts.length, average: counts.length ? round(counts.reduce((a, b) => a + b, 0) / counts.length) : null, median: median(counts) };
}

function countsBy(events, field, fallback = 'Unknown') {
  const counts = new Map();
  for (const event of events) {
    const key = clean(event[field]) || fallback;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function stageTiming(events) {
  const byLead = new Map();
  for (const event of events.filter(e => e.eventType === 'stage_changed')) {
    const key = leadKey(event); if (!key || eventTime(event) === null) continue;
    const list = byLead.get(key) || []; list.push(event); byLead.set(key, list);
  }
  const stages = new Map();
  for (const list of byLead.values()) {
    list.sort((a, b) => eventTime(a) - eventTime(b));
    for (let i = 1; i < list.length; i += 1) {
      const stage = clean(list[i - 1].nextStage); if (!stage) continue;
      const hours = (eventTime(list[i]) - eventTime(list[i - 1])) / 3600000;
      if (hours < 0) continue;
      const values = stages.get(stage) || []; values.push(hours); stages.set(stage, values);
    }
  }
  return [...stages].map(([stage, values]) => ({ stage, transitions: values.length, averageHours: round(values.reduce((a, b) => a + b, 0) / values.length), medianHours: round(median(values)) }))
    .sort((a, b) => b.averageHours - a.averageHours);
}

function coreMetrics(events, timeZone) {
  const attempts = events.filter(e => e.eventType === 'call_finished');
  const connections = events.filter(callConnected);
  const finishedMeetings = events.filter(e => e.eventType === 'meeting_finished');
  const noShows = events.filter(e => e.eventType === 'meeting_no_show');
  const durations = finishedMeetings.map(e => Number(e.durationSeconds)).filter(value => Number.isFinite(value) && value >= 0);
  const completedActions = events.filter(e => e.eventType === 'action_completed' && typeof e.completedOnTime === 'boolean');
  const onTime = completedActions.filter(e => e.completedOnTime).length;
  return {
    contactRate: { attempts: attempts.length, meaningfulConnections: connections.length, rate: ratio(connections.length, attempts.length) },
    bestContactTimes: contactTiming(events, timeZone),
    attemptsBeforeConnection: attemptsBeforeConnection(events),
    callsToMeetings: sequenceConversion(events, 'call_finished', 'meeting_booked'),
    meetingAttendance: { completed: finishedMeetings.length, noShows: noShows.length, rate: ratio(finishedMeetings.length, finishedMeetings.length + noShows.length) },
    meetingLength: { measured: durations.length, averageMinutes: durations.length ? round(durations.reduce((a, b) => a + b, 0) / durations.length / 60) : null, medianMinutes: durations.length ? round(median(durations) / 60) : null },
    meetingOutcomes: countsBy(finishedMeetings, 'outcome'),
    meetingBlockers: countsBy(finishedMeetings.filter(e => clean(e.mainBlocker)), 'mainBlocker'),
    meetingsToAgreements: sequenceConversion(events, 'meeting_finished', 'agreement_sent'),
    agreementsToWon: sequenceConversion(events, 'agreement_sent', 'lead_won'),
    followUpReliability: { measurable: completedActions.length, onTime, late: completedActions.length - onTime, rate: ratio(onTime, completedActions.length) },
    timeInStage: stageTiming(events),
    lostReasons: countsBy(events.filter(e => e.eventType === 'lead_lost'), 'lostReason'),
  };
}

function groupSummary(events) {
  const calls = events.filter(e => e.eventType === 'call_finished');
  const connectedCalls = calls.filter(callConnected);
  const meetings = events.filter(e => e.eventType === 'meeting_finished');
  const agreements = events.filter(e => e.eventType === 'agreement_sent');
  const wins = events.filter(e => e.eventType === 'lead_won');
  return {
    leads: new Set(events.map(leadKey).filter(Boolean)).size,
    calls: calls.length,
    contactRate: ratio(connectedCalls.length, calls.length),
    meetings: meetings.length,
    agreements: agreements.length,
    wins: wins.length,
  };
}

function breakdown(events, field, timeZone) {
  const groups = new Map();
  for (const event of events) {
    const key = clean(event[field]) || 'Unknown';
    const list = groups.get(key) || []; list.push(event); groups.set(key, list);
  }
  return [...groups].map(([name, list]) => ({ name, events: list.length, ...groupSummary(list) }))
    .sort((a, b) => b.events - a.events || a.name.localeCompare(b.name)).slice(0, 100);
}

function buildReport(events, timeZone = 'America/Edmonton') {
  const linked = events.filter(event => event.performanceVersion === 1 && event.performanceLinkStatus === 'linked' && leadKey(event));
  return {
    totals: { events: linked.length, leads: new Set(linked.map(leadKey)).size },
    metrics: coreMetrics(linked, timeZone),
    breakdowns: {
      reps: breakdown(linked, 'repName', timeZone),
      sources: breakdown(linked, 'leadSource', timeZone),
      leadLists: breakdown(linked, 'leadListName', timeZone),
      industries: breakdown(linked, 'industry', timeZone),
      meetingTypes: breakdown(linked, 'meetingType', timeZone),
    },
    coverage: {
      linkedEvents: linked.length,
      industryKnown: linked.filter(e => clean(e.industry)).length,
      meetingTypeKnown: linked.filter(e => clean(e.meetingType)).length,
      durationMeasured: linked.filter(e => e.eventType === 'meeting_finished' && Number.isFinite(Number(e.durationSeconds))).length,
      meetingOutcomeKnown: linked.filter(e => e.eventType === 'meeting_finished' && clean(e.outcome)).length,
      meetingBlockerKnown: linked.filter(e => e.eventType === 'meeting_finished' && clean(e.mainBlocker)).length,
      followUpTimingMeasured: linked.filter(e => e.eventType === 'action_completed' && typeof e.completedOnTime === 'boolean').length,
    },
  };
}

module.exports = { buildReport, _test: { ratio, median, sequenceConversion, contactTiming, attemptsBeforeConnection, stageTiming } };
