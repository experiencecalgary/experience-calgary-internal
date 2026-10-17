'use strict';
const admin = require('firebase-admin');
const { onCall } = require('firebase-functions/v2/https');
const { requireAuth, requireCommandAccess } = require('../../lib/command/commandPersonUtils');
const board = require('../../lib/command/commandLeadFlowBoard');
async function listCommandLeadFlowPageService(request) {
  const db = admin.firestore(), uid = requireAuth(request);
  const actor = await requireCommandAccess(db, uid);
  return board.list({ db, uid, actor, input: request.data || {} });
}
exports.listCommandLeadFlowPageService = listCommandLeadFlowPageService;
exports.listCommandLeadFlowPage = onCall(
  { region: 'us-central1', cors: true, timeoutSeconds: 120, memory: '512MiB' },
  listCommandLeadFlowPageService
);
