module.exports = {
  recomputeRepCurrentStats,
};

const {
  normalizeOrder,
  isOrderRefunded,
} = require("./orderNormalizer");

const {
  getCommissionRate,
  getVipPlusRate,
  getPersonalBonusTiers,
} = require("./roleHelpers");

const {
  calculatePersonalBonusIfEligible,
  getHighestTierFromList,
  getCurrentPersonalBonusFields,
} = require("./bonusHelpers");

async function recomputeRepCurrentStats(db, admin, logger) {
  logger.info("repCurrentStats started");

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

  /**
   * Bonus progress must use calendar month, not semi-monthly pay period.
   */
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

  const [usersSnap, rolesSnap, ordersSnap, attendanceSnap] = await Promise.all([
    db
      .collection("users")
      .where("userType", "==", "rep")
      .where("active", "==", true)
      .get(),

    db.collection("roles").get(),

    db.collection("orderIngest").get(),

    db.collection("attendanceLogs")
      .where("status", "==", "Completed")
      .get(),
  ]);

  const roleMap = {};
  rolesSnap.forEach((doc) => {
    const role = doc.data() || {};
    const roleId = String(role.roleId || doc.id || "");
    if (!roleId) return;
    roleMap[roleId] = role;
  });

  const ordersBySalesRepId = {};
  ordersSnap.forEach((doc) => {
    const rawOrder = doc.data() || {};
    const normalized = normalizeOrder(rawOrder);

    const salesRepId = String(normalized.salesRepId || "");
    if (!salesRepId) return;

    if (!ordersBySalesRepId[salesRepId]) {
      ordersBySalesRepId[salesRepId] = [];
    }

    ordersBySalesRepId[salesRepId].push(normalized);
  });

  const attendanceByRepId = {};
  attendanceSnap.forEach((doc) => {
    const row = doc.data() || {};
    const repId = String(row.repId || "");
    if (!repId) return;

    if (!attendanceByRepId[repId]) {
      attendanceByRepId[repId] = [];
    }

    attendanceByRepId[repId].push(row);
  });

  for (const userDoc of usersSnap.docs) {
    const user = userDoc.data() || {};
    const repId = String(user.repId || "");
    if (!repId) continue;

    const currentRoleId = String(user.currentRoleId || "");
    const currentRole = roleMap[currentRoleId] || {};
    const isDevelopmentCampRole = currentRoleId === "ROLE1";
    const developmentCampStart = parseDate(user.developmentCampStartDate || user.hireDate);
    const developmentCampThrough = parseDate(user.developmentCampThrough);
    const developmentCampIsActive =
      String(user.developmentCampStatus || "") === "active" &&
      Boolean(developmentCampStart && developmentCampThrough && now <= developmentCampThrough);

    const roleName = String(
      user.currentRoleName ||
        currentRole.roleName ||
        currentRole.displayName ||
        ""
    );

    const standardBonusTiers = getPersonalBonusTiers(currentRole);
    const developmentCampTiers = getDevelopmentCampMilestoneTiers(currentRole);

    const personalBonusStatus = resolvePersonalBonusStatus(
      user,
      isDevelopmentCampRole
    );

    const developmentCampBonusStatus = String(
      user.developmentCampBonusStatus ||
        (isDevelopmentCampRole ? "onBonus" : "offBonus")
    );

    const isPersonalBonusEligible = personalBonusStatus === "onBonus";
    const isDevelopmentCampBonusEligible =
      developmentCampBonusStatus === "onBonus";

    const activeDisplayTiers = isDevelopmentCampRole
      ? developmentCampTiers
      : standardBonusTiers;

    const repOrders = ordersBySalesRepId[repId] || [];

    let currentPayPeriodX = 0;
    let currentPayPeriodRevenue = 0;
    let currentPayPeriodSalesCount = 0;

    let currentMonthX = 0;
    let currentMonthRevenue = 0;
    let currentMonthSalesCount = 0;

    let developmentCampX = Number(user.developmentCampX || 0);
    let developmentCampRevenue = Number(user.developmentCampRevenue || 0);
    let developmentCampSalesCount = Number(user.developmentCampSalesCount || 0);
    if (developmentCampIsActive) {
      developmentCampX = 0;
      developmentCampRevenue = 0;
      developmentCampSalesCount = 0;
    }

    let vipSalesCount = 0;
    let signatureSalesCount = 0;
    let founding500SalesCount = 0;

    let refundedOrdersCount = 0;
    let payableOrdersCount = 0;

    /**
     * IMPORTANT:
     * These are calculated from roleIdAtSale
     * and remain PAY PERIOD financials.
     */
    let commissionPay = 0;
    let vipPlusPay = 0;

    for (const order of repOrders) {
      const paidAt = parseDate(order.datePaid);
      if (!paidAt) continue;

      const inCurrentPayPeriod = paidAt >= start && paidAt <= end;
      const inCurrentMonth = paidAt >= monthStart && paidAt <= now;
      const inDevelopmentCamp =
        developmentCampIsActive &&
        paidAt >= developmentCampStart &&
        paidAt <= developmentCampThrough;

      if (!inCurrentPayPeriod && !inCurrentMonth && !inDevelopmentCamp) {
        continue;
      }

      const refunded = isOrderRefunded(order);

      if (inCurrentPayPeriod && refunded) {
        refundedOrdersCount += 1;
        continue;
      }

      if (refunded) {
        continue;
      }

      if (!order.isPayable) continue;

      const revenue = Number(order.revenue || 0);
      const xValue = Number(order.xValue || 0);

      if (inDevelopmentCamp) {
        const saleRoleId = String(order.roleIdAtSale || "");
        if (!saleRoleId || saleRoleId === "ROLE1") {
          developmentCampX += xValue;
          developmentCampRevenue += revenue;
          developmentCampSalesCount += 1;
        }
      }

      /**
       * Month-to-date bonus progress
       */
      if (inCurrentMonth) {
        currentMonthX += xValue;
        currentMonthRevenue += revenue;
        currentMonthSalesCount += 1;
      }

      /**
       * Pay period financial stats
       */
      if (inCurrentPayPeriod) {
        currentPayPeriodX += xValue;
        currentPayPeriodRevenue += revenue;
        currentPayPeriodSalesCount += 1;
        payableOrdersCount += 1;

        const saleRoleId = String(order.roleIdAtSale || "");
        const saleRole = roleMap[saleRoleId] || {};

        const saleCommissionRate = getCommissionRate(saleRole);
        const saleVipPlusRate = getVipPlusRate(saleRole);

        commissionPay += revenue * saleCommissionRate;

        if (order.isVipLike) {
          vipPlusPay += revenue * saleVipPlusRate;
        }

        const tier = String(order.tier || "").toLowerCase();

        if (tier === "vip") {
          vipSalesCount += 1;
        } else if (tier === "founding500") {
          founding500SalesCount += 1;
        } else {
          signatureSalesCount += 1;
        }
      }
    }

    currentPayPeriodX = round2(currentPayPeriodX);
    currentPayPeriodRevenue = round2(currentPayPeriodRevenue);
    currentMonthX = round2(currentMonthX);
    currentMonthRevenue = round2(currentMonthRevenue);
    developmentCampX = round2(developmentCampX);
    developmentCampRevenue = round2(developmentCampRevenue);

    commissionPay = round2(commissionPay);
    vipPlusPay = round2(vipPlusPay);

    const refundRate =
      payableOrdersCount > 0
        ? round4(refundedOrdersCount / payableOrdersCount)
        : 0;

    /**
     * Bonus / milestone preview
     * IMPORTANT:
     * Bonus progression must use MONTH-TO-DATE X.
     */
    const bonusProgressX = isDevelopmentCampRole
      ? developmentCampX
      : currentMonthX;

    const achievedTier = getHighestTierFromList(
      activeDisplayTiers,
      bonusProgressX
    );

    const nextTier = getNextTierFromList(
      activeDisplayTiers,
      bonusProgressX
    );

    /**
     * Existing gated personal bonus pay remains available for compatibility.
     * It now uses MONTH-TO-DATE personal production because bonuses are monthly.
     */
    const personalBonusResult = isDevelopmentCampRole
      ? { bonusRate: 0, bonusPay: 0 }
      : calculatePersonalBonusIfEligible({
          isOnBonus: isPersonalBonusEligible,
          role: currentRole,
          xValue: currentMonthX,
          revenue: currentMonthRevenue,
        });

    const currentPersonalBonusRate = roundRate(
      Number(personalBonusResult.bonusRate || 0)
    );

    const personalBonusPay = round2(
      Number(personalBonusResult.bonusPay || 0)
    );

    /**
     * New fields:
     * - currentBonusRate
     * - estimatedCurrentBonus
     *
     * These represent current PERSONAL production bonus status,
     * and are not gated by monthly status flags.
     */
    const currentBonusFields = getCurrentPersonalBonusFields(
      currentRole,
      isDevelopmentCampRole ? developmentCampX : currentMonthX,
      isDevelopmentCampRole ? developmentCampRevenue : currentMonthRevenue
    );

    const currentBonusRate = roundRate(
      Number(currentBonusFields.currentBonusRate || 0)
    );

    const estimatedCurrentBonus = round2(
      Number(currentBonusFields.estimatedCurrentBonus || 0)
    );

    /**
     * Keep estimatedTotalPay as existing pay-period estimate structure.
     * Add estimatedCurrentBonus separately for clean app display.
     */
    const estimatedTotalPay = round2(
      commissionPay + vipPlusPay + personalBonusPay
    );

    /**
     * Attendance
     */
    const repAttendance = attendanceByRepId[repId] || [];

    let shiftsWorked = 0;
    let hoursWorked = 0;

    for (const row of repAttendance) {
      const shiftDate = parseDate(row.shiftDate);

      if (!shiftDate) continue;
      if (shiftDate < start || shiftDate > end) continue;

      shiftsWorked += 1;

      const clockInAt = parseDate(row.clockInAt);
      const clockOutAt = parseDate(row.clockOutAt);

      if (clockInAt && clockOutAt && clockOutAt >= clockInAt) {
        hoursWorked +=
          (clockOutAt.getTime() - clockInAt.getTime()) / 3600000;
      }
    }

    const avgXPerShift =
      shiftsWorked > 0 ? round2(currentPayPeriodX / shiftsWorked) : 0;

    const avgXPerHour =
      hoursWorked > 0 ? round2(currentPayPeriodX / hoursWorked) : 0;

    const avgRevenuePerShift =
      shiftsWorked > 0 ? round2(currentPayPeriodRevenue / shiftsWorked) : 0;

    const avgRevenuePerHour =
      hoursWorked > 0 ? round2(currentPayPeriodRevenue / hoursWorked) : 0;

    const achievedBonusTierMinX = achievedTier
      ? Number(achievedTier.minX || 0)
      : null;

    const nextBonusMinX = nextTier
      ? Number(nextTier.minX || 0)
      : null;

    const xToNextBonus = nextTier
      ? Math.max(0, Number(nextTier.minX || 0) - bonusProgressX)
      : 0;

    const achievedCampBonusTierMinX = isDevelopmentCampRole
      ? achievedBonusTierMinX
      : null;

    const nextCampBonusMinX = isDevelopmentCampRole
      ? nextBonusMinX
      : null;

    const xToNextCampBonus = isDevelopmentCampRole
      ? xToNextBonus
      : 0;

    await db
      .collection("repCurrentStats")
      .doc(repId)
      .set(
        {
          repId,
          fullName: String(user.fullName || ""),

          roleId: currentRoleId,
          roleName,

          payPeriodLabel,
          payPeriodStart: startTs,
          payPeriodEnd: endTs,

          currentPayPeriodX,
          currentPayPeriodRevenue,
          currentPayPeriodSalesCount,

          /**
           * Month-to-date personal production for bonus tracking
           */
          currentMonthX,
          currentMonthRevenue,
          currentMonthSalesCount,

          vipSalesCount,
          signatureSalesCount,
          founding500SalesCount,

          refundedOrdersCount,
          payableOrdersCount,
          refundRate,

          /**
           * Display rates from current role
           */
          commissionRate: getCommissionRate(currentRole),
          vipPlusRate: getVipPlusRate(currentRole),

          /**
           * Actual pay from roleIdAtSale
           */
          commissionPay,
          vipPlusPay,

          /**
           * Bonus / camp status
           */
          personalBonusStatus,
          developmentCampBonusStatus,
          developmentCampStatus: String(user.developmentCampStatus || ""),
          developmentCampStartDate: user.developmentCampStartDate || null,
          developmentCampThrough: user.developmentCampThrough || null,
          developmentCampIsActive,
          developmentCampX,
          developmentCampRevenue,
          developmentCampSalesCount,

          isPersonalBonusEligible,
          isDevelopmentCampBonusEligible,
          isDevelopmentCampRole,

          /**
           * Existing compatibility fields
           */
          currentPersonalBonusRate,
          personalBonusPay,

          /**
           * New app-facing bonus fields
           * PERSONAL bonus only
           */
          currentBonusRate,
          estimatedCurrentBonus,

          estimatedTotalPay,

          /**
           * Generic bonus fields
           * ROLE1 uses camp milestones here for compatibility
           * IMPORTANT: month-based
           */
          achievedBonusTierMinX,
          nextBonusMinX,
          xToNextBonus,

          /**
           * Dedicated Development Camp fields
           * IMPORTANT: month-based
           */
          achievedCampBonusTierMinX,
          nextCampBonusMinX,
          xToNextCampBonus,

          shiftsWorked,
          hoursWorked: round2(hoursWorked),

          avgXPerShift,
          avgXPerHour,
          avgRevenuePerShift,
          avgRevenuePerHour,

          updatedAt: admin.firestore.FieldValue.serverTimestamp(),

          /**
           * Compatibility aliases
           */
          payPeriodX: currentPayPeriodX,
          payPeriodRevenue: currentPayPeriodRevenue,
          salesCount: currentPayPeriodSalesCount,
        },
        { merge: true }
      );
  }

  logger.info("repCurrentStats completed");
}

function resolvePersonalBonusStatus(user, isDevelopmentCampRole) {
  if (isDevelopmentCampRole) {
    return String(
      user.developmentCampBonusStatus ||
        user.personalBonusStatus ||
        "onBonus"
    );
  }

  return String(user.personalBonusStatus || "offBonus");
}

function getDevelopmentCampMilestoneTiers(role = {}) {
  const candidateLists = [
    role?.campCompletionBonus?.tiers,
    role?.campCompletionBonus?.bonusTiers,
    role?.campCompletionBonus,
    role?.developmentCampBonusTiers,
    role?.developmentCamp?.tiers,
    role?.developmentCamp?.bonusTiers,
  ];

  for (const value of candidateLists) {
    const normalized = normalizeTierList(value);
    if (normalized.length > 0) {
      return normalized;
    }
  }

  return [];
}

function normalizeTierList(value) {
  if (!value) return [];

  if (Array.isArray(value)) {
    return value
      .map((item) => ({
        ...item,
        minX: Number(item?.minX ?? item?.x ?? item?.thresholdX ?? 0),
      }))
      .filter((item) => Number(item.minX || 0) > 0);
  }

  if (typeof value === "object") {
    return Object.values(value)
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        ...item,
        minX: Number(item?.minX ?? item?.x ?? item?.thresholdX ?? 0),
      }))
      .filter((item) => Number(item.minX || 0) > 0);
  }

  return [];
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

function getNextTierFromList(tiers = [], currentX = 0) {
  if (!Array.isArray(tiers) || tiers.length === 0) return null;

  const sorted = [...tiers].sort(
    (a, b) => Number(a.minX || 0) - Number(b.minX || 0)
  );

  for (const tier of sorted) {
    const minX = Number(tier.minX || 0);

    if (currentX < minX) {
      return tier;
    }
  }

  return null;
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
