"use strict";

module.exports = { evaluateDevelopmentCamps };

const { normalizeOrder, isOrderRefunded } = require("./orderNormalizer");
const { calculateCampCompletionBonus } = require("./bonusHelpers");

/**
 * Evaluates each Development Camp exactly once after its individual 42-day
 * window closes. This is deliberately independent from monthly bonuses.
 */
async function evaluateDevelopmentCamps(db, admin, logger) {
  logger.info("developmentCampQualification started");

  const now = new Date();
  const [activeSnap, roleOneSnap, rolesSnap, ordersSnap] = await Promise.all([
    db.collection("reps").where("developmentCampStatus", "==", "active").get(),
    db.collection("reps").where("currentRoleId", "==", "ROLE1").get(),
    db.collection("roles").get(),
    db.collection("orderIngest").get(),
  ]);

  const roleMap = {};
  rolesSnap.forEach((doc) => {
    const role = doc.data() || {};
    roleMap[String(role.roleId || doc.id)] = { ...role, roleId: String(role.roleId || doc.id) };
  });
  const campRole = roleMap.ROLE1 || {};
  const allOrders = ordersSnap.docs.map((doc) => normalizeOrder(doc.data() || {}));

  let evaluated = 0;
  let skipped = 0;

  const candidateDocs = new Map();
  activeSnap.docs.forEach((doc) => candidateDocs.set(doc.ref.path, doc));
  roleOneSnap.docs.forEach((doc) => candidateDocs.set(doc.ref.path, doc));

  for (const repDoc of candidateDocs.values()) {
    const rep = repDoc.data() || {};
    const repId = String(rep.repId || repDoc.id || "").trim();
    const start = parseDate(rep.developmentCampStartDate || rep.hireDate);
    const through =
      parseDate(rep.developmentCampThrough) ||
      (start ? new Date(start.getTime() + 42 * 24 * 60 * 60 * 1000 - 1) : null);

    if (!repId || !start || !through) {
      skipped += 1;
      continue;
    }

    if (now <= through) {
      if (!rep.developmentCampStartDate || !rep.developmentCampThrough) {
        const enrollment = {
          developmentCampStatus: "active",
          developmentCampBonusStatus: "onBonus",
          developmentCampBonusReason: "Six-week Development Camp active",
          developmentCampStartDate: admin.firestore.Timestamp.fromDate(start),
          developmentCampThrough: admin.firestore.Timestamp.fromDate(through),
          developmentCampEvaluatedAt: null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        await repDoc.ref.set(enrollment, { merge: true });
        if (rep.firebaseUid) {
          await db.collection("users").doc(String(rep.firebaseUid)).set(enrollment, { merge: true });
        }
      }
      skipped += 1;
      continue;
    }

    const snapshotId = `development_camp_${repId}`;
    const snapshotRef = db.collection("payrollSnapshots").doc(snapshotId);
    const userRef = rep.firebaseUid
      ? db.collection("users").doc(String(rep.firebaseUid))
      : null;

    try {
      const result = await db.runTransaction(async (tx) => {
        const latestRepSnap = await tx.get(repDoc.ref);
        const latestRep = latestRepSnap.data() || {};
        const existingSnapshot = await tx.get(snapshotRef);

        if (
          latestRep.developmentCampEvaluatedAt ||
          (latestRep.developmentCampStatus &&
            String(latestRep.developmentCampStatus) !== "active") ||
          (existingSnapshot.exists && String(existingSnapshot.data()?.status || "") === "complete")
        ) {
          return { alreadyComplete: true };
        }

        let x = 0;
        let revenue = 0;
        let salesCount = 0;
        let refundedOrdersCount = 0;
        let payableOrdersCount = 0;

        for (const order of allOrders) {
          if (String(order.salesRepId || "") !== repId) continue;
          const paidAt = parseDate(order.datePaid);
          if (!paidAt || paidAt < start || paidAt > through) continue;

          if (isOrderRefunded(order)) {
            refundedOrdersCount += 1;
            continue;
          }
          if (!order.isPayable) continue;

          // Old orders may not have roleIdAtSale. The exact enrollment dates
          // still safely identify those sales; when present, require ROLE1.
          const saleRoleId = String(order.roleIdAtSale || "").trim();
          if (saleRoleId && saleRoleId !== "ROLE1") continue;

          payableOrdersCount += 1;
          salesCount += 1;
          x += Number(order.xValue || 0);
          revenue += Number(order.revenue || 0);
        }

        x = round2(x);
        revenue = round2(revenue);
        const bonus = calculateCampCompletionBonus(campRole, x);
        const bonusAmount = round2(bonus.bonusPay || 0);
        const qualified = Boolean(bonus.qualified && bonusAmount > 0);
        const completedAt = admin.firestore.FieldValue.serverTimestamp();

        const completion = {
          developmentCampStatus: "awaiting_admin_review",
          developmentCampBonusStatus: "pending_admin_review",
          developmentCampBonusReason: qualified
            ? "Six-week Development Camp review is ready; calculated bonus tier available"
            : "Six-week Development Camp review is ready; no bonus tier calculated",
          developmentCampEvaluatedAt: completedAt,
          developmentCampStartDate: admin.firestore.Timestamp.fromDate(start),
          developmentCampThrough: admin.firestore.Timestamp.fromDate(through),
          developmentCampCompletedAt: null,
          developmentCampDecision: "pending_admin_review",
          developmentCampQualified: qualified,
          developmentCampX: x,
          developmentCampRevenue: revenue,
          developmentCampSalesCount: salesCount,
          developmentCampRefundedOrdersCount: refundedOrdersCount,
          developmentCampPayableOrdersCount: payableOrdersCount,
          developmentCampBonusAmount: bonusAmount,
          developmentCampBonusTier: bonus.milestone || null,
          developmentCampBonusPaid: false,
          developmentCampBonusSnapshotId: snapshotId,
          updatedAt: completedAt,
        };

        tx.set(repDoc.ref, completion, { merge: true });
        if (userRef) tx.set(userRef, completion, { merge: true });

        // Qualification is calculation-only. Payroll and lifecycle completion
        // are created only after an explicit platform-admin decision.
        return {
          alreadyComplete: false,
          qualified,
          bonusAmount,
          x,
          status: "awaiting_admin_review",
        };

      });

      if (result.alreadyComplete) skipped += 1;
      else evaluated += 1;
    } catch (error) {
      logger.error("developmentCampQualification rep failed", {
        repId,
        error: String(error),
      });
    }
  }

  logger.info("developmentCampQualification completed", { evaluated, skipped });
  return { evaluated, skipped };
}

function parseDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function round2(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}
