'use strict';

const admin = require('firebase-admin');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const core = require('../lib/notificationCore');

function dedupeId(parts) { return parts.map(core.clean).join('_').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 1400); }
async function createCommand(db, id, data) { const ref = db.collection(core.COMMAND_COLLECTION).doc(id); try { await ref.create({ ...data, isRead: false, read: false, readAt: null, createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() }); return true; } catch (error) { if (core.clean(error.code) === '6' || /already exists/i.test(core.clean(error.message))) return false; throw error; } }

async function inboundEmailHandler(event) {
  const after = event.data?.after; if (!after?.exists) return; const before = event.data?.before; const data = after.data() || {}; const previous = before?.exists ? before.data() || {} : {};
  if (!['in', 'inbound'].includes(core.lower(data.lastDirection || data.lastMessageDirection))) return;
  const currentMs = data.lastMessageAt?.toMillis?.() || 0; const previousMs = previous.lastMessageAt?.toMillis?.() || 0; if (!currentMs || currentMs === previousMs) return;
  const db = admin.firestore(); const senderUid = core.clean(data.lastMessageSenderUid); const uids = core.unique([...(data.unreadBy || []), data.ownerUid, data.assignedToUid]).filter(uid => uid !== senderUid);
  for (const uid of uids) await createCommand(db, dedupeId([uid, 'email_in', after.id, currentMs]), { uid, userRef: db.collection('users').doc(uid), type: 'email_in', category: 'exmail', title: 'New ExMail', body: core.clean(data.subject) || '(No subject)', threadRef: after.ref, emailThreadRef: after.ref, deduplicationKey: dedupeId([uid, 'email_in', after.id, currentMs]) });
}

function isApprovedPromotionStatus(status) {
  return ['approved', 'approved_pending_activation'].includes(core.lower(status));
}

async function promotionDecisionHandler(event) {
  const after = event.data?.after; if (!after?.exists) return; const before = event.data?.before; const data = after.data() || {}; const status = core.lower(data.status); const oldStatus = before?.exists ? core.lower(before.data()?.status) : '';
  if (status === oldStatus || !['approved', 'approved_pending_activation', 'declined', 'rejected'].includes(status)) return;
  const db = admin.firestore(); const repId = core.clean(event.params.repId || data.repId); let uid = core.clean(data.firebaseUid || data.uid);
  if (!uid && repId) { const rep = await db.collection('reps').doc(repId).get(); uid = core.clean(rep.data()?.firebaseUid || rep.data()?.uid); }
  if (!uid) return; const approved = isApprovedPromotionStatus(status); const type = approved ? 'promotion_approved' : 'promotion_declined';
  await createCommand(db, dedupeId([uid, type, event.params.promotionId, status]), { uid, userRef: db.collection('users').doc(uid), type, category: 'announcements', title: approved ? 'Promotion approved' : 'Promotion decision', body: approved ? 'Your promotion has been approved.' : 'Your promotion was not approved at this time.', destinationType: 'sales_dashboard', destinationRefPath: '', initialPageName: 'salesTeamDashboard', parameterData: '{}', deduplicationKey: dedupeId([uid, type, event.params.promotionId, status]) });
}

exports.inboundEmailNotification = onDocumentWritten({ region: core.REGION, document: 'commandEmailThreads/{threadId}', timeoutSeconds: 120, memory: '256MiB' }, inboundEmailHandler);
exports.promotionDecisionNotification = onDocumentWritten({ region: core.REGION, document: 'reps/{repId}/promotions/{promotionId}', timeoutSeconds: 120, memory: '256MiB' }, promotionDecisionHandler);
exports._test = { dedupeId, isApprovedPromotionStatus };
