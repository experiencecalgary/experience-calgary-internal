'use strict';

const admin = require('firebase-admin');
const { HttpsError } = require('firebase-functions/v2/https');
const { requireAuth, requireCommandAccess, isPlatformAdminUser } = require('./commandPersonUtils');

const clean = value => typeof value === 'string' ? value.trim() : '';

function displayName(data = {}) {
  return clean(data.fullName) ||
    [clean(data.firstName), clean(data.lastName)].filter(Boolean).join(' ') ||
    clean(data.displayName) || clean(data.name) || clean(data.email) || 'Representative';
}

async function commandActorContext(request) {
  const db = admin.firestore();
  const uid = requireAuth(request);
  const actor = await requireCommandAccess(db, uid);
  return { db, uid, actor, input: request.data || {} };
}

async function resolveAllowedRepresentatives(ctx, options = {}) {
  const actorRepId = clean(String(ctx.actor.userData.repId ?? ''));
  const snapshot = await ctx.db.collection('users').where('userType', '==', 'rep').get();
  const platformAdmin = options.includeAllForPlatformAdmin === true &&
    isPlatformAdminUser(ctx.actor.userData);
  const allowed = snapshot.docs.filter(doc => {
    if (doc.id === ctx.uid) return true;
    const data = doc.data() || {};
    if (data.active === false) return false;
    if (platformAdmin) return true;
    if (!actorRepId) return false;
    return [data.programDirectorRepId, data.directorRepId]
      .map(value => clean(String(value ?? ''))).includes(actorRepId);
  }).map(doc => ({
    uid: doc.id,
    refPath: doc.ref.path,
    repId: clean(String(doc.data()?.repId ?? '')),
    name: displayName(doc.data()),
    isMe: doc.id === ctx.uid,
  })).sort((a, b) => Number(b.isMe) - Number(a.isMe) || a.name.localeCompare(b.name));

  if (!allowed.some(rep => rep.uid === ctx.uid)) {
    allowed.unshift({ uid: ctx.uid, refPath: ctx.actor.userRef.path, repId: actorRepId, name: displayName(ctx.actor.userData), isMe: true });
  }
  return allowed;
}

function requireAllowedRepresentative(allowed, requestedUid, fallbackUid) {
  const uid = clean(requestedUid) || fallbackUid;
  const selected = allowed.find(rep => rep.uid === uid);
  if (!selected) throw new HttpsError('permission-denied', 'You may select only yourself or an active representative on your team.');
  return selected;
}

function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}

function zonedMidnightUtc(localDate, timeZone) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean(localDate))) throw new HttpsError('invalid-argument', 'localDate must use YYYY-MM-DD.');
  try { new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date()); }
  catch (_) { throw new HttpsError('invalid-argument', 'timeZone is invalid.'); }
  const [year, month, day] = localDate.split('-').map(Number);
  const expected = Date.UTC(year, month - 1, day);
  let instant = expected;
  for (let i = 0; i < 3; i += 1) {
    const p = zonedParts(new Date(instant), timeZone);
    const represented = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    instant += expected - represented;
  }
  return new Date(instant);
}

function localDayBounds(localDate, timeZone = 'America/Edmonton') {
  const start = zonedMidnightUtc(localDate, timeZone);
  const [year, month, day] = localDate.split('-').map(Number);
  const nextKey = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
  const end = zonedMidnightUtc(nextKey, timeZone);
  return {
    start: admin.firestore.Timestamp.fromDate(start),
    end: admin.firestore.Timestamp.fromDate(end),
  };
}

module.exports = { clean, displayName, commandActorContext, resolveAllowedRepresentatives, requireAllowedRepresentative, localDayBounds, zonedParts };
