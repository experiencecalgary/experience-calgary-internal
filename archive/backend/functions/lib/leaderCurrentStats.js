module.exports = {
  recomputeLeaderCurrentStats,
};

const {
  normalizeOrder,
  isOrderRefunded,
} = require("./orderNormalizer");

const {
  getPdOverrideRate,
  getDirectorOverrideRate,
  getLeadershipBonusTiers,
  getDirectorBonusTiers,
} = require("./roleHelpers");

const {
  calculateLeadershipBonusIfEligible,
  calculateDirectorBonusIfEligible,
  getHighestTierFromList,
  getCurrentPersonalBonusFields,
} = require("./bonusHelpers");

async function recomputeLeaderCurrentStats(db, admin, logger) {
  logger.info("leaderCurrentStats started");

  const configSnap = await db.collection("appConfig").doc("global").get();
  if (!configSnap.exists) {
    throw new Error("Missing appConfig/global");
  }

  const config = configSnap.data() || {};
  const startTs = config.currentPayPeriodStart;
  const endTs = config.currentPayPeriodEnd;
  const payPeriodLabel = String(config.currentPayPeriodLabel || "");

  if (!startTs || !endTs || !startTs.toDate || !endTs.toDate) {
    throw new Error("Missing or invalid pay period dates in appConfig/global");
  }

  const start = startTs.toDate();
  const end = endTs.toDate();

  const [
    leaderUsersSnap,
    allUsersSnap,
    rolesSnap,
    ordersSnap,
    attendanceSnap,
    repCurrentStatsSnap,
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
    db.collection("repCurrentStats").get(),
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

  const repStatsMap = {};
  repCurrentStatsSnap.forEach((doc) => {
    repStatsMap[String(doc.id)] = doc.data() || {};
  });

  const completedAttendanceRows = [];
  attendanceSnap.forEach((doc) => {
    completedAttendanceRows.push(doc.data() || {});
  });

  const ordersByPdRepId = {};
  const ordersByDirectorRepId = {};
  const ordersBySalesRepId = {};

  ordersSnap.forEach((doc) => {
    const rawOrder = doc.data() || {};
    const order = normalizeOrder(rawOrder);

    const paidAt = parseDate(order.datePaid);
    if (!paidAt) return;
    if (paidAt < start || paidAt > end) return;
    if (isOrderRefunded(order)) return;
    if (!order.isPayable) return;

    const pdRepId = String(order.programDirectorRepId || "");
    const directorRepId = String(order.directorRepId || "");
    const salesRepId = String(order.salesRepId || "");

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

    if (salesRepId) {
      if (!ordersBySalesRepId[salesRepId]) ordersBySalesRepId[salesRepId] = [];
      ordersBySalesRepId[salesRepId].push(order);
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

    const pdOverrideRate = getPdOverrideRate(role);
    const directorOverrideRate = getDirectorOverrideRate(role);

    const leadershipBonusTiers = getLeadershipBonusTiers(role);
    const directorBonusTiers = getDirectorBonusTiers(role);

    const personalStats = repStatsMap[leaderRepId] || {};
    const personalOrders = ordersBySalesRepId[leaderRepId] || [];

    const personalBonusStatus = resolveLeaderPersonalBonusStatus(
      leader,
      personalStats,
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
    const developmentCampBonusStatus = resolveLeaderDevelopmentCampStatus(
      leader,
      personalStats,
      isDevelopmentCampRole
    );

    const isLeadershipBonusEligible = leadershipBonusStatus === "onBonus";
    const isDirectorBonusEligible = directorBonusStatus === "onBonus";

    const fallbackPersonal = summarizeOrders(personalOrders);

    const personalCurrentX = round2(
      Number(personalStats.currentPayPeriodX ?? fallbackPersonal.xValue ?? 0)
    );
    const personalCurrentRevenue = round2(
      Number(
        personalStats.currentPayPeriodRevenue ?? fallbackPersonal.revenue ?? 0
      )
    );
    const personalSalesCount = Number(
      personalStats.currentPayPeriodSalesCount ?? fallbackPersonal.salesCount ?? 0
    );

    /**
     * Current calendar month personal production for bonus display
     */
    const currentMonthX = round2(
      Number(
        personalStats.currentMonthX ??
          personalStats.currentPayPeriodX ??
          fallbackPersonal.xValue ??
          0
      )
    );
    const currentMonthRevenue = round2(
      Number(
        personalStats.currentMonthRevenue ??
          personalStats.currentPayPeriodRevenue ??
          fallbackPersonal.revenue ??
          0
      )
    );
    const currentMonthSalesCount = Number(
      personalStats.currentMonthSalesCount ??
        personalStats.currentPayPeriodSalesCount ??
        fallbackPersonal.salesCount ??
        0
    );

    const personalCommissionPay = round2(
      Number(personalStats.commissionPay || 0)
    );
    const personalVipPlusPay = round2(Number(personalStats.vipPlusPay || 0));
    const personalBonusPay = round2(Number(personalStats.personalBonusPay || 0));
    const personalEstimatedTotalPay = round2(
      Number(personalStats.estimatedTotalPay || 0)
    );

    /**
     * New personal bonus fields
     * PERSONAL production only, based on current calendar month
     */
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
     * All orders where programDirectorRepId = leaderRepId
     * - includes leader personal production if self-coded
     * - codedRep* metrics exclude leader personal sales
     * - pod totals include full pod totals
     */
    const personalPodOrders = ordersByPdRepId[leaderRepId] || [];

    const personalPodSummary = summarizeOrders(personalPodOrders);
    const codedRepOrders = personalPodOrders.filter(
      (order) => String(order.salesRepId || "") !== leaderRepId
    );
    const codedRepSummary = summarizeOrders(codedRepOrders);

    const codedRepRevenue = round2(codedRepSummary.revenue);
    const codedRepX = round2(codedRepSummary.xValue);
    const codedRepSalesCount = codedRepSummary.salesCount;
    const codedRepVipSalesCount = codedRepSummary.vipSalesCount;
    const codedRepSignatureSalesCount = codedRepSummary.signatureSalesCount;
    const codedRepFounding500SalesCount = codedRepSummary.founding500SalesCount;

    const personalPodRevenue = round2(personalPodSummary.revenue);
    const personalPodX = round2(personalPodSummary.xValue);
    const personalPodSalesCount = personalPodSummary.salesCount;

    const pdOverridePay = round2(codedRepRevenue * pdOverrideRate);

    const achievedLeadershipTier = getHighestTierFromList(
      leadershipBonusTiers,
      personalPodX
    );

    const leadershipBonusResult = calculateLeadershipBonusIfEligible({
      isOnBonus: isLeadershipBonusEligible,
      role,
      podX: personalPodX,
      podRevenue: personalPodRevenue,
    });

    const leadershipBonusRate = roundRate(
      Number(leadershipBonusResult.bonusRate || 0)
    );
    const leadershipBonusPay = round2(
      Number(leadershipBonusResult.bonusPay || 0)
    );

    /**
     * DIRECTOR ORG
     * All indirect org orders where:
     * - directorRepId = leaderRepId
     * - programDirectorRepId != leaderRepId
     * - salesRepId != leaderRepId
     *
     * This ensures director math is based on indirect org only,
     * not their own personal pod.
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

    const directorOrgRevenue = round2(directorOrgSummary.revenue);
    const directorOrgX = round2(directorOrgSummary.xValue);
    const directorOrgSalesCount = directorOrgSummary.salesCount;

    const directorOverridePay = round2(
      directorOrgRevenue * directorOverrideRate
    );

    /**
     * CODED PDs
     * Direct PD layer under this leader for director calculations.
     * Excludes the leader themselves.
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
     * Director bonus only on PD pods whose PD is ON LEADERSHIP BONUS.
     * For each qualified PD, use the FULL PD pod:
     * all orders where programDirectorRepId = pdRepId
     */
    const qualifiedPdIds = [];
    let qualifiedPdPodRevenue = 0;
    let qualifiedPdPodX = 0;

    for (const pdRepId of codedPdIds) {
      const pdUser = userMap[pdRepId] || {};
      const pdRepStats = repStatsMap[pdRepId] || {};
      const pdLeadershipStatus = resolveStatusValue(
        pdUser.leadershipBonusStatus || pdRepStats.leadershipBonusStatus,
        "unknown"
      );

      if (pdLeadershipStatus !== "onBonus") continue;

      qualifiedPdIds.push(pdRepId);

      const qualifiedPdPodOrders = ordersByPdRepId[pdRepId] || [];
      const qualifiedPdPodSummary = summarizeOrders(qualifiedPdPodOrders);

      qualifiedPdPodRevenue += qualifiedPdPodSummary.revenue;
      qualifiedPdPodX += qualifiedPdPodSummary.xValue;
    }

    qualifiedPdPodRevenue = round2(qualifiedPdPodRevenue);
    qualifiedPdPodX = round2(qualifiedPdPodX);

    const achievedDirectorTier = getHighestTierFromList(
      directorBonusTiers,
      qualifiedPdPodX
    );

    const directorBonusResult = calculateDirectorBonusIfEligible({
      isOnBonus: isDirectorBonusEligible,
      role,
      orgX: qualifiedPdPodX,
      orgRevenue: qualifiedPdPodRevenue,
    });

    const directorBonusRate = roundRate(
      Number(directorBonusResult.bonusRate || 0)
    );
    const directorBonusPay = round2(Number(directorBonusResult.bonusPay || 0));

    /**
     * TEAM ROSTER / COUNTS
     * Direct reports coded to this PD, excluding self.
     */
    const codedRepIds = allUsers
      .filter((u) => {
        const repId = String(u.repId || "");
        if (!repId || repId === leaderRepId) return false;
        return String(u.programDirectorRepId || "") === leaderRepId;
      })
      .map((u) => String(u.repId || ""));

    const activeReps = codedRepIds.length;
    const activePdCount = codedPdIds.length;
    const qualifiedPdCount = qualifiedPdIds.length;

    /**
     * ATTENDANCE
     * Uses completed attendance for direct coded reps only.
     */
    let podShiftsWorked = 0;
    let podHoursWorked = 0;

    for (const row of completedAttendanceRows) {
      const repId = String(row.repId || "");
      if (!codedRepIds.includes(repId)) continue;

      const shiftDate = parseDate(row.shiftDate);
      if (!shiftDate) continue;
      if (shiftDate < start || shiftDate > end) continue;

      podShiftsWorked += 1;

      const inAt = parseDate(row.clockInAt);
      const outAt = parseDate(row.clockOutAt);

      if (inAt && outAt && outAt >= inAt) {
        podHoursWorked += (outAt.getTime() - inAt.getTime()) / 3600000;
      }
    }

    const avgXPerRep = activeReps > 0 ? round2(personalPodX / activeReps) : 0;
    const avgXPerShift =
      podShiftsWorked > 0 ? round2(personalPodX / podShiftsWorked) : 0;
    const avgXPerHour =
      podHoursWorked > 0 ? round2(personalPodX / podHoursWorked) : 0;

    const leaderEstimatedTotalPay = round2(
      personalEstimatedTotalPay +
        pdOverridePay +
        leadershipBonusPay +
        directorOverridePay +
        directorBonusPay
    );

    await db
      .collection("leaderCurrentStats")
      .doc(leaderRepId)
      .set(
        {
          leaderRepId,
          repId: leaderRepId,
          fullName: String(leader.fullName || ""),
          roleId,
          roleName,

          payPeriodLabel,
          payPeriodStart: startTs,
          payPeriodEnd: endTs,

          personalBonusStatus,
          leadershipBonusStatus,
          directorBonusStatus,
          developmentCampBonusStatus,
          isDevelopmentCampRole,

          personalCurrentX,
          personalCurrentRevenue,
          personalSalesCount,

          /**
           * Current month personal production snapshot
           */
          currentMonthX,
          currentMonthRevenue,
          currentMonthSalesCount,

          personalCommissionPay,
          personalVipPlusPay,
          personalBonusPay,
          personalEstimatedTotalPay,

          /**
           * New personal bonus fields
           */
          currentBonusRate,
          estimatedCurrentBonus,

          codedRepIds,
          activeReps,

          codedRepRevenue,
          codedRepX,
          codedRepSalesCount,
          codedRepVipSalesCount,
          codedRepSignatureSalesCount,
          codedRepFounding500SalesCount,

          personalPodRevenue,
          personalPodX,
          personalPodSalesCount,

          pdOverrideRate,
          pdOverridePay,

          leadershipBonusRate,
          leadershipBonusPay,
          achievedLeadershipTierMinX: achievedLeadershipTier
            ? Number(achievedLeadershipTier.minX || 0)
            : null,

          codedPdIds,
          activePdCount,
          qualifiedPdIds,
          qualifiedPdCount,

          directorOrgRevenue,
          directorOrgX,
          directorOrgSalesCount,

          directorOverrideRate,
          directorOverridePay,

          qualifiedPdPodRevenue,
          qualifiedPdPodX,

          directorBonusRate,
          directorBonusPay,
          achievedDirectorTierMinX: achievedDirectorTier
            ? Number(achievedDirectorTier.minX || 0)
            : null,

          podShiftsWorked,
          podHoursWorked: round2(podHoursWorked),

          avgXPerRep,
          avgXPerShift,
          avgXPerHour,

          leaderEstimatedTotalPay,

          /**
           * Compatibility aliases so downstream pages/scripts
           * do not break while you update the rest of the system.
           */
          podCurrentRevenue: personalPodRevenue,
          podCurrentX: personalPodX,
          orgCurrentRevenue: directorOrgRevenue,
          orgCurrentX: directorOrgX,
          pdOverrideCurrent: pdOverridePay,
          directorOverrideCurrent: directorOverridePay,

          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
  }

  logger.info("leaderCurrentStats completed");
}

function resolveLeaderPersonalBonusStatus(
  leader = {},
  repCurrentStats = {},
  isDevelopmentCampRole = false
) {
  if (isDevelopmentCampRole) {
    return resolveStatusValue(
      leader.developmentCampBonusStatus ||
        repCurrentStats.developmentCampBonusStatus ||
        leader.personalBonusStatus ||
        repCurrentStats.personalBonusStatus ||
        "onBonus",
      "onBonus"
    );
  }

  return resolveStatusValue(
    leader.personalBonusStatus || repCurrentStats.personalBonusStatus,
    "unknown"
  );
}

function resolveLeaderDevelopmentCampStatus(
  leader = {},
  repCurrentStats = {},
  isDevelopmentCampRole = false
) {
  if (!isDevelopmentCampRole) return "notApplicable";

  return resolveStatusValue(
    leader.developmentCampBonusStatus ||
      repCurrentStats.developmentCampBonusStatus ||
      leader.personalBonusStatus ||
      repCurrentStats.personalBonusStatus ||
      "onBonus",
    "onBonus"
  );
}

function resolveStatusValue(value, fallback = "unknown") {
  const normalized = String(value || "").trim();
  if (!normalized) return fallback;
  return normalized;
}

function summarizeOrders(orders) {
  let revenue = 0;
  let xValue = 0;
  let salesCount = 0;
  let vipSalesCount = 0;
  let signatureSalesCount = 0;
  let founding500SalesCount = 0;

  for (const order of orders || []) {
    revenue += Number(order.revenue || 0);
    xValue += Number(order.xValue || 0);
    salesCount += 1;

    const tier = String(order.tier || "").toLowerCase();
    if (tier === "vip") {
      vipSalesCount += 1;
    } else if (tier === "founding500") {
      founding500SalesCount += 1;
    } else {
      signatureSalesCount += 1;
    }
  }

  return {
    revenue: round2(revenue),
    xValue: round2(xValue),
    salesCount,
    vipSalesCount,
    signatureSalesCount,
    founding500SalesCount,
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

function roundRate(value) {
  return Math.round(Number(value || 0) * 1000000) / 1000000;
}