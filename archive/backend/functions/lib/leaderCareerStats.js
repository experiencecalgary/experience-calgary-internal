module.exports = {
  recomputeLeaderCareerStats,
};

const {
  normalizeOrder,
  isOrderRefunded,
} = require("./orderNormalizer");

const {
  getCommissionRate,
  getVipPlusRate,
  getPdOverrideRate,
  getDirectorOverrideRate,
} = require("./roleHelpers");

const {
  getCurrentPersonalBonusFields,
} = require("./bonusHelpers");

async function recomputeLeaderCareerStats(db, admin, logger) {
  logger.info("leaderCareerStats started");

  const now = new Date();
  const monthStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    1,
    0,
    0,
    0,
    0
  );

  const [
    leaderUsersSnap,
    allUsersSnap,
    rolesSnap,
    ordersSnap,
    attendanceSnap,
  ] = await Promise.all([
    db
      .collection("users")
      .where("userType", "==", "rep")
      .where("active", "==", true)
      .where("isLeader", "==", true)
      .get(),

    db
      .collection("users")
      .where("userType", "==", "rep")
      .where("active", "==", true)
      .get(),

    db.collection("roles").get(),
    db.collection("orderIngest").get(),
    db.collection("attendanceLogs").where("status", "==", "Completed").get(),
  ]);

  const userMap = {};
  const allUsers = [];

  allUsersSnap.forEach((doc) => {
    const row = doc.data() || {};
    const repId = String(row.repId || "");
    if (!repId) return;

    const enriched = {
      docId: doc.id,
      ...row,
      repId,
    };

    userMap[repId] = enriched;
    allUsers.push(enriched);
  });

  const roleMap = {};
  rolesSnap.forEach((doc) => {
    const role = doc.data() || {};
    const roleId = String(role.roleId || doc.id || "");
    if (!roleId) return;
    roleMap[roleId] = role;
  });

  const attendanceRows = [];
  attendanceSnap.forEach((doc) => {
    attendanceRows.push(doc.data() || {});
  });

  /**
   * Lifetime order maps
   * Completed payable only for production/pay stats.
   * Refunded orders tracked separately for refund counts.
   */
  const personalSalesByRepId = {};
  const ordersByPdRepId = {};
  const ordersByDirectorRepId = {};
  const ordersBySalesRepId = {};

  Object.keys(userMap).forEach((repId) => {
    personalSalesByRepId[repId] = makeEmptySalesSummary();
  });

  ordersSnap.forEach((doc) => {
    const rawOrder = doc.data() || {};
    const order = normalizeOrder(rawOrder);

    const salesRepId = String(order.salesRepId || "");
    const pdRepId = String(order.programDirectorRepId || "");
    const directorRepId = String(order.directorRepId || "");
    const paidAt = parseDate(order.datePaid);

    if (salesRepId && !personalSalesByRepId[salesRepId]) {
      personalSalesByRepId[salesRepId] = makeEmptySalesSummary();
    }

    if (isOrderRefunded(order)) {
      if (salesRepId && personalSalesByRepId[salesRepId]) {
        personalSalesByRepId[salesRepId].refundedOrdersCount += 1;
      }
      return;
    }

    if (!order.isPayable) return;

    if (salesRepId) {
      if (!ordersBySalesRepId[salesRepId]) ordersBySalesRepId[salesRepId] = [];
      ordersBySalesRepId[salesRepId].push(order);
    }

    if (pdRepId) {
      if (!ordersByPdRepId[pdRepId]) ordersByPdRepId[pdRepId] = [];
      ordersByPdRepId[pdRepId].push(order);
    }

    if (directorRepId) {
      if (!ordersByDirectorRepId[directorRepId]) {
        ordersByDirectorRepId[directorRepId] = [];
      }
      ordersByDirectorRepId[directorRepId].push(order);
    }

    if (salesRepId && personalSalesByRepId[salesRepId]) {
      addOrderToSummary(personalSalesByRepId[salesRepId], order);

      if (paidAt && paidAt >= monthStart && paidAt <= now) {
        addOrderToCurrentMonthSummary(personalSalesByRepId[salesRepId], order);
      }
    }
  });

  for (const leaderDoc of leaderUsersSnap.docs) {
    const leader = leaderDoc.data() || {};
    const leaderRepId = String(leader.repId || "");
    if (!leaderRepId) continue;

    const roleId = String(leader.currentRoleId || "");
    const role = roleMap[roleId] || {};
    const roleName = String(
      leader.currentRoleName || role.roleName || role.displayName || ""
    );
    const isDevelopmentCampRole = roleId === "ROLE1";

    const commissionRate = getCommissionRate(role);
    const vipPlusRate = getVipPlusRate(role);
    const pdOverrideRate = getPdOverrideRate(role);
    const directorOverrideRate = getDirectorOverrideRate(role);

    const personalBonusStatus = resolveLeaderCareerPersonalBonusStatus(
      leader,
      isDevelopmentCampRole
    );
    const leadershipBonusStatus = resolveStatusValue(
      leader.leadershipBonusStatus,
      "unknown"
    );
    const directorBonusStatus = resolveStatusValue(
      leader.directorBonusStatus,
      "unknown"
    );
    const developmentCampBonusStatus = resolveLeaderCareerDevelopmentCampStatus(
      leader,
      isDevelopmentCampRole
    );

    const personalSales =
      personalSalesByRepId[leaderRepId] || makeEmptySalesSummary();

    const lifetimePersonalX = round2(personalSales.x);
    const lifetimePersonalRevenue = round2(personalSales.revenue);
    const lifetimePersonalSalesCount = Number(personalSales.salesCount || 0);

    const lifetimeVipSalesCount = Number(personalSales.vipSalesCount || 0);
    const lifetimeSignatureSalesCount = Number(
      personalSales.signatureSalesCount || 0
    );
    const lifetimeFounding500SalesCount = Number(
      personalSales.founding500SalesCount || 0
    );

    const refundedOrdersCount = Number(personalSales.refundedOrdersCount || 0);
    const payableOrdersCount = Number(personalSales.payableOrdersCount || 0);

    const refundRate =
      payableOrdersCount > 0
        ? round4(refundedOrdersCount / payableOrdersCount)
        : 0;

    const lifetimeCommissionPay = round2(
      lifetimePersonalRevenue * commissionRate
    );

    const lifetimeVipPlusPay = round2(
      personalSales.vipLikeRevenue * vipPlusRate
    );

    /**
     * Current calendar month personal production snapshot
     * for personal bonus display fields.
     */
    const currentMonthX = round2(Number(personalSales.currentMonthX || 0));
    const currentMonthRevenue = round2(
      Number(personalSales.currentMonthRevenue || 0)
    );
    const currentMonthSalesCount = Number(
      personalSales.currentMonthSalesCount || 0
    );

    const currentBonusFields = getCurrentPersonalBonusFields(
      role,
      currentMonthX,
      currentMonthRevenue
    );

    const currentBonusRate = roundRate(
      Number(currentBonusFields.currentBonusRate || 0)
    );
    const estimatedCurrentBonus = round2(
      Number(currentBonusFields.estimatedCurrentBonus || 0)
    );

    /**
     * PERSONAL POD
     * Full lifetime pod = all orders where programDirectorRepId = leaderRepId
     * codedRep* excludes leader's own personal sales
     */
    const personalPodOrders = ordersByPdRepId[leaderRepId] || [];
    const personalPodSummary = summarizeOrders(personalPodOrders);

    const codedRepOrders = personalPodOrders.filter(
      (order) => String(order.salesRepId || "") !== leaderRepId
    );
    const codedRepSummary = summarizeOrders(codedRepOrders);

    const codedRepIds = allUsers
      .filter((u) => {
        const repId = String(u.repId || "");
        if (!repId || repId === leaderRepId) return false;
        return String(u.programDirectorRepId || "") === leaderRepId;
      })
      .map((u) => String(u.repId || ""));

    const lifetimeCodedRepX = round2(codedRepSummary.xValue);
    const lifetimeCodedRepRevenue = round2(codedRepSummary.revenue);
    const lifetimeCodedRepSalesCount = codedRepSummary.salesCount;

    const lifetimeCodedRepVipSalesCount = codedRepSummary.vipSalesCount;
    const lifetimeCodedRepSignatureSalesCount =
      codedRepSummary.signatureSalesCount;
    const lifetimeCodedRepFounding500SalesCount =
      codedRepSummary.founding500SalesCount;

    const lifetimePersonalPodX = round2(personalPodSummary.xValue);
    const lifetimePersonalPodRevenue = round2(personalPodSummary.revenue);
    const lifetimePersonalPodSalesCount = personalPodSummary.salesCount;

    const lifetimePdOverridePay = round2(
      lifetimeCodedRepRevenue * pdOverrideRate
    );

    /**
     * DIRECTOR ORG
     * Indirect only:
     * - directorRepId = leaderRepId
     * - salesRepId != leaderRepId
     * - programDirectorRepId != leaderRepId
     *
     * This prevents counting their own PD pod inside director org.
     */
    const allDirectorOrders = ordersByDirectorRepId[leaderRepId] || [];
    const directorOrgOrders = allDirectorOrders.filter((order) => {
      const salesRepId = String(order.salesRepId || "");
      const pdRepId = String(order.programDirectorRepId || "");

      if (!salesRepId) return false;
      if (salesRepId === leaderRepId) return false;
      if (pdRepId === leaderRepId) return false;

      return true;
    });

    const directorOrgSummary = summarizeOrders(directorOrgOrders);

    const lifetimeDirectorOrgX = round2(directorOrgSummary.xValue);
    const lifetimeDirectorOrgRevenue = round2(directorOrgSummary.revenue);
    const lifetimeDirectorOrgSalesCount = directorOrgSummary.salesCount;
    const lifetimeDirectorOrgVipSalesCount = directorOrgSummary.vipSalesCount;
    const lifetimeDirectorOrgSignatureSalesCount =
      directorOrgSummary.signatureSalesCount;
    const lifetimeDirectorOrgFounding500SalesCount =
      directorOrgSummary.founding500SalesCount;

    const lifetimeDirectorOverridePay = round2(
      lifetimeDirectorOrgRevenue * directorOverrideRate
    );

    /**
     * DIRECT PD LAYER
     * Direct PD/director-level reps coded to this leader.
     * Excludes self.
     */
    const codedPdIds = allUsers
      .filter((u) => {
        const repId = String(u.repId || "");
        if (!repId || repId === leaderRepId) return false;

        return (
          String(u.directorRepId || "") === leaderRepId &&
          isDirectorTrackedPdRole(String(u.currentRoleId || ""))
        );
      })
      .map((u) => String(u.repId || ""));

    /**
     * Qualified PD pods
     * Uses stored current leadershipBonusStatus to identify which PDs
     * are presently qualified, then sums their FULL pod lifetime totals.
     *
     * This is not a historical qualification engine.
     * It is a current-state career visibility number.
     */
    const qualifiedPdIds = codedPdIds.filter((pdRepId) => {
      const pdUser = userMap[pdRepId] || {};
      return (
        resolveStatusValue(pdUser.leadershipBonusStatus, "unknown") ===
        "onBonus"
      );
    });

    let lifetimeQualifiedPdPodX = 0;
    let lifetimeQualifiedPdPodRevenue = 0;
    let lifetimeQualifiedPdPodSalesCount = 0;

    for (const pdRepId of qualifiedPdIds) {
      const qualifiedPdPodOrders = ordersByPdRepId[pdRepId] || [];
      const qualifiedPdPodSummary = summarizeOrders(qualifiedPdPodOrders);

      lifetimeQualifiedPdPodX += qualifiedPdPodSummary.xValue;
      lifetimeQualifiedPdPodRevenue += qualifiedPdPodSummary.revenue;
      lifetimeQualifiedPdPodSalesCount += qualifiedPdPodSummary.salesCount;
    }

    lifetimeQualifiedPdPodX = round2(lifetimeQualifiedPdPodX);
    lifetimeQualifiedPdPodRevenue = round2(lifetimeQualifiedPdPodRevenue);

    /**
     * ATTENDANCE
     * Keep both personal and direct pod attendance visibility.
     */
    let lifetimePersonalShiftsWorked = 0;
    let lifetimePersonalHoursWorked = 0;

    let lifetimePodShiftsWorked = 0;
    let lifetimePodHoursWorked = 0;

    for (const row of attendanceRows) {
      const repId = String(row.repId || "");

      const inAt = parseDate(row.clockInAt);
      const outAt = parseDate(row.clockOutAt);
      const hoursWorked =
        inAt && outAt && outAt >= inAt
          ? (outAt.getTime() - inAt.getTime()) / 3600000
          : 0;

      if (repId === leaderRepId) {
        lifetimePersonalShiftsWorked += 1;
        lifetimePersonalHoursWorked += hoursWorked;
      }

      if (codedRepIds.includes(repId)) {
        lifetimePodShiftsWorked += 1;
        lifetimePodHoursWorked += hoursWorked;
      }
    }

    const avgXPerShiftLifetime =
      lifetimePersonalShiftsWorked > 0
        ? round2(lifetimePersonalX / lifetimePersonalShiftsWorked)
        : 0;

    const avgXPerHourLifetime =
      lifetimePersonalHoursWorked > 0
        ? round2(lifetimePersonalX / lifetimePersonalHoursWorked)
        : 0;

    const avgRevenuePerShiftLifetime =
      lifetimePersonalShiftsWorked > 0
        ? round2(lifetimePersonalRevenue / lifetimePersonalShiftsWorked)
        : 0;

    const avgRevenuePerHourLifetime =
      lifetimePersonalHoursWorked > 0
        ? round2(lifetimePersonalRevenue / lifetimePersonalHoursWorked)
        : 0;

    const avgPodXPerRepLifetime =
      codedRepIds.length > 0
        ? round2(lifetimePersonalPodX / codedRepIds.length)
        : 0;

    const hireDate = leader.hireDate || null;
    let daysActive = 0;

    const hireDateObj = parseDate(hireDate);
    if (hireDateObj) {
      const ms = Date.now() - hireDateObj.getTime();
      daysActive = Math.max(0, Math.floor(ms / 86400000));
    }

    const lifetimeEstimatedLeaderPay = round2(
      lifetimeCommissionPay +
        lifetimeVipPlusPay +
        lifetimePdOverridePay +
        lifetimeDirectorOverridePay
    );

    await db
      .collection("leaderCareerStats")
      .doc(leaderRepId)
      .set(
        {
          leaderRepId,
          repId: leaderRepId,
          fullName: String(leader.fullName || ""),

          roleId,
          roleName,

          hireDate,
          daysActive,

          personalBonusStatus,
          leadershipBonusStatus,
          directorBonusStatus,
          developmentCampBonusStatus,
          isDevelopmentCampRole,

          commissionRate,
          vipPlusRate,
          pdOverrideRate,
          directorOverrideRate,

          /**
           * Current month personal production snapshot
           */
          currentMonthX,
          currentMonthRevenue,
          currentMonthSalesCount,

          /**
           * New personal bonus fields
           */
          currentBonusRate,
          estimatedCurrentBonus,

          lifetimePersonalX,
          lifetimePersonalRevenue,
          lifetimePersonalSalesCount,

          lifetimeVipSalesCount,
          lifetimeSignatureSalesCount,
          lifetimeFounding500SalesCount,

          refundedOrdersCount,
          payableOrdersCount,
          refundRate,

          lifetimeCommissionPay,
          lifetimeVipPlusPay,

          codedRepIds,
          activeReps: codedRepIds.length,

          lifetimeCodedRepX,
          lifetimeCodedRepRevenue,
          lifetimeCodedRepSalesCount,
          lifetimeCodedRepVipSalesCount,
          lifetimeCodedRepSignatureSalesCount,
          lifetimeCodedRepFounding500SalesCount,

          lifetimePersonalPodX,
          lifetimePersonalPodRevenue,
          lifetimePersonalPodSalesCount,
          lifetimePdOverridePay,

          codedPdIds,
          activePdCount: codedPdIds.length,
          qualifiedPdIds,
          qualifiedPdCount: qualifiedPdIds.length,

          lifetimeDirectorOrgX,
          lifetimeDirectorOrgRevenue,
          lifetimeDirectorOrgSalesCount,
          lifetimeDirectorOrgVipSalesCount,
          lifetimeDirectorOrgSignatureSalesCount,
          lifetimeDirectorOrgFounding500SalesCount,
          lifetimeDirectorOverridePay,

          lifetimeQualifiedPdPodX,
          lifetimeQualifiedPdPodRevenue,
          lifetimeQualifiedPdPodSalesCount,

          lifetimePersonalShiftsWorked,
          lifetimePersonalHoursWorked: round2(lifetimePersonalHoursWorked),

          lifetimePodShiftsWorked,
          lifetimePodHoursWorked: round2(lifetimePodHoursWorked),

          avgXPerShiftLifetime,
          avgXPerHourLifetime,
          avgRevenuePerShiftLifetime,
          avgRevenuePerHourLifetime,
          avgPodXPerRepLifetime,

          lifetimeEstimatedLeaderPay,

          /**
           * Compatibility aliases while other files are updated.
           */
          lifetimePodX: lifetimePersonalPodX,
          lifetimePodRevenue: lifetimePersonalPodRevenue,
          lifetimeOrgX: lifetimeDirectorOrgX,
          lifetimeOrgRevenue: lifetimeDirectorOrgRevenue,

          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
  }

  logger.info("leaderCareerStats completed");
}

function resolveLeaderCareerPersonalBonusStatus(
  leader = {},
  isDevelopmentCampRole = false
) {
  if (isDevelopmentCampRole) {
    return resolveStatusValue(
      leader.developmentCampBonusStatus ||
        leader.personalBonusStatus ||
        "onBonus",
      "onBonus"
    );
  }

  return resolveStatusValue(leader.personalBonusStatus, "unknown");
}

function resolveLeaderCareerDevelopmentCampStatus(
  leader = {},
  isDevelopmentCampRole = false
) {
  if (!isDevelopmentCampRole) return "notApplicable";

  return resolveStatusValue(
    leader.developmentCampBonusStatus ||
      leader.personalBonusStatus ||
      "onBonus",
    "onBonus"
  );
}

function resolveStatusValue(value, fallback = "unknown") {
  const normalized = String(value || "").trim();
  if (!normalized) return fallback;
  return normalized;
}

function makeEmptySalesSummary() {
  return {
    x: 0,
    revenue: 0,
    vipLikeRevenue: 0,
    salesCount: 0,
    vipSalesCount: 0,
    signatureSalesCount: 0,
    founding500SalesCount: 0,
    refundedOrdersCount: 0,
    payableOrdersCount: 0,

    currentMonthX: 0,
    currentMonthRevenue: 0,
    currentMonthSalesCount: 0,
  };
}

function addOrderToSummary(summary, order) {
  const revenue = Number(order.revenue || 0);
  const xValue = Number(order.xValue || 0);

  summary.x += xValue;
  summary.revenue += revenue;
  summary.salesCount += 1;
  summary.payableOrdersCount += 1;

  if (order.isVipLike) {
    summary.vipLikeRevenue += revenue;
  }

  const tier = String(order.tier || order.membershipType || "").toLowerCase();
  if (tier === "vip") {
    summary.vipSalesCount += 1;
  } else if (tier === "founding500") {
    summary.founding500SalesCount += 1;
  } else {
    summary.signatureSalesCount += 1;
  }
}

function addOrderToCurrentMonthSummary(summary, order) {
  const revenue = Number(order.revenue || 0);
  const xValue = Number(order.xValue || 0);

  summary.currentMonthX += xValue;
  summary.currentMonthRevenue += revenue;
  summary.currentMonthSalesCount += 1;
}

function summarizeOrders(orders) {
  const summary = makeEmptySalesSummary();

  for (const order of orders || []) {
    addOrderToSummary(summary, order);
  }

  return {
    xValue: round2(summary.x),
    revenue: round2(summary.revenue),
    vipLikeRevenue: round2(summary.vipLikeRevenue),
    salesCount: summary.salesCount,
    vipSalesCount: summary.vipSalesCount,
    signatureSalesCount: summary.signatureSalesCount,
    founding500SalesCount: summary.founding500SalesCount,
  };
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

function isDirectorTrackedPdRole(roleId) {
  return (
    roleId === "ROLE7" ||
    roleId === "ROLE8" ||
    roleId === "ROLE9" ||
    roleId === "ROLE10" ||
    roleId === "ROLE11"
  );
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function round4(value) {
  return Math.round(Number(value || 0) * 10000) / 10000;
}

function roundRate(value) {
  return Math.round(Number(value || 0) * 1000000) / 1000000;
}