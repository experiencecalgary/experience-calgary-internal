module.exports = {
  evaluateMonthlyBonusQualifications,
};

const {
  normalizeOrder,
  isOrderRefunded,
} = require("./orderNormalizer");

const {
  getPersonalOnBonusRules,
  getLeadershipOnBonusRules,
  getDirectorOnBonusRules,
  getDirectorBonusTiers,
} = require("./roleHelpers");

const {
  resolveRoleForClosedMonth,
} = require("./roleResolver");

async function evaluateMonthlyBonusQualifications(db, admin, logger) {
  logger.info("monthlyBonusQualification started");

  const now = new Date();
  const window = getPreviousFullCalendarMonth(now);
  const monthKey = buildMonthKey(window.start);

  const [usersSnap, repsSnap, rolesSnap, ordersSnap, shiftsSnap] =
    await Promise.all([
      db
        .collection("users")
        .where("userType", "==", "rep")
        .where("active", "==", true)
        .get(),

      db.collection("reps").where("active", "==", true).get(),

      db.collection("roles").get(),
      db.collection("orderIngest").get(),
      db.collection("scheduledShifts").get(),
    ]);

  const roleMap = {};
  rolesSnap.forEach((doc) => {
    const role = doc.data() || {};
    const roleId = String(role.roleId || doc.id || "");
    if (!roleId) return;
    roleMap[roleId] = role;
  });

  const usersByRepId = {};
  usersSnap.forEach((doc) => {
    const user = doc.data() || {};
    const repId = String(user.repId || "");
    if (!repId) return;

    usersByRepId[repId] = {
      docId: doc.id,
      ...user,
      repId,
    };
  });

  const repsByRepId = {};
  repsSnap.forEach((doc) => {
    const rep = doc.data() || {};
    const repId = String(rep.repId || doc.id || "");
    if (!repId) return;

    repsByRepId[repId] = {
      docId: doc.id,
      ...rep,
      repId,
    };
  });

  const allRepIds = new Set([
    ...Object.keys(usersByRepId),
    ...Object.keys(repsByRepId),
  ]);

  const identityByRepId = {};
  const metricsByRepId = {};

  for (const repId of allRepIds) {
    const user = usersByRepId[repId] || {};
    const rep = repsByRepId[repId] || {};

    identityByRepId[repId] = {
      repId,
      userDocId: usersByRepId[repId]?.docId || null,
      repDocId: repsByRepId[repId]?.docId || repId,
      currentRoleId: String(rep.currentRoleId || user.currentRoleId || ""),
      evaluatedRoleId: "",
      programDirectorRepId: String(
        rep.programDirectorRepId || user.programDirectorRepId || ""
      ),
      directorRepId: String(rep.directorRepId || user.directorRepId || ""),
      hireDate: rep.hireDate || user.hireDate || null,
      roleStartDate: rep.roleStartDate || user.roleStartDate || null,
      createdAt: rep.createdAt || user.createdAt || null,
      bonusGraceStartDate:
        rep.bonusGraceStartDate || user.bonusGraceStartDate || null,
      bonusGraceThrough: rep.bonusGraceThrough || user.bonusGraceThrough || null,
      developmentCampStatus: String(
        rep.developmentCampStatus || user.developmentCampStatus || ""
      ),
      developmentCampBonusStatus: String(
        rep.developmentCampBonusStatus || user.developmentCampBonusStatus || ""
      ),
      developmentCampBonusReason: String(
        rep.developmentCampBonusReason || user.developmentCampBonusReason || ""
      ),
    };

    metricsByRepId[repId] = {
      repId,

      personalX: 0,
      personalRevenue: 0,
      personalSalesCount: 0,
      refundedOrdersCount: 0,
      payableOrdersCount: 0,
      refundRate: 0,
      unapprovedAbsences: 0,

      codedRepIds: [],
      codedPodX: 0,
      codedPodRevenue: 0,
      podX: 0,
      podRevenue: 0,
      developmentCampX: 0,

      codedPdIds: [],
      qualifiedPdIds: [],
      qualifiedPdPodX: 0,
      qualifiedPdPodRevenue: 0,
    };
  }

  /**
   * ======================================
   * Resolve evaluated role for the closed month
   * ======================================
   */
  for (const repId of allRepIds) {
    const identity = identityByRepId[repId];
    if (!identity) continue;

    try {
      const resolution = await resolveRoleForClosedMonth(
        db,
        repId,
        window.start.getFullYear(),
        window.start.getMonth()
      );

      identity.evaluatedRoleId = String(
        resolution?.roleId || identity.currentRoleId || ""
      );
    } catch (err) {
      logger.error("Failed to resolve historical role for qualification", {
        repId,
        monthKey,
        error: String(err),
      });

      identity.evaluatedRoleId = String(identity.currentRoleId || "");
    }
  }

  /**
   * ======================================
   * PASS 1: PERSONAL MONTH METRICS
   * ======================================
   */
  ordersSnap.forEach((doc) => {
    const order = normalizeOrder(doc.data() || {});

    const repId = String(order.salesRepId || "");
    if (!repId) return;
    if (!metricsByRepId[repId]) return;

    const paidAt = parseDate(order.datePaid);
    if (!paidAt) return;
    if (paidAt < window.start || paidAt > window.end) return;

    if (isOrderRefunded(order)) {
      metricsByRepId[repId].refundedOrdersCount += 1;
      return;
    }

    if (!order.isPayable) return;

    metricsByRepId[repId].payableOrdersCount += 1;
    metricsByRepId[repId].personalSalesCount += 1;
    metricsByRepId[repId].personalX += Number(order.xValue || 0);
    metricsByRepId[repId].personalRevenue += Number(order.revenue || 0);
  });

  shiftsSnap.forEach((doc) => {
    const row = doc.data() || {};

    const repId = String(row.repId || "");
    if (!repId) return;
    if (!metricsByRepId[repId]) return;

    const shiftDate = parseDate(row.shiftDate);
    if (!shiftDate) return;
    if (shiftDate < window.start || shiftDate > window.end) return;

    const status = String(row.status || "").trim().toLowerCase();
    if (status === "missed") {
      metricsByRepId[repId].unapprovedAbsences += 1;
    }
  });

  Object.values(metricsByRepId).forEach((m) => {
    m.personalX = round2(m.personalX);
    m.personalRevenue = round2(m.personalRevenue);
    m.refundRate =
      m.payableOrdersCount > 0
        ? round4(m.refundedOrdersCount / m.payableOrdersCount)
        : 0;
  });

  /**
   * ======================================
   * PASS 2: PERSONAL BONUS STATUS
   *
   * BUSINESS RULES:
   * - ROLE1's separate six-week Development Camp status is preserved here;
   *   it is evaluated only by developmentCampQualification
   * - all other roles get grace until they have completed
   *   one full closed calendar month after entering that role
   * - only then do normal qualification rules begin
   * ======================================
   */
  const statusByRepId = {};

  Object.values(identityByRepId).forEach((identity) => {
    const repId = identity.repId;
    const evaluatedRoleId = String(identity.evaluatedRoleId || "");
    const role = roleMap[evaluatedRoleId] || {};
    const metrics = metricsByRepId[repId];

    const isDevelopmentCampRole = evaluatedRoleId === "ROLE1";
    const inNewRoleGracePeriod = isPromotionGraceActive(
      identity,
      window,
      now
    );

    let personalBonusStatus = "offBonus";
    let personalBonusReason = "Role not eligible";

    let developmentCampBonusStatus = "offBonus";
    let developmentCampBonusReason = "Role not applicable";

    if (isDevelopmentCampRole) {
      developmentCampBonusStatus =
        identity.developmentCampBonusStatus || "onBonus";
      developmentCampBonusReason =
        identity.developmentCampBonusReason || "Six-week Development Camp active";

      // Mirror for compatibility with existing app/stat pages
      personalBonusStatus =
        developmentCampBonusStatus === "active" ||
        developmentCampBonusStatus === "onBonus"
          ? "onBonus"
          : "offBonus";
      personalBonusReason = developmentCampBonusReason;
    } else {
      const rules = getPersonalOnBonusRules(role);
      const enabled = Boolean(rules.enabled);

      if (inNewRoleGracePeriod) {
        personalBonusStatus = "onBonus";
        personalBonusReason =
          "Grace period active until first full closed calendar month in new role is completed";
      } else if (enabled) {
        const minX = Number(rules.minX || 0);
        const maxRefundRate = normalizeRate(rules.maxRefundRate);
        const maxUnapprovedAbsences = Number(rules.maxUnapprovedAbsences || 0);

        const passed =
          metrics.personalX >= minX &&
          metrics.refundRate <= maxRefundRate &&
          metrics.unapprovedAbsences <= maxUnapprovedAbsences;

        personalBonusStatus = passed ? "onBonus" : "offBonus";
        personalBonusReason = passed
          ? "Qualified from previous full calendar month"
          : "Did not meet previous full calendar month requirements";
      }
    }

    statusByRepId[repId] = {
      isDevelopmentCampRole,
      inNewRoleGracePeriod,

      personalBonusStatus,
      personalBonusReason,

      developmentCampBonusStatus,
      developmentCampBonusReason,

      leadershipBonusStatus: "offBonus",
      leadershipBonusReason: "Role not eligible",
      directorBonusStatus: "offBonus",
      directorBonusReason: "Role not eligible",
    };
  });

  /**
   * ======================================
   * PASS 3: LEADERSHIP BONUS STATUS
   * leadership bonus uses:
   * personal X + coded pod X + dev camp X
   *
   * Development camp X is based on sale-time production role (roleIdAtSale),
   * not current role today.
   * ======================================
   */
  Object.values(identityByRepId).forEach((leader) => {
    const leaderRepId = leader.repId;
    const role = roleMap[String(leader.evaluatedRoleId || "")] || {};
    const rules = getLeadershipOnBonusRules(role);
    const enabled = Boolean(rules.enabled);

    const leaderMetrics = metricsByRepId[leaderRepId];
    if (!leaderMetrics) return;

    const codedRepIds = Object.values(identityByRepId)
      .filter(
        (u) =>
          String(u.programDirectorRepId || "") === leaderRepId &&
          String(u.repId || "") !== leaderRepId
      )
      .map((u) => String(u.repId || ""));

    leaderMetrics.codedRepIds = codedRepIds;

    let codedPodX = 0;
    let codedPodRevenue = 0;
    let developmentCampX = 0;

    codedRepIds.forEach((repId) => {
      const repMetrics = metricsByRepId[repId];
      if (!repMetrics) return;

      codedPodX += Number(repMetrics.personalX || 0);
      codedPodRevenue += Number(repMetrics.personalRevenue || 0);
    });

    ordersSnap.forEach((doc) => {
      const order = normalizeOrder(doc.data() || {});

      const salesRepId = String(order.salesRepId || "");
      if (!salesRepId) return;
      if (!codedRepIds.includes(salesRepId)) return;

      const paidAt = parseDate(order.datePaid);
      if (!paidAt) return;
      if (paidAt < window.start || paidAt > window.end) return;

      if (isOrderRefunded(order)) return;
      if (!order.isPayable) return;

      const saleRoleId = String(order.roleIdAtSale || "");
      if (saleRoleId === "ROLE1") {
        developmentCampX += Number(order.xValue || 0);
      }
    });

    leaderMetrics.codedPodX = round2(codedPodX);
    leaderMetrics.codedPodRevenue = round2(codedPodRevenue);
    leaderMetrics.podX = round2(Number(leaderMetrics.personalX || 0) + codedPodX);
    leaderMetrics.podRevenue = round2(
      Number(leaderMetrics.personalRevenue || 0) + codedPodRevenue
    );
    leaderMetrics.developmentCampX = round2(developmentCampX);

    if (!enabled) return;

    if (statusByRepId[leaderRepId].inNewRoleGracePeriod) {
      statusByRepId[leaderRepId].leadershipBonusStatus = "onBonus";
      statusByRepId[leaderRepId].leadershipBonusReason =
        "New role promotion grace period";
      return;
    }

    const minPersonalX = Number(rules.minPersonalX || 0);
    const minPodX = Number(rules.minPodX || 0);
    const minDevelopmentCampX = Number(rules.minDevelopmentCampX || 0);
    const maxRefundRate = normalizeRate(rules.maxRefundRate);
    const maxUnapprovedAbsences = Number(rules.maxUnapprovedAbsences || 0);

    const passed =
      leaderMetrics.personalX >= minPersonalX &&
      leaderMetrics.podX >= minPodX &&
      leaderMetrics.developmentCampX >= minDevelopmentCampX &&
      leaderMetrics.refundRate <= maxRefundRate &&
      leaderMetrics.unapprovedAbsences <= maxUnapprovedAbsences;

    statusByRepId[leaderRepId].leadershipBonusStatus = passed
      ? "onBonus"
      : "offBonus";

    statusByRepId[leaderRepId].leadershipBonusReason = passed
      ? "Qualified from previous full calendar month"
      : "Did not meet previous full calendar month leadership requirements";
  });

  /**
   * ======================================
   * PASS 4: DIRECTOR BONUS STATUS
   * Director bonus only counts PD pods whose
   * PD is ON LEADERSHIP BONUS
   *
   * PD role membership is based on evaluated historical role for the month.
   * ======================================
   */
  Object.values(identityByRepId).forEach((leader) => {
    const leaderRepId = leader.repId;
    const role = roleMap[String(leader.evaluatedRoleId || "")] || {};
    const rules = getDirectorOnBonusRules(role);
    const enabled = Boolean(rules.enabled);

    const leaderMetrics = metricsByRepId[leaderRepId];
    if (!leaderMetrics) return;

    const directorBonusTiers = getDirectorBonusTiers(role);
    const firstDirectorTierMinX = getFirstTierMinX(directorBonusTiers);

    const codedPdIds = Object.values(identityByRepId)
      .filter(
        (u) =>
          String(u.directorRepId || "") === leaderRepId &&
          String(u.repId || "") !== leaderRepId &&
          isDirectorTrackedPdRole(String(u.evaluatedRoleId || ""))
      )
      .map((u) => String(u.repId || ""));

    leaderMetrics.codedPdIds = codedPdIds;

    const qualifiedPdIds = codedPdIds.filter((pdRepId) => {
      const pdStatus = statusByRepId[pdRepId];
      return pdStatus && pdStatus.leadershipBonusStatus === "onBonus";
    });

    leaderMetrics.qualifiedPdIds = qualifiedPdIds;

    let qualifiedPdPodX = 0;
    let qualifiedPdPodRevenue = 0;

    qualifiedPdIds.forEach((pdRepId) => {
      const pdMetrics = metricsByRepId[pdRepId];
      if (!pdMetrics) return;

      qualifiedPdPodX += Number(pdMetrics.podX || 0);
      qualifiedPdPodRevenue += Number(pdMetrics.podRevenue || 0);
    });

    leaderMetrics.qualifiedPdPodX = round2(qualifiedPdPodX);
    leaderMetrics.qualifiedPdPodRevenue = round2(qualifiedPdPodRevenue);

    if (!enabled) return;

    if (statusByRepId[leaderRepId].inNewRoleGracePeriod) {
      statusByRepId[leaderRepId].directorBonusStatus = "onBonus";
      statusByRepId[leaderRepId].directorBonusReason =
        "New role promotion grace period";
      return;
    }

    const minQualifiedPdPodX =
      Number(rules.minQualifiedPdPodX || 0) || Number(firstDirectorTierMinX || 0);

    const passed =
      minQualifiedPdPodX > 0 &&
      leaderMetrics.qualifiedPdPodX >= minQualifiedPdPodX;

    statusByRepId[leaderRepId].directorBonusStatus = passed
      ? "onBonus"
      : "offBonus";

    statusByRepId[leaderRepId].directorBonusReason = passed
      ? "Qualified from previous full calendar month"
      : "Did not meet previous full calendar month director requirements";
  });

  /**
   * ======================================
   * PASS 5: WRITE TO USERS + REPS
   * Also write frozen monthly history under:
   * reps/{repId}/monthlyQualifications/{monthKey}
   * ======================================
   */
  const userWriteOps = [];
  const repWriteOps = [];
  const repHistoryWriteOps = [];

  for (const repId of Object.keys(identityByRepId)) {
    const identity = identityByRepId[repId];
    const metrics = metricsByRepId[repId];
    const status = statusByRepId[repId];

    const payload = {
      bonusStatusMonthKey: monthKey,
      bonusStatusEvaluatedAt: admin.firestore.FieldValue.serverTimestamp(),

      personalBonusStatus: status.personalBonusStatus,
      personalBonusReason: status.personalBonusReason,

      developmentCampBonusStatus: status.developmentCampBonusStatus,
      developmentCampBonusReason: status.developmentCampBonusReason,

      inNewRoleGracePeriod: Boolean(status.inNewRoleGracePeriod),
      isDevelopmentCampRole: Boolean(status.isDevelopmentCampRole),

      leadershipBonusStatus: status.leadershipBonusStatus,
      leadershipBonusReason: status.leadershipBonusReason,

      directorBonusStatus: status.directorBonusStatus,
      directorBonusReason: status.directorBonusReason,

      previousMonthPersonalX: round2(metrics.personalX),
      previousMonthPersonalRevenue: round2(metrics.personalRevenue),
      previousMonthPersonalSalesCount: Number(metrics.personalSalesCount || 0),
      previousMonthRefundedOrdersCount: Number(metrics.refundedOrdersCount || 0),
      previousMonthPayableOrdersCount: Number(metrics.payableOrdersCount || 0),
      previousMonthRefundRate: round4(metrics.refundRate),
      previousMonthUnapprovedAbsences: Number(metrics.unapprovedAbsences || 0),

      previousMonthCodedPodX: round2(metrics.codedPodX || 0),
      previousMonthCodedPodRevenue: round2(metrics.codedPodRevenue || 0),
      previousMonthPodX: round2(metrics.podX || 0),
      previousMonthPodRevenue: round2(metrics.podRevenue || 0),
      previousMonthDevelopmentCampX: round2(metrics.developmentCampX || 0),

      previousMonthQualifiedPdPodX: round2(metrics.qualifiedPdPodX || 0),
      previousMonthQualifiedPdPodRevenue: round2(
        metrics.qualifiedPdPodRevenue || 0
      ),

      qualificationPeriod: {
        monthKey,
        start: admin.firestore.Timestamp.fromDate(window.start),
        end: admin.firestore.Timestamp.fromDate(window.end),
      },

      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const historyPayload = {
      repId,
      monthKey,
      roleIdEvaluated: String(identity.evaluatedRoleId || ""),

      personalBonusStatus: status.personalBonusStatus,
      personalBonusReason: status.personalBonusReason,

      developmentCampBonusStatus: status.developmentCampBonusStatus,
      developmentCampBonusReason: status.developmentCampBonusReason,

      inNewRoleGracePeriod: Boolean(status.inNewRoleGracePeriod),
      isDevelopmentCampRole: Boolean(status.isDevelopmentCampRole),

      leadershipBonusStatus: status.leadershipBonusStatus,
      leadershipBonusReason: status.leadershipBonusReason,

      directorBonusStatus: status.directorBonusStatus,
      directorBonusReason: status.directorBonusReason,

      personalX: round2(metrics.personalX),
      personalRevenue: round2(metrics.personalRevenue),
      personalSalesCount: Number(metrics.personalSalesCount || 0),
      refundedOrdersCount: Number(metrics.refundedOrdersCount || 0),
      payableOrdersCount: Number(metrics.payableOrdersCount || 0),
      refundRate: round4(metrics.refundRate),
      unapprovedAbsences: Number(metrics.unapprovedAbsences || 0),

      codedPodX: round2(metrics.codedPodX || 0),
      codedPodRevenue: round2(metrics.codedPodRevenue || 0),
      podX: round2(metrics.podX || 0),
      podRevenue: round2(metrics.podRevenue || 0),
      developmentCampX: round2(metrics.developmentCampX || 0),

      qualifiedPdPodX: round2(metrics.qualifiedPdPodX || 0),
      qualifiedPdPodRevenue: round2(metrics.qualifiedPdPodRevenue || 0),

      codedRepIds: Array.isArray(metrics.codedRepIds) ? metrics.codedRepIds : [],
      codedPdIds: Array.isArray(metrics.codedPdIds) ? metrics.codedPdIds : [],
      qualifiedPdIds: Array.isArray(metrics.qualifiedPdIds)
        ? metrics.qualifiedPdIds
        : [],

      qualificationPeriod: {
        monthKey,
        start: admin.firestore.Timestamp.fromDate(window.start),
        end: admin.firestore.Timestamp.fromDate(window.end),
      },

      calculatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (identity.userDocId) {
      userWriteOps.push({
        ref: db.collection("users").doc(identity.userDocId),
        payload,
      });
    }

    if (identity.repDocId) {
      repWriteOps.push({
        ref: db.collection("reps").doc(identity.repDocId),
        payload,
      });

      repHistoryWriteOps.push({
        ref: db
          .collection("reps")
          .doc(identity.repDocId)
          .collection("monthlyQualifications")
          .doc(monthKey),
        payload: historyPayload,
      });
    }
  }

  await commitInChunks(db, userWriteOps);
  await commitInChunks(db, repWriteOps);
  await commitInChunks(db, repHistoryWriteOps);

  logger.info("monthlyBonusQualification completed", {
    monthKey,
    start: window.start.toISOString(),
    end: window.end.toISOString(),
  });
}

async function commitInChunks(db, ops, chunkSize = 300) {
  for (let i = 0; i < ops.length; i += chunkSize) {
    const chunk = ops.slice(i, i + chunkSize);
    const batch = db.batch();

    chunk.forEach(({ ref, payload }) => {
      batch.set(ref, payload, { merge: true });
    });

    await batch.commit();
  }
}

function getPreviousFullCalendarMonth(now) {
  const start = new Date(
    now.getFullYear(),
    now.getMonth() - 1,
    1,
    0,
    0,
    0,
    0
  );

  const end = new Date(
    now.getFullYear(),
    now.getMonth(),
    0,
    23,
    59,
    59,
    999
  );

  return { start, end };
}

function buildMonthKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function parseDate(value) {
  if (!value) return null;

  if (typeof value?.toDate === "function") {
    const d = value.toDate();
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isPromotionGraceActive(identity, window, now) {
  const explicitGraceThrough = parseDate(identity?.bonusGraceThrough);

  // New promotions stamp an exact grace-through date. Use the time at which
  // this evaluation is running so the monthly result controls the upcoming
  // month: an August 1 run is protected through August 31, while a September
  // 1 run can evaluate August normally.
  if (explicitGraceThrough) {
    return now <= explicitGraceThrough;
  }

  // Backward-compatible fallback for reps promoted before the explicit grace
  // fields were introduced.
  const roleStart =
    parseDate(identity?.roleStartDate) ||
    parseDate(identity?.hireDate) ||
    parseDate(identity?.createdAt);

  if (!roleStart) return false;

  const firstFullMonthStart = startOfNextMonth(roleStart);
  const firstFullMonthEnd = endOfMonth(firstFullMonthStart);

  return window.end < firstFullMonthEnd;
}

function startOfNextMonth(date) {
  return new Date(
    date.getFullYear(),
    date.getMonth() + 1,
    1,
    0,
    0,
    0,
    0
  );
}

function endOfMonth(date) {
  return new Date(
    date.getFullYear(),
    date.getMonth() + 1,
    0,
    23,
    59,
    59,
    999
  );
}

function isDirectorTrackedPdRole(roleId) {
  return (
    roleId === "ROLE7" ||
    roleId === "ROLE8" ||
    roleId === "ROLE9" ||
    roleId === "ROLE10" ||
    roleId === "ROLE11"
  );
}

function getFirstTierMinX(tiers) {
  if (!Array.isArray(tiers) || tiers.length === 0) return 0;

  const sorted = [...tiers].sort(
    (a, b) => Number(a.minX || 0) - Number(b.minX || 0)
  );

  return Number(sorted[0]?.minX || 0);
}

function normalizeRate(value) {
  const n = toNumber(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1 ? roundRate(n / 100) : roundRate(n);
}

function roundRate(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1000000) / 1000000;
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return 0;

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  const cleaned = String(value).replace(/[%,$\s]/g, "").trim();
  if (!cleaned) return 0;

  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function round4(value) {
  return Math.round(Number(value || 0) * 10000) / 10000;
}
