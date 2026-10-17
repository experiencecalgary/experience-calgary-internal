'use strict';

// Time-dependent classification is evaluated at read time, not frozen by a trigger.
// No contact information or action titles are copied into this projection.
const VERSION = 1;
const ms = value => value?.toMillis?.() ?? null;
const clean = value => typeof value === 'string' ? value.trim() : '';
function projectWork(docs) {
  if (docs.length > 200) return { version: VERSION, complete: false, entries: [] };
  const entries = docs.filter(doc => {
    const d = doc.data();
    return d.status === 'open' && d.archived !== true &&
      !['completed', 'cancelled', 'no_show'].includes(clean(d.meetingStatus).toLowerCase());
  }).map(doc => {
    const d = doc.data(), meeting = clean(d.actionType).toLowerCase() === 'meeting';
    return { path: doc.ref.path, kind: meeting ? 'meeting' : 'action',
      at: ms(meeting ? d.startAt || d.dueAt : d.dueAt),
      end: meeting ? ms(d.endAt || d.startAt || d.dueAt) : null,
      inProgress: meeting && (d.meetingStatus === 'in_progress' || Boolean(d.meetingStartedAt)),
      hasOutcome: meeting && Boolean(clean(d.meetingOutcome)) };
  });
  return { version: VERSION, complete: true, entries };
}
function classify(entry, now) {
  if (entry.kind === 'meeting') {
    if (entry.inProgress) return 'in_progress';
    if (!entry.hasOutcome && entry.end !== null && entry.end < now) return 'missing_outcome';
    return 'upcoming_meeting';
  }
  return entry.at === null ? 'unscheduled' : entry.at < now ? 'overdue' : 'scheduled';
}
const ORDER = { in_progress: 0, missing_outcome: 1, overdue: 2, upcoming_meeting: 3, scheduled: 3, unscheduled: 4 };
function state(projection, now = Date.now()) {
  if (projection?.version !== VERSION || projection.complete !== true || !Array.isArray(projection.entries))
    return { complete: false, noAction: false, overdue: false, next: null, rank: 5, sortAt: Number.MAX_SAFE_INTEGER };
  const entries = projection.entries.map(e => ({ ...e, state: classify(e, now) }));
  entries.sort((a, b) => ORDER[a.state] - ORDER[b.state] ||
    (a.at ?? Number.MAX_SAFE_INTEGER) - (b.at ?? Number.MAX_SAFE_INTEGER) || a.path.localeCompare(b.path));
  const next = entries[0] || null;
  const overdue = entries.filter(e => e.state === 'overdue');
  const future = entries.filter(e => e.at !== null && e.at >= now).sort((a, b) => a.at - b.at || a.path.localeCompare(b.path));
  const inProgress = entries.some(e => e.state === 'in_progress');
  const missing = entries.filter(e => e.state === 'missing_outcome');
  return { complete: true, noAction: entries.length === 0, overdue: overdue.length > 0,
    overdueActionCount: overdue.length, openWorkCount: entries.length, missingOutcomeCount: missing.length,
    inProgress, hasFutureCommitment: future.length > 0, nextFutureAt: future[0]?.at ?? null, next,
    rank: inProgress || missing.length ? 0 : overdue.length ? 1 : !entries.length ? 2 : 3,
    sortAt: next?.at ?? Number.MAX_SAFE_INTEGER };
}
module.exports = { VERSION, projectWork, state, classify };
