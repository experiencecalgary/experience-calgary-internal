"use strict";

function clean(value) {
  return value == null ? null : String(value).trim() || null;
}

async function createAttributionReview({ db, admin, logger = console, order, attribution }) {
  if (!attribution?.requiresReview) return { created: false, skipped: true };

  const wooOrderId = String(order.wooOrderId);
  const now = admin.firestore.FieldValue.serverTimestamp();
  const reviewRef = db.collection("salesAttributionReviews").doc(wooOrderId);
  const issue = clean(attribution.reviewIssue || attribution.attributionIssue);

  await db.runTransaction(async (tx) => {
    const existingReview = await tx.get(reviewRef);
    const reviewData = {
      wooOrderId,
      status: "open",
      issue,
      submittedSalesRepId: clean(order.submittedSalesRepId),
      attributionSource: clean(order.attributionSource),
      orderType: order.accessPassOrder ? "access_pass" : "membership",
      accessPassOrder: order.accessPassOrder === true,
      customerName: clean(order.customerName),
      customerEmail: clean(order.customerEmail)?.toLowerCase() || null,
      orderTotal: clean(order.orderTotal),
      currency: clean(order.currency),
      updatedAt: now,
      resolvedAt: null,
      resolvedByUid: null,
      resolution: null,
      correctionId: null,
    };
    if (!existingReview.exists) reviewData.createdAt = now;
    tx.set(reviewRef, reviewData, { merge: true });
  });

  const auditRef = db.collection("salesAttributionAudits")
    .doc(`webhook_${wooOrderId}_${issue || "review"}`);
  try {
    await auditRef.create({
      action: "attribution_review_opened",
      wooOrderId,
      actorUid: "woocommerce",
      actorEmail: null,
      requestId: null,
      reason: issue,
      before: attribution.preserved ? attribution : null,
      after: attribution,
      source: clean(order.attributionSource) || "woocommerce",
      affectedPayPeriod: null,
      createdAt: now,
    });
  } catch (error) {
    const code = String(error?.code || "");
    if (code !== "6" && !code.includes("already-exists")) throw error;
  }

  logger.warn("SALES_ATTRIBUTION_REVIEW_OPENED", {
    wooOrderId,
    issue,
    submittedSalesRepId: clean(order.submittedSalesRepId),
  });

  // Surface the exception in the existing Command notification system.
  // Deterministic IDs keep repeated WooCommerce deliveries idempotent.
  const adminQueries = await Promise.all([
    db.collection("users").where("role", "==", "platform_admin").get(),
    db.collection("users").where("platform_admin", "==", true).get(),
    db.collection("users").where("platformAdmin", "==", true).get(),
    db.collection("users").where("isPlatformAdmin", "==", true).get(),
  ]);
  const adminUids = new Set();
  for (const snapshot of adminQueries) {
    for (const doc of snapshot.docs) adminUids.add(doc.id);
  }
  if (adminUids.size) {
    const batch = db.batch();
    for (const uid of adminUids) {
      const notificationRef = db.collection("commandNotifications")
        .doc(`${uid}_sales_attribution_${wooOrderId}`);
      batch.set(notificationRef, {
        uid,
        type: "sales_attribution_review",
        category: "other",
        title: "Sales attribution needs review",
        body: `Order ${wooOrderId} has an unresolved Sales Rep ID (${issue || "unknown issue"}).`,
        isRead: false,
        read: false,
        readAt: null,
        urgent: true,
        wooOrderId,
        reviewRef,
        createdAt: now,
        updatedAt: now,
      }, { merge: true });
    }
    await batch.commit();
  }

  return { created: true, wooOrderId, issue };
}

module.exports = { createAttributionReview };
