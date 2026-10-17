"use strict";

const {
  canonicalRepName,
  validateRepForSale,
} = require("./salesAttribution");
const { resolveSnapshotPayout } = require("./accountingCompatibility");

function clean(value) {
  return String(value ?? "").trim();
}

function fail(message, statusCode = 400, code = "invalid_request") {
  throw Object.assign(new Error(message), { statusCode, code });
}

function requireRequestId(value) {
  const requestId = clean(value);
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(requestId)) {
    fail("A valid unique requestId is required", 400, "invalid_request_id");
  }
  return requestId;
}

function requireReason(value) {
  const reason = clean(value);
  if (reason.length < 3 || reason.length > 500) {
    fail("A short reason is required", 400, "invalid_reason");
  }
  return reason;
}

function timestampMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function auditPayload({ action, actor, requestId, reason, targetType, targetId, now, result }) {
  return {
    action,
    actorUid: clean(actor?.uid) || null,
    actorEmail: clean(actor?.email).toLowerCase() || null,
    requestId,
    reason,
    targetType,
    targetId,
    success: true,
    result: result || null,
    createdAt: now,
  };
}

async function completedPayrollWarning(db, order = {}) {
  const paidMillis = timestampMillis(order.datePaid);
  if (!paidMillis) return null;
  const snapshots = await db.collection("payrollSnapshots")
    .where("status", "==", "complete")
    .get();
  const affected = snapshots.docs.find((doc) => {
    const data = doc.data() || {};
    const start = timestampMillis(data.payPeriodStart);
    const end = timestampMillis(data.payPeriodEnd);
    return start && end && paidMillis >= start && paidMillis <= end;
  });
  return affected ? {
    code: "completed_payroll_affected",
    snapshotId: affected.id,
    message: "This order falls inside a completed payroll snapshot. Review payroll manually.",
  } : null;
}

async function correctSalesRep({ db, admin, actor, input }) {
  const requestId = requireRequestId(input.requestId);
  const reason = requireReason(input.reason);
  const orderId = clean(input.targetId || input.wooOrderId);
  const salesRepId = clean(input.data?.salesRepId || input.salesRepId);
  if (!orderId) fail("Order ID is required");
  if (!salesRepId) fail("Sales Rep ID is required");

  const validation = await validateRepForSale(db, salesRepId);
  if (!validation.ok) {
    fail(`Selected Sales Rep is not eligible (${validation.issue})`, 400, validation.issue);
  }
  const rep = validation.rep || {};
  const orderRef = db.collection("orderIngest").doc(orderId);
  const initialOrder = await orderRef.get();
  if (!initialOrder.exists) fail("Order not found", 404, "order_not_found");
  const warning = await completedPayrollWarning(db, initialOrder.data() || {});
  const now = admin.firestore.FieldValue.serverTimestamp();
  const fields = {
    salesRepId,
    salesRepName: canonicalRepName(rep),
    roleIdAtSale: clean(rep.currentRoleId),
    programDirectorRepId: clean(rep.programDirectorRepId),
    directorRepId: clean(rep.directorRepId),
    attributionStatus: "admin_corrected",
    attributionSource: "admin_center",
    attributionVersion: 1,
    attributionFinalized: true,
    attributionCorrected: true,
    submittedSalesRepId: salesRepId,
    attributionIssue: null,
    lastAttributionCorrectionId: requestId,
    attributionValidatedAt: now,
    attributionFinalizedAt: now,
    attributionCorrectedAt: now,
    attributionCorrectedByUid: clean(actor?.uid),
    updatedAt: now,
  };
  const result = { orderId, salesRepId, warning };

  await db.runTransaction(async (tx) => {
    const currentOrder = await tx.get(orderRef);
    if (!currentOrder.exists) fail("Order not found", 404, "order_not_found");
    const current = currentOrder.data() || {};
    if (clean(current.lastAttributionCorrectionId) === requestId) return;

    const purchaseRef = db.collection("accessPassPurchases").doc(orderId);
    const reviewRef = db.collection("salesAttributionReviews").doc(orderId);
    const [purchase, review] = await Promise.all([tx.get(purchaseRef), tx.get(reviewRef)]);
    tx.set(orderRef, fields, { merge: true });
    if (purchase.exists) tx.set(purchaseRef, fields, { merge: true });
    if (review.exists) tx.set(reviewRef, {
      status: "resolved",
      resolution: "admin_corrected",
      correctionId: requestId,
      resolvedAt: now,
      resolvedByUid: clean(actor?.uid),
      updatedAt: now,
    }, { merge: true });
    tx.set(db.collection("salesAttributionAudits").doc(`admin_${orderId}_${requestId}`), {
      action: "attribution_corrected",
      wooOrderId: orderId,
      previousSalesRepId: clean(current.salesRepId) || null,
      salesRepId,
      before: {
        salesRepId: clean(current.salesRepId) || null,
        salesRepName: clean(current.salesRepName) || null,
        roleIdAtSale: clean(current.roleIdAtSale) || null,
        programDirectorRepId: clean(current.programDirectorRepId) || null,
        directorRepId: clean(current.directorRepId) || null,
      },
      after: fields,
      reason,
      source: "admin_center",
      affectedPayPeriod: warning?.snapshotId || null,
      actorUid: clean(actor?.uid),
      actorEmail: clean(actor?.email).toLowerCase() || null,
      requestId,
      createdAt: now,
    }, { merge: false });
    tx.set(db.collection("adminAudit").doc(`correctSalesRep_${requestId}`),
      auditPayload({ action: "correctSalesRep", actor, requestId, reason,
        targetType: "order", targetId: orderId, now, result }), { merge: false });
  });
  return result;
}

async function updateInChunks(db, docs, update, chunkSize = 400) {
  let changed = 0;
  for (let index = 0; index < docs.length; index += chunkSize) {
    const batch = db.batch();
    for (const doc of docs.slice(index, index + chunkSize)) {
      batch.set(doc.ref, update, { merge: true });
      changed += 1;
    }
    await batch.commit();
  }
  return changed;
}

async function recomputeMembershipSummary(db, admin, uid) {
  const active = await db.collection("memberships")
    .where("uid", "==", uid).where("active", "==", true).get();
  let vip = false;
  let signature = false;
  let vipRemaining = 0;
  let offersRemaining = 0;
  let savingsRemaining = 0;
  for (const doc of active.docs) {
    const data = doc.data() || {};
    const tier = clean(data.tier).toLowerCase();
    if (tier === "vip" || tier === "founding500") vip = true;
    else signature = true;
    vipRemaining += Math.max(0, Number(data.vipGiftsRemaining || 0));
    offersRemaining += Math.max(0, Number(data.offersRemainingCount || 0));
    savingsRemaining += Math.max(0, Number(data.savingsRemainingDollars || 0));
  }
  await db.collection("users").doc(uid).set({ summary: {
    activeMembershipCount: active.size,
    hasActiveVipMembership: vip,
    hasActiveSignatureMembership: signature,
    vipGiftsRemainingTotal: vipRemaining,
    offersAvailableCount: offersRemaining,
    savingsAvailableTotalDollars: savingsRemaining,
    activeMembershipsWithOffersAvailableCount:
      active.docs.filter((doc) => Number((doc.data() || {}).offersRemainingCount || 0) > 0).length,
    lastSummaryUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    lastSummaryEventType: "membership_revoked",
  } }, { merge: true });
}

async function revokeMembership({ db, admin, actor, input }) {
  const requestId = requireRequestId(input.requestId);
  const reason = requireReason(input.reason);
  const membershipId = clean(input.targetId || input.membershipId);
  if (!membershipId) fail("Membership ID is required");
  const ref = db.collection("memberships").doc(membershipId);
  const snap = await ref.get();
  if (!snap.exists) fail("Membership not found", 404, "membership_not_found");
  const membership = snap.data() || {};
  const uid = clean(membership.uid);
  if (!uid) fail("Membership has no customer UID", 400, "membership_missing_uid");
  if (clean(membership.lastAdminRevocationId) === requestId && membership.revocationCompletedAt) {
    return { membershipId, alreadyRevoked: true };
  }
  const now = admin.firestore.FieldValue.serverTimestamp();
  await ref.set({
    active: false,
    revokedAt: now,
    revokedByUid: clean(actor?.uid),
    revocationReason: reason,
    lastAdminRevocationId: requestId,
    updatedAt: now,
  }, { merge: true });

  const [offers, qrs, credits] = await Promise.all([
    db.collection("customer_offers").where("membershipId", "==", membershipId).get(),
    db.collection("qrCodes").where("membershipId", "==", membershipId).get(),
    db.collection("vip_credits").where("membershipId", "==", membershipId).get(),
  ]);
  const offerDocs = offers.docs.filter((doc) => clean(doc.data()?.status) === "available");
  const qrDocs = qrs.docs.filter((doc) => clean(doc.data()?.status) === "unused");
  const creditDocs = credits.docs.filter((doc) => clean(doc.data()?.status) === "unused");
  const [offersRevoked, qrsExpired, creditsExpired] = await Promise.all([
    updateInChunks(db, offerDocs, { status: "revoked", revokedAt: now, updatedAt: now }),
    updateInChunks(db, qrDocs, { status: "expired", expiredAt: now, updatedAt: now }),
    updateInChunks(db, creditDocs, { status: "expired", expiredAt: now, updatedAt: now }),
  ]);
  await recomputeMembershipSummary(db, admin, uid);
  const result = { membershipId, alreadyRevoked: membership.active === false,
    offersRevoked, qrsExpired, creditsExpired };
  await db.collection("adminAudit").doc(`revokeMembership_${requestId}`).set(
    auditPayload({ action: "revokeMembership", actor, requestId, reason,
      targetType: "membership", targetId: membershipId, now, result }), { merge: false });
  await ref.set({ revocationCompletedAt: now, updatedAt: now }, { merge: true });
  return result;
}

async function setAccessActivation({ db, admin, actor, input }) {
  const requestId = requireRequestId(input.requestId);
  const reason = requireReason(input.reason);
  const accountId = clean(input.targetId || input.accessAccountId);
  const activationEnabled = input.data?.activationEnabled ?? input.activationEnabled;
  if (!accountId) fail("Access Account ID is required");
  if (typeof activationEnabled !== "boolean") fail("activationEnabled must be true or false");
  const ref = db.collection("accessAccounts").doc(accountId);
  const now = admin.firestore.FieldValue.serverTimestamp();
  const result = { accessAccountId: accountId, activationEnabled };
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) fail("Access Account not found", 404, "access_account_not_found");
    const current = snap.data() || {};
    if (clean(current.lastActivationAdminRequestId) === requestId) return;
    tx.set(ref, {
      activationEnabled,
      lastActivationAdminRequestId: requestId,
      activationUpdatedAt: now,
      activationUpdatedByUid: clean(actor?.uid),
      updatedAt: now,
    }, { merge: true });
    tx.set(db.collection("adminAudit").doc(`setAccessActivation_${requestId}`),
      auditPayload({ action: "setAccessActivation", actor, requestId, reason,
        targetType: "accessAccount", targetId: accountId, now, result }), { merge: false });
  });
  return result;
}

const PAYOUT_TRANSITIONS = Object.freeze({
  pending: ["approved", "void"],
  approved: ["exported", "void"],
  exported: ["paid", "void"],
  paid: [],
  void: [],
});

async function setAccountingPayoutStatus({ db, admin, actor, input }) {
  const requestId = requireRequestId(input.requestId);
  const reason = requireReason(input.reason);
  const snapshotId = clean(input.targetId || input.snapshotId);
  const nextStatus = clean(input.data?.payoutStatus || input.payoutStatus).toLowerCase();
  if (!snapshotId) fail("Snapshot ID is required");
  if (!["approved", "exported", "paid", "void"].includes(nextStatus)) {
    fail("Invalid payout status", 400, "invalid_payout_status");
  }
  const ref = db.collection("payrollSnapshots").doc(snapshotId);
  const now = admin.firestore.FieldValue.serverTimestamp();
  let result;
  await db.runTransaction(async (tx) => {
    const [snap, rows, adjustments] = await Promise.all([
      tx.get(ref),
      tx.get(ref.collection("rows")),
      tx.get(db.collection("accountingAdjustments").where("snapshotId", "==", snapshotId)),
    ]);
    if (!snap.exists) fail("Payroll snapshot not found", 404, "snapshot_not_found");
    const data = snap.data() || {};
    if (clean(data.lastPayoutStatusRequestId) === requestId) {
      result = { snapshotId, payoutStatus: clean(data.payoutStatus) || "pending", alreadyApplied: true };
      return;
    }
    if (clean(data.status).toLowerCase() !== "complete") {
      fail("Only completed snapshots can enter the payout lifecycle", 409, "snapshot_not_complete");
    }
    const current = clean(data.payoutStatus || "pending").toLowerCase();
    if (current !== nextStatus && !PAYOUT_TRANSITIONS[current]?.includes(nextStatus)) {
      fail(`Cannot move payout from ${current} to ${nextStatus}`, 409, "invalid_payout_transition");
    }
    if (nextStatus !== "void") {
      const unresolved = adjustments.docs.filter((doc) =>
        ["pending", "approved"].includes(clean((doc.data() || {}).status).toLowerCase())
      );
      if (unresolved.length) {
        fail("All accounting adjustments must be posted, rejected, or voided first",
          409, "unresolved_adjustments");
      }
      if (Number(data.rowCount || 0) !== Number(data.rowsWritten || 0) ||
          Number(data.rowCount || 0) !== rows.size) {
        fail("Snapshot row counts do not reconcile", 409, "snapshot_rows_mismatch");
      }
      const rowPayout = rows.docs.reduce(
        (total, doc) => total + Number((doc.data() || {}).totalPay || 0), 0
      );
      const resolvedPayout = resolveSnapshotPayout(data, rowPayout);
      if (!resolvedPayout.valid || Math.abs(resolvedPayout.value - rowPayout) >= 0.01) {
        fail("Snapshot payout does not reconcile to its rows", 409, "snapshot_payout_mismatch");
      }
      const postedAdjustmentTotal = adjustments.docs
        .filter((doc) => clean((doc.data() || {}).status).toLowerCase() === "posted")
        .reduce((total, doc) => total + Number((doc.data() || {}).amount || 0), 0);
      if (Math.abs(Number(data.adjustmentTotal || 0) - postedAdjustmentTotal) >= 0.01) {
        fail("Posted adjustments do not reconcile to the snapshot",
          409, "snapshot_adjustments_mismatch");
      }
    }
    const eventField = nextStatus === "approved" ? "approved" :
      nextStatus === "exported" ? "exported" :
      nextStatus === "paid" ? "paid" : "voided";
    const patch = {
      payoutStatus: nextStatus,
      lastPayoutStatusRequestId: requestId,
      payoutStatusReason: reason,
      [`${eventField}At`]: now,
      [`${eventField}ByUid`]: clean(actor?.uid),
      updatedAt: now,
    };
    tx.set(ref, patch, { merge: true });
    result = { snapshotId, previousPayoutStatus: current, payoutStatus: nextStatus };
    tx.set(db.collection("adminAudit").doc(`setAccountingPayoutStatus_${requestId}`),
      auditPayload({ action: "setAccountingPayoutStatus", actor, requestId, reason,
        targetType: "payrollSnapshot", targetId: snapshotId, now, result }), { merge: false });
  });
  return result;
}
async function createAccountingAdjustment({ db, admin, actor, input }) {
  const requestId = requireRequestId(input.requestId);
  const reason = requireReason(input.reason);
  const data = input.data || {};
  const snapshotId = clean(input.targetId || data.snapshotId || input.snapshotId);
  const amount = Number(data.amount ?? input.amount);
  const category = clean(data.category || input.category).toLowerCase();
  const allowed = ["refund", "attribution_correction", "manual_correction"];
  if (!snapshotId) fail("Snapshot ID is required");
  if (!Number.isFinite(amount) || amount === 0) fail("A non-zero adjustment amount is required");
  if (!allowed.includes(category)) fail("Invalid adjustment category");
  const adjustmentId = `adjustment_${requestId}`;
  const snapshotRef = db.collection("payrollSnapshots").doc(snapshotId);
  const adjustmentRef = db.collection("accountingAdjustments").doc(adjustmentId);
  const now = admin.firestore.FieldValue.serverTimestamp();
  const result = { adjustmentId, snapshotId, amount, category,
    repId: clean(data.repId || input.repId) || null,
    wooOrderId: clean(data.wooOrderId || input.wooOrderId) || null };
  await db.runTransaction(async (tx) => {
    const [snapshot, existing] = await Promise.all([tx.get(snapshotRef), tx.get(adjustmentRef)]);
    if (!snapshot.exists) fail("Payroll snapshot not found", 404, "snapshot_not_found");
    const snapshotData = snapshot.data() || {};
    if (clean(snapshotData.status).toLowerCase() !== "complete") {
      fail("Adjustments require a completed snapshot", 409, "snapshot_not_complete");
    }
    if (clean(snapshotData.payoutStatus || "pending").toLowerCase() !== "pending") {
      fail("Adjustments are locked after payout approval", 409, "payout_adjustments_locked");
    }
    if (existing.exists) return;
    tx.set(adjustmentRef, { ...result, reason, status: "pending",
      createdByUid: clean(actor?.uid), createdByEmail: clean(actor?.email).toLowerCase() || null,
      createdAt: now, updatedAt: now }, { merge: false });
    tx.set(snapshotRef, { hasAdjustments: true, updatedAt: now }, { merge: true });
    tx.set(db.collection("adminAudit").doc(`createAccountingAdjustment_${requestId}`),
      auditPayload({ action: "createAccountingAdjustment", actor, requestId, reason,
        targetType: "payrollSnapshot", targetId: snapshotId, now, result }), { merge: false });
  });
  return result;
}
async function setAccountingAdjustmentStatus({ db, admin, actor, input }) {
  const requestId = requireRequestId(input.requestId);
  const reason = requireReason(input.reason);
  const adjustmentId = clean(input.targetId || input.adjustmentId);
  const nextStatus = clean(input.data?.status || input.status).toLowerCase();
  if (!adjustmentId) fail("Adjustment ID is required");
  if (!["approved", "posted", "rejected", "void"].includes(nextStatus)) {
    fail("Invalid adjustment status", 400, "invalid_adjustment_status");
  }
  const transitions = {
    pending: ["approved", "rejected", "void"],
    approved: ["posted", "rejected", "void"],
    posted: ["void"],
    rejected: [],
    void: [],
  };
  const ref = db.collection("accountingAdjustments").doc(adjustmentId);
  const now = admin.firestore.FieldValue.serverTimestamp();
  let result;
  await db.runTransaction(async (tx) => {
    const adjustment = await tx.get(ref);
    if (!adjustment.exists) fail("Accounting adjustment not found", 404, "adjustment_not_found");
    const data = adjustment.data() || {};
    if (clean(data.lastStatusRequestId) === requestId) {
      result = { adjustmentId, status: clean(data.status), alreadyApplied: true };
      return;
    }
    const snapshotRef = db.collection("payrollSnapshots").doc(clean(data.snapshotId));
    const snapshot = await tx.get(snapshotRef);
    if (!snapshot.exists) fail("Payroll snapshot not found", 404, "snapshot_not_found");
    const snapshotData = snapshot.data() || {};
    if (clean(snapshotData.payoutStatus || "pending").toLowerCase() !== "pending") {
      fail("Adjustments are locked after payout approval", 409, "payout_adjustments_locked");
    }
    const current = clean(data.status || "pending").toLowerCase();
    if (!transitions[current]?.includes(nextStatus)) {
      fail(`Cannot move adjustment from ${current} to ${nextStatus}`,
        409, "invalid_adjustment_transition");
    }
    const eventName = nextStatus === "void" ? "voided" : nextStatus;
    tx.set(ref, { status: nextStatus, lastStatusRequestId: requestId, statusReason: reason,
      updatedAt: now, [`${eventName}At`]: now, [`${eventName}ByUid`]: clean(actor?.uid) },
    { merge: true });
    let delta = 0;
    if (nextStatus === "posted") delta = Number(data.amount || 0);
    if (current === "posted" && nextStatus === "void") delta = -Number(data.amount || 0);
    if (delta) tx.set(snapshotRef, {
      adjustmentTotal: admin.firestore.FieldValue.increment(delta), updatedAt: now
    }, { merge: true });
    result = { adjustmentId, snapshotId: clean(data.snapshotId),
      previousStatus: current, status: nextStatus };
    tx.set(db.collection("adminAudit").doc(`setAccountingAdjustmentStatus_${requestId}`),
      auditPayload({ action: "setAccountingAdjustmentStatus", actor, requestId, reason,
        targetType: "accountingAdjustment", targetId: adjustmentId, now, result }),
      { merge: false });
  });
  return result;
}

function createAdminCenterActions(dependencies) {
  const deps = dependencies || {};
  return async function execute(input = {}, actor = {}) {
    const action = clean(input.action);
    if (action === "correctSalesRep") return correctSalesRep({ ...deps, actor, input });
    if (action === "revokeMembership") return revokeMembership({ ...deps, actor, input });
    if (action === "setAccessActivation") return setAccessActivation({ ...deps, actor, input });
    if (action === "setAccountingPayoutStatus") {
      return setAccountingPayoutStatus({ ...deps, actor, input });
    }
    if (action === "createAccountingAdjustment") {
      return createAccountingAdjustment({ ...deps, actor, input });
    }
    if (action === "setAccountingAdjustmentStatus") {
      return setAccountingAdjustmentStatus({ ...deps, actor, input });
    }
    fail("Unsupported Admin Center action", 400, "unsupported_admin_action");
  };
}

module.exports = {
  completedPayrollWarning,
  createAdminCenterActions,
  correctSalesRep,
  createAccountingAdjustment,
  recomputeMembershipSummary,
  revokeMembership,
  setAccessActivation,
  setAccountingPayoutStatus,
  setAccountingAdjustmentStatus,
};
