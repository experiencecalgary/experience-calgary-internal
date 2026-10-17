"use strict";

const lifecycle = require("../lib/repLifecycle");

function clean(value) { return String(value ?? "").trim(); }

function serialize(value) {
  if (value == null) return value;
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(serialize);
  if (value.path && typeof value.path === "string") return { path: value.path };
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serialize(item)]));
  }
  return value;
}

function isPlatformAdmin(token = {}, user = {}) {
  return token.platform_admin === true || token.platformAdmin === true ||
    user.platform_admin === true || user.platformAdmin === true || user.isPlatformAdmin === true;
}

async function actorFromRequest(req, admin, db) {
  const header = clean(req.headers.authorization);
  if (!header.startsWith("Bearer ")) throw Object.assign(new Error("Authentication required"), { statusCode: 401 });
  const token = await admin.auth().verifyIdToken(header.slice(7));
  const snap = await db.collection("users").doc(token.uid).get();
  const user = snap.data() || {};
  if (!isPlatformAdmin(token, user)) throw Object.assign(new Error("Platform administrator access required"), { statusCode: 403 });
  return { uid: token.uid, email: token.email || user.email || "" };
}

module.exports = function registerRepLifecycleRoutes(app, { admin, db, logger, STAFF_MAIL_USER, STAFF_MAIL_APP_PASSWORD }) {
  app.get("/admin/rep-lifecycle/:repId", async (req, res) => {
    try {
      await actorFromRequest(req, admin, db);
      const result = await lifecycle.getRepLifecycle({ db, repId: req.params.repId });
      return res.status(200).json({ ok: true, result: serialize(result) });
    } catch (error) {
      logger.error("REP_LIFECYCLE_GET_FAILED", { repId: req.params?.repId || "", error: String(error), stack: error?.stack || null });
      return res.status(error.statusCode || 400).json({
        ok: false,
        code: error.statusCode === 403 ? "permission_denied" : "lifecycle_read_error",
        error: error.message || "Could not load rep lifecycle",
      });
    }
  });

  app.post("/admin/rep-lifecycle", async (req, res) => {
    let idempotencyRef = null;
    let action = "";
    try {
      const actor = await actorFromRequest(req, admin, db);
      const input = req.body || {};
      action = clean(input.action);
      const requestId = clean(input.requestId);
      if (!requestId) return res.status(400).json({ ok: false, code: "request_id_required", error: "requestId is required" });

      idempotencyRef = db.collection("adminIdempotency").doc(`rep_lifecycle_${actor.uid}_${requestId}`);
      const existing = await idempotencyRef.get();
      const existingStatus = existing.exists ? clean(existing.data()?.status) : "";
      if (existing.exists && existingStatus !== "failed") {
        return res.status(409).json({ ok: false, code: "duplicate_request", error: "This lifecycle request is already processing or completed" });
      }

      const attemptCount = Number(existing.data()?.attemptCount || 0) + 1;
      await idempotencyRef.set({
        action,
        actorUid: actor.uid,
        status: "started",
        attemptCount,
        lastError: null,
        startedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: existing.exists
          ? (existing.data()?.createdAt || admin.firestore.FieldValue.serverTimestamp())
          : admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      const common = { db, admin, actor, repId: input.repId, reason: input.reason, requestId, mailUserSecret: STAFF_MAIL_USER || null, mailAppPasswordSecret: STAFF_MAIL_APP_PASSWORD || null };
      let result;
      if (action === "retryOnboarding") result = await lifecycle.retryOnboarding(common);
      else if (action === "previewCampDecision") result = await lifecycle.previewCampDecision(db, input.repId);
      else if (action === "createCampMeeting") result = await lifecycle.createCampMeeting({ ...common, startAt: input.startAt, endAt: input.endAt });
      else if (action === "completeCamp") result = await lifecycle.completeCamp(common);
      else if (action === "extendCamp") result = await lifecycle.extendCamp({ ...common, through: input.through });
      else if (action === "schedulePromotion") result = await lifecycle.schedulePromotion({ ...common, promotionId: input.promotionId, effectiveDate: input.effectiveDate });
      else if (action === "applyExceptionalPromotion") result = await lifecycle.approvePromotion({ ...common, promotionId: input.promotionId, exceptionalEffectiveDate: input.exceptionalEffectiveDate || input.effectiveDate });
      else if (action === "correctAttendance") result = await lifecycle.correctAttendance({ db, admin, actor, attendanceId: input.attendanceId, status: input.status, reason: input.reason, requestId });
      else if (action === "approvePromotion") result = await lifecycle.approvePromotion({ ...common, promotionId: input.promotionId, exceptionalEffectiveDate: input.exceptionalEffectiveDate });
      else if (action === "previewDeactivation") result = await lifecycle.previewDeactivation(db, input.repId);
      else if (action === "previewWorkReassignment") result = await lifecycle.reassignActiveWork({ ...common, recipientRepId: input.recipientRepId, dryRun: true });
      else if (action === "commitWorkReassignment") result = await lifecycle.reassignActiveWork({ ...common, recipientRepId: input.recipientRepId, dryRun: false });
      else if (action === "commitDeactivation") result = await lifecycle.deactivateRep(common);
      else throw Object.assign(new Error("Unsupported lifecycle action"), { statusCode: 400, code: "unsupported_action" });

      await idempotencyRef.set({
        status: "completed",
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastError: null,
      }, { merge: true });
      return res.status(200).json({ ok: true, action, requestId, result });
    } catch (error) {
      if (idempotencyRef) {
        try {
          await idempotencyRef.set({
            status: "failed",
            failedAt: admin.firestore.FieldValue.serverTimestamp(),
            lastError: clean(error.message || error),
          }, { merge: true });
        } catch (idempotencyError) {
          logger.error("REP_LIFECYCLE_IDEMPOTENCY_FAILURE", { error: String(idempotencyError) });
        }
      }
      logger.error("REP_LIFECYCLE_FAILED", { action, error: String(error), stack: error?.stack || null });
      return res.status(error.statusCode || 400).json({
        ok: false,
        code: error.code || (error.statusCode === 403 ? "permission_denied" : "lifecycle_error"),
        error: error.message || "Lifecycle operation failed",
      });
    }
  });
};

module.exports.isPlatformAdmin = isPlatformAdmin;
