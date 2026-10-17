'use strict';

const crypto = require('crypto');
const admin = require('firebase-admin');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const notificationCore = require('../../lib/notificationCore');
const { isPlatformAdminUser } = require('../../lib/command/commandPersonUtils');

const REGION = 'us-central1';
const DEFAULT_PREFS = Object.freeze({ actions: true, meetings: true, flow: true, exmail: true, connections: true, announcements: true });
const CATEGORY_TYPES = Object.freeze({
  actions: new Set(['action_assigned', 'action_changed', 'action_reassigned', 'action_due_soon', 'action_overdue']),
  meetings: new Set(['meeting_created', 'meeting_changed', 'meeting_reminder', 'meeting_outcome_required', 'meeting_rescheduled', 'meeting_cancelled']),
  flow: new Set(['stale_lead', 'closing_without_action', 'daily_command_summary']),
  exmail: new Set(['email_in']),
  connections: new Set(['connections_message']),
  announcements: new Set(['admin_announcement', 'notification_test', 'promotion_approved', 'promotion_declined', 'weekly_plan_reminder']),
});
const PLATFORM_ADMIN_GLOBAL_KINDS = new Set(['person', 'organization', 'action', 'meeting']);

const clean = value => String(value == null ? '' : value).trim();
const unique = values => [...new Set((values || []).map(clean).filter(Boolean))];
const callable = handler => onCall({ region: REGION, cors: true, timeoutSeconds: 120, memory: '512MiB' }, handler);

function requireAuth(request) {
  const uid = clean(request.auth?.uid);
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in is required.');
  return { uid, input: request.data || {}, db: admin.firestore() };
}

function categoryFor(type) {
  const normalized = clean(type).toLowerCase();
  for (const [category, types] of Object.entries(CATEGORY_TYPES)) if (types.has(normalized)) return category;
  return 'other';
}

function bool(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function serialize(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (value.path) return value.path;
  return value;
}

function normalizeRef(db, value, collection) {
  if (!value) return null;
  if (value.path) return value;
  const path = clean(value);
  const parts = path.split('/').filter(Boolean);
  if (parts.length !== 2 || parts[0] !== collection) return null;
  return db.doc(path);
}

function destinationFrom(db, data) {
  const type = clean(data.type).toLowerCase();
  const explicit = clean(data.destinationType).toLowerCase();
  const actionRef = normalizeRef(db, data.actionRef || data.meetingRef || (['command_action', 'command_meeting'].includes(explicit) ? data.destinationRef : null) || data.sourceRef, 'commandActions');
  const threadRef = normalizeRef(db, data.threadRef || data.emailThreadRef || (explicit === 'exmail' ? data.destinationRef : null), 'commandEmailThreads');
  const personRef = normalizeRef(db, data.personRef || (explicit === 'person' ? data.destinationRef : null) || (clean(data.recordType).toLowerCase() === 'person' ? data.recordRef : null), 'commandPeople');
  const organizationRef = normalizeRef(db, data.organizationRef || (explicit === 'organization' ? data.destinationRef : null) || (clean(data.recordType).toLowerCase() === 'organization' ? data.recordRef : null), 'commandOrganizations');
  const chatRef = normalizeRef(db, data.chatRef || data.destinationRef, 'chats');
  if (chatRef || type === 'connections_message') return { kind: 'connections_chat', ref: chatRef };
  if (actionRef || type.startsWith('action_') || type.startsWith('meeting_')) return { kind: type.startsWith('meeting_') ? 'meeting' : 'action', ref: actionRef };
  if (threadRef || type === 'email_in') return { kind: 'exmail', ref: threadRef };
  if (personRef) return { kind: 'person', ref: personRef };
  if (organizationRef) return { kind: 'organization', ref: organizationRef };
  if (['sales_dashboard', 'command_dashboard', 'weekly_plan', 'command_notifications'].includes(explicit)) return { kind: explicit, ref: null };
  return { kind: 'none', ref: null };
}

function flutterFlowRouteFor(destination) {
  const refPath = clean(destination.ref?.path);
  const refId = clean(destination.ref?.id);
  let initialPageName = 'CommandCenterNotifications';
  let routePath = '/commandCenterNotifications';
  let parameterName = '';
  let parameterValue = '';

  if (destination.kind === 'sales_dashboard') {
    initialPageName = 'salesTeamDashboard';
    routePath = '/salesTeamDashboard';
  } else if (destination.kind === 'command_dashboard') {
    initialPageName = 'CommandCenterDashboard';
    routePath = '/commandCenterDashboard';
  } else if (destination.kind === 'weekly_plan') {
    initialPageName = 'repMyWeeklyPlan';
    routePath = '/repMyWeeklyPlan';
  } else if (destination.kind === 'command_notifications') {
    initialPageName = 'CommandCenterNotifications';
    routePath = '/commandCenterNotifications';
  }

  if (refPath) {
    switch (destination.kind) {
      case 'action':
      case 'meeting':
        initialPageName = 'CommandCenterActions';
        routePath = '/commandCenterActions';
        parameterName = 'initialActionRefPath';
        parameterValue = refPath;
        break;
      case 'person':
        initialPageName = 'CommandCenterPeopleContact';
        routePath = '/commandCenterPeopleContact';
        parameterName = 'personRef';
        parameterValue = refPath;
        break;
      case 'organization':
        initialPageName = 'commandCenterOrganizationContact';
        routePath = '/commandCenterOrganizationContact';
        parameterName = 'organizationRef';
        parameterValue = refPath;
        break;
      case 'exmail':
        initialPageName = 'CommandCenterExMailMessages';
        routePath = '/commandCenterExMailMessages';
        parameterName = 'exMailThreadRef';
        parameterValue = refPath;
        break;
      case 'connections_chat':
        initialPageName = 'connectionChat';
        routePath = '/connectionChat';
        parameterName = 'connectionsChat';
        parameterValue = refPath;
        break;
    }
  }

  const parameterData = parameterName ? { [parameterName]: parameterValue } : {};
  const webValue = parameterName === 'initialActionRefPath' ? refPath : refId;
  const webLink = parameterName && webValue
    ? `${routePath}?${encodeURIComponent(parameterName)}=${encodeURIComponent(webValue)}`
    : routePath;

  return { initialPageName, parameterData: JSON.stringify(parameterData), webLink };
}

function canSee(uid, data, platformAdmin = false) {
  if (platformAdmin) return true;
  if (clean(data.uid) === uid || clean(data.ownerUid) === uid || clean(data.assignedToUid) === uid) return true;
  return unique(data.viewerUids).includes(uid);
}

function destinationAvailableWithoutRef(kind) {
  return ['sales_dashboard', 'command_dashboard', 'weekly_plan', 'command_notifications'].includes(kind);
}

async function resolveDestination(db, uid, notification, platformAdmin = false) {
  const destination = destinationFrom(db, notification);
  if (!destination.ref) return { kind: destination.kind, refPath: '', available: destinationAvailableWithoutRef(destination.kind) };
  const snap = await destination.ref.get();
  if (!snap.exists) return { kind: destination.kind, refPath: destination.ref.path, available: false };
  const data = snap.data() || {};
  const available = destination.kind === 'connections_chat'
    ? unique((Array.isArray(data.participants) && data.participants.length
      ? data.participants
      : (data.participantIds || [])).map(value => value?.id || value)).includes(uid)
    : canSee(uid, data, platformAdmin && PLATFORM_ADMIN_GLOBAL_KINDS.has(destination.kind));
  return { kind: destination.kind, refPath: destination.ref.path, available, recordName: clean(data.displayName || data.name || data.title || data.subject || data.groupName) };
}

function encodeCursor(doc) {
  const ms = doc.data().createdAt?.toMillis?.();
  if (!ms) return '';
  return Buffer.from(JSON.stringify({ ms, id: doc.id })).toString('base64url');
}

function decodeCursor(token) {
  if (!clean(token)) return null;
  try {
    const value = JSON.parse(Buffer.from(clean(token), 'base64url').toString('utf8'));
    if (!Number.isFinite(value.ms) || !clean(value.id)) throw new Error('bad cursor');
    return value;
  } catch (_) {
    throw new HttpsError('invalid-argument', 'Invalid page token.');
  }
}

async function unreadCount(db, uid) {
  const modern = await db.collection('commandNotifications').where('uid', '==', uid).where('isRead', '==', false).count().get();
  const legacy = await db.collection('commandNotifications').where('uid', '==', uid).where('read', '==', false).get();
  const legacyOnly = legacy.docs.filter(doc => typeof doc.data().isRead !== 'boolean').length;
  return Number(modern.data().count || 0) + legacyOnly;
}

async function listCommandNotificationsPageService(request) {
  const { uid, input, db } = requireAuth(request);
  const userSnap = await db.collection('users').doc(uid).get();
  const platformAdmin = userSnap.exists && isPlatformAdminUser(userSnap.data() || {});
  const view = clean(input.view || 'all').toLowerCase();
  const category = clean(input.category || 'all').toLowerCase();
  if (!['all', 'unread'].includes(view)) throw new HttpsError('invalid-argument', 'view must be all or unread.');
  if (!['all', ...Object.keys(CATEGORY_TYPES)].includes(category)) throw new HttpsError('invalid-argument', 'Unknown notification category.');
  const size = Math.min(Math.max(Number(input.pageSize) || 30, 1), 50);
  const cursor = decodeCursor(input.pageToken);
  let query = db.collection('commandNotifications').where('uid', '==', uid).orderBy('createdAt', 'desc').orderBy(admin.firestore.FieldPath.documentId(), 'desc');
  if (cursor) query = query.startAfter(admin.firestore.Timestamp.fromMillis(cursor.ms), cursor.id);
  const rows = [];
  let scan = query;
  let exhausted = false;
  let lastScanned = null;
  while (rows.length <= size && !exhausted) {
    const snap = await scan.limit(Math.max(size * 3, 50)).get();
    if (snap.empty) break;
    lastScanned = snap.docs[snap.docs.length - 1];
    for (const doc of snap.docs) {
      const data = doc.data() || {};
      const isRead = bool(data.isRead, bool(data.read, false));
      if (view === 'unread' && isRead) continue;
      if (category !== 'all' && categoryFor(data.type) !== category) continue;
      rows.push({ doc, data, isRead });
      if (rows.length > size) break;
    }
    exhausted = snap.size < Math.max(size * 3, 50);
    if (rows.length <= size && !exhausted) scan = query.startAfter(lastScanned.data().createdAt, lastScanned.id);
  }
  const page = rows.slice(0, size);
  const records = await Promise.all(page.map(async ({ doc, data, isRead }) => ({
    refPath: doc.ref.path,
    type: clean(data.type), category: categoryFor(data.type), title: clean(data.title), body: clean(data.body), imageUrl: clean(data.imageUrl), pushBody: clean(data.pushBody),
    isRead, readAt: serialize(data.readAt), createdAt: serialize(data.createdAt), urgent: ['action_overdue', 'meeting_outcome_required', 'closing_without_action'].includes(clean(data.type)),
    destination: await resolveDestination(db, uid, data, platformAdmin),
  })));
  const hasMore = rows.length > size || !exhausted;
  return { ok: true, result: 'success', records, unreadTotal: await unreadCount(db, uid), hasMore, nextPageToken: hasMore && page.length ? encodeCursor(page[page.length - 1].doc) : '' };
}

async function ownedNotification(db, uid, refPath) {
  const parts = clean(refPath).split('/').filter(Boolean);
  if (parts.length !== 2 || parts[0] !== 'commandNotifications') throw new HttpsError('invalid-argument', 'Invalid notification reference.');
  const ref = db.doc(parts.join('/'));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Notification not found.');
  if (clean(snap.data()?.uid) !== uid) throw new HttpsError('permission-denied', 'You cannot update this notification.');
  return ref;
}

async function markCommandNotificationReadService(request) {
  const { uid, input, db } = requireAuth(request);
  const ref = await ownedNotification(db, uid, input.notificationRefPath);
  const isRead = bool(input.isRead, true);
  await ref.set({ isRead, read: isRead, readAt: isRead ? admin.firestore.FieldValue.serverTimestamp() : null, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  return { ok: true, result: 'success', isRead };
}

async function markAllCommandNotificationsReadService(request) {
  const { uid, input, db } = requireAuth(request);
  const category = clean(input.category || 'all').toLowerCase();
  if (!['all', ...Object.keys(CATEGORY_TYPES)].includes(category)) throw new HttpsError('invalid-argument', 'Unknown notification category.');
  let changed = 0; let last = null;
  do {
    let query = db.collection('commandNotifications').where('uid', '==', uid).orderBy(admin.firestore.FieldPath.documentId()).limit(400);
    if (last) query = query.startAfter(last);
    const snap = await query.get();
    if (snap.empty) break;
    const batch = db.batch();
    for (const doc of snap.docs) {
      const data = doc.data() || {};
      if (category !== 'all' && categoryFor(data.type) !== category) continue;
      if (bool(data.isRead, bool(data.read, false))) continue;
      batch.set(doc.ref, { isRead: true, read: true, readAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }); changed++;
    }
    await batch.commit(); last = snap.docs[snap.docs.length - 1];
    if (snap.size < 400) break;
  } while (true);
  return { ok: true, result: 'success', changed };
}

function deviceId(token) { return crypto.createHash('sha256').update(token).digest('hex'); }

async function registerCommandNotificationDeviceService(request) {
  const { uid, input, db } = requireAuth(request);
  const token = clean(input.token); const platform = clean(input.platform).toLowerCase();
  if (!token || token.length < 32) throw new HttpsError('invalid-argument', 'A valid FCM token is required.');
  if (!['web', 'android', 'ios', 'windows', 'macos'].includes(platform)) throw new HttpsError('invalid-argument', 'Unsupported notification platform.');
  const ref = db.collection('users').doc(uid).collection('commandNotificationDevices').doc(deviceId(token));
  await ref.set({ token, platform, enabled: true, userAgent: clean(input.userAgent).slice(0, 300), createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  return { ok: true, result: 'success', deviceRefPath: ref.path };
}

async function unregisterCommandNotificationDeviceService(request) {
  const { uid, input, db } = requireAuth(request); const token = clean(input.token);
  if (!token) throw new HttpsError('invalid-argument', 'FCM token is required.');
  await db.collection('users').doc(uid).collection('commandNotificationDevices').doc(deviceId(token)).delete();
  return { ok: true, result: 'success' };
}

async function updateCommandNotificationPreferencesService(request) {
  const { uid, input, db } = requireAuth(request); const source = input.preferences || input;
  const preferences = {};
  for (const key of Object.keys(DEFAULT_PREFS)) preferences[key] = bool(source[key], DEFAULT_PREFS[key]);
  preferences.pushEnabled = bool(source.pushEnabled, true);
  await db.collection('users').doc(uid).set({ commandNotificationPreferences: preferences, commandNotificationPreferencesUpdatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  return { ok: true, result: 'success', preferences };
}

async function commandNotificationPushDeliveryHandler(event) {
  const snap = event.data; if (!snap) return;
  const db = admin.firestore(); const notification = snap.data() || {}; const uid = clean(notification.uid);
  if (!uid) return;
  const category = categoryFor(notification.type); const userSnap = await db.collection('users').doc(uid).get();
  const prefs = { ...DEFAULT_PREFS, pushEnabled: true, ...(userSnap.data()?.commandNotificationPreferences || {}) };
  const destination = destinationFrom(db, notification);
  const flutterFlowRoute = flutterFlowRouteFor(destination);
  await snap.ref.set({ isRead: bool(notification.isRead, bool(notification.read, false)), read: bool(notification.isRead, bool(notification.read, false)), readAt: notification.readAt || null, category, destinationKind: destination.kind, destinationRef: destination.ref || null, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  if (notification.pushManagedExternally === true || notification.pushSuppressed === true) return;
  if (!prefs.pushEnabled || (category !== 'other' && prefs[category] === false)) return;
  const result = await notificationCore.sendToDevices({
    admin, db, uid, notificationRefPath: snap.ref.path,
    title: clean(notification.title) || 'Experience Command',
    body: clean(notification.body).slice(0, 240),
    pushImageUrl: clean(notification.pushImageUrl),
    type: clean(notification.type), category,
    destination: {
      destinationType: clean(notification.destinationType || destination.kind || 'command_notifications'),
      destinationRefPath: destination.ref?.path || '',
      initialPageName: flutterFlowRoute.initialPageName,
      parameterData: flutterFlowRoute.parameterData,
    },
    data: { destinationKind: destination.kind },
  });
  await snap.ref.set({ pushAttemptedAt: admin.firestore.FieldValue.serverTimestamp(), pushSuccessCount: result.succeeded, pushFailureCount: result.failed, invalidTokenCount: result.invalid }, { merge: true });
}

async function maintainCommandNotificationsService() {
  const db = admin.firestore(); const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - 90 * 24 * 60 * 60 * 1000);
  let normalized = 0; let removed = 0;
  const legacy = await db.collection('commandNotifications').where('createdAt', '>=', cutoff).limit(450).get();
  let batch = db.batch();
  for (const doc of legacy.docs) {
    const data = doc.data() || {}; if (typeof data.isRead === 'boolean' && data.category) continue;
    const isRead = bool(data.isRead, bool(data.read, false)); batch.set(doc.ref, { isRead, read: isRead, readAt: data.readAt || null, category: categoryFor(data.type), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }); normalized++;
  }
  await batch.commit();
  const expired = await db.collection('commandNotifications').where('createdAt', '<', cutoff).limit(450).get();
  batch = db.batch(); expired.docs.forEach(doc => { batch.delete(doc.ref); removed++; }); await batch.commit();
  return { normalized, removed };
}

exports.listCommandNotificationsPageService = listCommandNotificationsPageService;
exports.markCommandNotificationReadService = markCommandNotificationReadService;
exports.markAllCommandNotificationsReadService = markAllCommandNotificationsReadService;
exports.registerCommandNotificationDeviceService = registerCommandNotificationDeviceService;
exports.unregisterCommandNotificationDeviceService = unregisterCommandNotificationDeviceService;
exports.updateCommandNotificationPreferencesService = updateCommandNotificationPreferencesService;
exports.maintainCommandNotificationsService = maintainCommandNotificationsService;
exports.listCommandNotificationsPage = callable(listCommandNotificationsPageService);
exports.markCommandNotificationRead = callable(markCommandNotificationReadService);
exports.markAllCommandNotificationsRead = callable(markAllCommandNotificationsReadService);
exports.registerCommandNotificationDevice = callable(registerCommandNotificationDeviceService);
exports.unregisterCommandNotificationDevice = callable(unregisterCommandNotificationDeviceService);
exports.updateCommandNotificationPreferences = callable(updateCommandNotificationPreferencesService);
exports.commandNotificationPushDelivery = onDocumentCreated({ region: REGION, document: 'commandNotifications/{notificationId}', timeoutSeconds: 120, memory: '256MiB' }, commandNotificationPushDeliveryHandler);
exports.maintainCommandNotifications = onSchedule({ region: REGION, schedule: '30 3 * * *', timeZone: 'America/Edmonton', timeoutSeconds: 300, memory: '512MiB' }, maintainCommandNotificationsService);
exports._test = { categoryFor, destinationFrom, destinationAvailableWithoutRef, flutterFlowRouteFor, encodeCursor, decodeCursor, deviceId };
