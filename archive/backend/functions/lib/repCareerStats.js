module.exports = {
  recomputeRepCareerStats,
};

const {
  normalizeOrder,
  isOrderRefunded,
} = require("./orderNormalizer");

const {
  getCommissionRate,
  getVipPlusRate,
} = require("./roleHelpers");

const {
  getCurrentPersonalBonusFields,
} = require("./bonusHelpers");

async function recomputeRepCareerStats(db, admin, logger) {
  logger.info("repCareerStats started");

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);

  const [usersSnap, rolesSnap, ordersSnap, attendanceSnap] = await Promise.all([
    db.collection("users").where("userType", "==", "rep").where("active", "==", true).get(),
    db.collection("roles").get(),
    db.collection("orderIngest").get(),
    db.collection("attendanceLogs").where("status", "==", "Completed").get(),
  ]);

  const roleMap = {};
  rolesSnap.forEach((doc) => {
    const role = doc.data() || {};
    const roleId = String(role.roleId || doc.id || "");
    if (roleId) roleMap[roleId] = role;
  });

  const ordersBySalesRepId = {};
  ordersSnap.forEach((doc) => {
    const order = normalizeOrder(doc.data() || {});
    const salesRepId = String(order.salesRepId || "");
    if (!salesRepId) return;
    if (!ordersBySalesRepId[salesRepId]) ordersBySalesRepId[salesRepId] = [];
    ordersBySalesRepId[salesRepId].push(order);
  });

  const attendanceByRepId = {};
  attendanceSnap.forEach((doc) => {
    const row = doc.data() || {};
    const repId = String(row.repId || "");
    if (!repId) return;
    if (!attendanceByRepId[repId]) attendanceByRepId[repId] = [];
    attendanceByRepId[repId].push(row);
  });

  for (const userDoc of usersSnap.docs) {
    const user = userDoc.data() || {};
    const repId = String(user.repId || "");
    if (!repId) continue;

    const roleId = String(user.currentRoleId || "");
    const role = roleMap[roleId] || {};
    const isDevelopmentCampRole = roleId === "ROLE1";

    const roleName = String(user.currentRoleName || role.roleName || role.displayName || "");
    const commissionRate = getCommissionRate(role);
    const vipPlusRate = getVipPlusRate(role);
    const nextRoleId = role?.promotionRules?.nextRoleId || null;

    const personalBonusStatus = resolveCareerPersonalBonusStatus(user, isDevelopmentCampRole);
    const developmentCampBonusStatus = String(
      user.developmentCampBonusStatus || (isDevelopmentCampRole ? "onBonus" : "offBonus")
    );
    const savedDevelopmentCampX = round2(Number(user.developmentCampX || 0));
    const savedDevelopmentCampRevenue = round2(Number(user.developmentCampRevenue || 0));
    const savedDevelopmentCampSalesCount = Number(user.developmentCampSalesCount || 0);
    const savedDevelopmentCampBonusAmount = round2(Number(user.developmentCampBonusAmount || 0));

    const repOrders = ordersBySalesRepId[repId] || [];

    let lifetimeX = 0;
    let lifetimeRevenue = 0;
    let lifetimeSalesCount = 0;
    let vipSalesCount = 0;
    let signatureSalesCount = 0;
    let founding500SalesCount = 0;
    let refundedOrdersCount = 0;
    let payableOrdersCount = 0;
    let vipLikeRevenue = 0;

    let currentMonthX = 0;
    let currentMonthRevenue = 0;
    let currentMonthSalesCount = 0;

    const monthlyBuckets = {};
    const payPeriodBuckets = {};
    const dailyBuckets = {};

    for (const order of repOrders) {
      const paidAt = parseDate(order.datePaid);

      if (isOrderRefunded(order)) {
        refundedOrdersCount += 1;
        continue;
      }

      if (!order.isPayable) continue;

      const x = Number(order.xValue || 0);
      const revenue = Number(order.revenue || 0);
      const tier = String(order.tier || order.membershipType || "").toLowerCase();

      lifetimeX += x;
      lifetimeRevenue += revenue;
      lifetimeSalesCount += 1;
      payableOrdersCount += 1;

      if (order.isVipLike) vipLikeRevenue += revenue;

      if (tier === "vip") {
        vipSalesCount += 1;
      } else if (tier === "founding500") {
        founding500SalesCount += 1;
      } else {
        signatureSalesCount += 1;
      }

      if (paidAt) {
        const monthKey = getMonthKey(paidAt);
        const payPeriodKey = getPayPeriodKey(paidAt);
        const dayKey = getDayKey(paidAt);

        if (!monthlyBuckets[monthKey]) {
          monthlyBuckets[monthKey] = {
            x: 0,
            revenue: 0,
            salesCount: 0,
            vipLikeRevenue: 0,
          };
        }

        if (!payPeriodBuckets[payPeriodKey]) {
          payPeriodBuckets[payPeriodKey] = {
            x: 0,
            revenue: 0,
            salesCount: 0,
            vipLikeRevenue: 0,
          };
        }

        if (!dailyBuckets[dayKey]) {
          dailyBuckets[dayKey] = {
            x: 0,
            revenue: 0,
            salesCount: 0,
            vipLikeRevenue: 0,
          };
        }

        monthlyBuckets[monthKey].x += x;
        monthlyBuckets[monthKey].revenue += revenue;
        monthlyBuckets[monthKey].salesCount += 1;
        if (order.isVipLike) monthlyBuckets[monthKey].vipLikeRevenue += revenue;

        payPeriodBuckets[payPeriodKey].x += x;
        payPeriodBuckets[payPeriodKey].revenue += revenue;
        payPeriodBuckets[payPeriodKey].salesCount += 1;
        if (order.isVipLike) payPeriodBuckets[payPeriodKey].vipLikeRevenue += revenue;

        dailyBuckets[dayKey].x += x;
        dailyBuckets[dayKey].revenue += revenue;
        dailyBuckets[dayKey].salesCount += 1;
        if (order.isVipLike) dailyBuckets[dayKey].vipLikeRevenue += revenue;

        if (paidAt >= monthStart && paidAt <= now) {
          currentMonthX += x;
          currentMonthRevenue += revenue;
          currentMonthSalesCount += 1;
        }
      }
    }

    lifetimeX = round2(lifetimeX);
    lifetimeRevenue = round2(lifetimeRevenue);
    vipLikeRevenue = round2(vipLikeRevenue);
    currentMonthX = round2(currentMonthX);
    currentMonthRevenue = round2(currentMonthRevenue);

    const refundRate = payableOrdersCount > 0 ? round4(refundedOrdersCount / payableOrdersCount) : 0;

    const lifetimeCommissionPay = round2(lifetimeRevenue * commissionRate);
    const lifetimeVipPlusPay = round2(vipLikeRevenue * vipPlusRate);

    const currentBonusFields = getCurrentPersonalBonusFields(role, currentMonthX, currentMonthRevenue);

    const currentBonusRate = roundRate(Number(currentBonusFields.currentBonusRate || 0));
    const estimatedCurrentBonus = round2(Number(currentBonusFields.estimatedCurrentBonus || 0));

    const monthEntries = Object.entries(monthlyBuckets)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, value]) => {
        const bonusFields = getCurrentPersonalBonusFields(
          role,
          Number(value.x || 0),
          Number(value.revenue || 0)
        );

        const bonusRate = roundRate(Number(bonusFields.currentBonusRate || 0));
        const bonusPay = round2(Number(bonusFields.estimatedCurrentBonus || 0));

        return {
          key,
          x: round2(value.x),
          revenue: round2(value.revenue),
          salesCount: Number(value.salesCount || 0),
          vipLikeRevenue: round2(value.vipLikeRevenue || 0),
          commissionPay: round2(Number(value.revenue || 0) * commissionRate),
          vipPlusPay: round2(Number(value.vipLikeRevenue || 0) * vipPlusRate),
          bonusRate,
          bonusPay,
        };
      });

    const payPeriodEntries = Object.entries(payPeriodBuckets)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, value]) => {
        const bonusFields = getCurrentPersonalBonusFields(
          role,
          Number(value.x || 0),
          Number(value.revenue || 0)
        );

        return {
          key,
          x: round2(value.x),
          revenue: round2(value.revenue),
          salesCount: Number(value.salesCount || 0),
          vipLikeRevenue: round2(value.vipLikeRevenue || 0),
          commissionPay: round2(Number(value.revenue || 0) * commissionRate),
          vipPlusPay: round2(Number(value.vipLikeRevenue || 0) * vipPlusRate),
          bonusRate: roundRate(Number(bonusFields.currentBonusRate || 0)),
          bonusPay: round2(Number(bonusFields.estimatedCurrentBonus || 0)),
        };
      });

    const dailyEntries = Object.entries(dailyBuckets)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, value]) => ({
        key,
        x: round2(value.x),
        revenue: round2(value.revenue),
        salesCount: Number(value.salesCount || 0),
        vipLikeRevenue: round2(value.vipLikeRevenue || 0),
      }));

    const bestPayPeriodAmountRow = payPeriodEntries.reduce((best, row) => {
      if (!best || Number(row.commissionPay || 0) + Number(row.vipPlusPay || 0) + Number(row.bonusPay || 0) > Number(best.commissionPay || 0) + Number(best.vipPlusPay || 0) + Number(best.bonusPay || 0)) return row;
      return best;
    }, null);

    const bestPayPeriodXRow = payPeriodEntries.reduce((best, row) => {
      if (!best || Number(row.x || 0) > Number(best.x || 0)) return row;
      return best;
    }, null);

    const bestPayPeriodSalesCountRow = payPeriodEntries.reduce((best, row) => {
      if (!best || Number(row.salesCount || 0) > Number(best.salesCount || 0)) return row;
      return best;
    }, null);

    const bestSalesDayCountRow = dailyEntries.reduce((best, row) => {
      if (!best || Number(row.salesCount || 0) > Number(best.salesCount || 0)) return row;
      return best;
    }, null);

    const bestPayPeriodAmount = bestPayPeriodAmountRow
      ? round2(
          Number(bestPayPeriodAmountRow.commissionPay || 0) +
            Number(bestPayPeriodAmountRow.vipPlusPay || 0) +
            Number(bestPayPeriodAmountRow.bonusPay || 0)
        )
      : 0;

    const bestPayPeriodLabel = bestPayPeriodAmountRow
      ? formatPayPeriodLabel(bestPayPeriodAmountRow.key)
      : "";

    const bestPayPeriodX = bestPayPeriodXRow ? round2(bestPayPeriodXRow.x || 0) : 0;
    const bestPayPeriodXLabel = bestPayPeriodXRow ? formatPayPeriodLabel(bestPayPeriodXRow.key) : "";

    const bestPayPeriodSalesCount = bestPayPeriodSalesCountRow
      ? Number(bestPayPeriodSalesCountRow.salesCount || 0)
      : 0;

    const bestPayPeriodSalesCountLabel = bestPayPeriodSalesCountRow
      ? formatPayPeriodLabel(bestPayPeriodSalesCountRow.key)
      : "";

    const bestSalesDayCount = bestSalesDayCountRow
      ? Number(bestSalesDayCountRow.salesCount || 0)
      : 0;

    const bestSalesDayCountLabel = bestSalesDayCountRow
      ? formatDayLabel(bestSalesDayCountRow.key)
      : "";

    const developmentCampTiers = getDevelopmentCampMilestoneTiers(role);
    const achievedCampTier = isDevelopmentCampRole
      ? (user.developmentCampBonusTier ||
        getHighestTierFromListLocal(developmentCampTiers, savedDevelopmentCampX))
      : null;
    const nextCampTier = isDevelopmentCampRole
      ? getNextTierFromListLocal(developmentCampTiers, savedDevelopmentCampX)
      : null;

    const achievedCampBonusTierMinX = achievedCampTier ? Number(achievedCampTier.minX || 0) : null;
    const nextCampBonusMinX = nextCampTier ? Number(nextCampTier.minX || 0) : null;
    const xToNextCampBonus = nextCampTier ? Math.max(0, Number(nextCampTier.minX || 0) - savedDevelopmentCampX) : 0;

    const lifetimePersonalBonusPay = isDevelopmentCampRole
      ? 0
      : round2(monthEntries.reduce((sum, row) => sum + Number(row.bonusPay || 0), 0));

    const lifetimeDevelopmentCampBonusPay = isDevelopmentCampRole
      ? savedDevelopmentCampBonusAmount
      : 0;

    const lifetimeTotalBonusPay = round2(lifetimePersonalBonusPay + lifetimeDevelopmentCampBonusPay);

    const bonusMonthsAchieved = isDevelopmentCampRole
      ? 0
      : monthEntries.filter((row) => Number(row.bonusPay || 0) > 0).length;

    const highestBonusMonth = monthEntries.reduce((best, row) => {
      if (!best || Number(row.bonusPay || 0) > Number(best.bonusPay || 0)) return row;
      return best;
    }, null);

    const highestBonusMonthKey = highestBonusMonth ? String(highestBonusMonth.key || "") : null;
    const highestBonusMonthPay = highestBonusMonth ? round2(highestBonusMonth.bonusPay || 0) : 0;
    const highestBonusRateAchieved = monthEntries.reduce(
      (max, row) => Math.max(max, Number(row.bonusRate || 0)),
      0
    );

    const topBonusRate = getTopPersonalBonusRate(role);
    const timesTopBonusTierHit =
      !isDevelopmentCampRole && topBonusRate > 0
        ? monthEntries.filter((row) => Number(row.bonusRate || 0) >= topBonusRate).length
        : 0;

    const lastMonth = monthEntries.length > 0 ? monthEntries[monthEntries.length - 1] : null;
    const lastPayPeriod =
      payPeriodEntries.length > 0 ? payPeriodEntries[payPeriodEntries.length - 1] : null;

    const lastMonthBonusPay = lastMonth ? round2(lastMonth.bonusPay || 0) : 0;
    const lastMonthBonusRate = lastMonth ? roundRate(lastMonth.bonusRate || 0) : 0;
    const lastPayPeriodBonusPay = lastPayPeriod ? round2(lastPayPeriod.bonusPay || 0) : 0;
    const lastPayPeriodBonusRate = lastPayPeriod ? roundRate(lastPayPeriod.bonusRate || 0) : 0;

    const lifetimeEstimatedPay = round2(
      lifetimeCommissionPay + lifetimeVipPlusPay + lifetimeTotalBonusPay
    );

    const monthCount = monthEntries.length;
    const payPeriodCount = payPeriodEntries.length;

    const avgMonthlyX = avg(monthEntries, "x");
    const avgMonthlyRevenue = avg(monthEntries, "revenue");
    const avgMonthlySalesCount = avg(monthEntries, "salesCount");

    const avgPayPeriodX = avg(payPeriodEntries, "x");
    const avgPayPeriodRevenue = avg(payPeriodEntries, "revenue");
    const avgPayPeriodSalesCount = avg(payPeriodEntries, "salesCount");

    const highestMonth = monthEntries.reduce((best, row) => {
      if (!best || Number(row.x || 0) > Number(best.x || 0)) return row;
      return best;
    }, null);

    const highestPayPeriod = payPeriodEntries.reduce((best, row) => {
      if (!best || Number(row.x || 0) > Number(best.x || 0)) return row;
      return best;
    }, null);

    const hireDate = user.hireDate || null;
    const hireDateObj = parseDate(hireDate);

    let daysActive = 0;
    if (hireDateObj) {
      daysActive = Math.max(0, Math.floor((Date.now() - hireDateObj.getTime()) / 86400000));
    }

    const repAttendance = attendanceByRepId[repId] || [];
    let lifetimeShiftsWorked = 0;
    let lifetimeHoursWorked = 0;

    for (const row of repAttendance) {
      lifetimeShiftsWorked += 1;

      const inAt = parseDate(row.clockInAt);
      const outAt = parseDate(row.clockOutAt);

      if (inAt && outAt && outAt >= inAt) {
        lifetimeHoursWorked += (outAt.getTime() - inAt.getTime()) / 3600000;
      }
    }

    const avgXPerShiftLifetime =
      lifetimeShiftsWorked > 0 ? round2(lifetimeX / lifetimeShiftsWorked) : 0;

    const avgXPerHourLifetime =
      lifetimeHoursWorked > 0 ? round2(lifetimeX / lifetimeHoursWorked) : 0;

    const avgRevenuePerShiftLifetime =
      lifetimeShiftsWorked > 0 ? round2(lifetimeRevenue / lifetimeShiftsWorked) : 0;

    const avgRevenuePerHourLifetime =
      lifetimeHoursWorked > 0 ? round2(lifetimeRevenue / lifetimeHoursWorked) : 0;

    await db.collection("repCareerStats").doc(repId).set(
      {
        repId,
        fullName: String(user.fullName || ""),

        roleId,
        roleName,
        nextRoleId,

        hireDate,
        daysActive,

        lifetimeX,
        lifetimeRevenue,
        lifetimeSalesCount,

        vipSalesCount,
        signatureSalesCount,
        founding500SalesCount,

        refundedOrdersCount,
        payableOrdersCount,
        refundRate,

        lifetimeShiftsWorked,
        lifetimeHoursWorked: round2(lifetimeHoursWorked),

        avgXPerShiftLifetime,
        avgXPerHourLifetime,
        avgRevenuePerShiftLifetime,
        avgRevenuePerHourLifetime,

        avgMonthlyX,
        avgMonthlyRevenue,
        avgMonthlySalesCount,

        avgPayPeriodX,
        avgPayPeriodRevenue,
        avgPayPeriodSalesCount,

        highestMonthKey: highestMonth ? String(highestMonth.key || "") : null,
        highestMonthX: highestMonth ? round2(highestMonth.x || 0) : 0,
        highestMonthRevenue: highestMonth ? round2(highestMonth.revenue || 0) : 0,

        highestPayPeriodKey: highestPayPeriod ? String(highestPayPeriod.key || "") : null,
        highestPayPeriodX: highestPayPeriod ? round2(highestPayPeriod.x || 0) : 0,
        highestPayPeriodRevenue: highestPayPeriod ? round2(highestPayPeriod.revenue || 0) : 0,

        bestPayPeriodAmount,
        bestPayPeriodLabel,

        bestPayPeriodX,
        bestPayPeriodXLabel,

        bestPayPeriodSalesCount,
        bestPayPeriodSalesCountLabel,

        bestSalesDayCount,
        bestSalesDayCountLabel,

        lastMonthKey: lastMonth ? String(lastMonth.key || "") : null,
        lastMonthX: lastMonth ? round2(lastMonth.x || 0) : 0,
        lastMonthRevenue: lastMonth ? round2(lastMonth.revenue || 0) : 0,
        lastMonthSalesCount: lastMonth ? Number(lastMonth.salesCount || 0) : 0,

        lastPayPeriodKey: lastPayPeriod ? String(lastPayPeriod.key || "") : null,
        lastPayPeriodX: lastPayPeriod ? round2(lastPayPeriod.x || 0) : 0,
        lastPayPeriodRevenue: lastPayPeriod ? round2(lastPayPeriod.revenue || 0) : 0,
        lastPayPeriodSalesCount: lastPayPeriod ? Number(lastPayPeriod.salesCount || 0) : 0,

        monthCount,
        payPeriodCount,

        currentMonthX,
        currentMonthRevenue,
        currentMonthSalesCount,

        commissionRate,
        vipPlusRate,
        lifetimeCommissionPay,
        lifetimeVipPlusPay,
        lifetimeEstimatedPay,

        currentBonusRate,
        estimatedCurrentBonus,

        lifetimePersonalBonusPay,
        lifetimeDevelopmentCampBonusPay,
        lifetimeTotalBonusPay,
        bonusMonthsAchieved,
        highestBonusMonthKey,
        highestBonusMonthPay,
        highestBonusRateAchieved: roundRate(highestBonusRateAchieved),
        timesTopBonusTierHit,
        lastMonthBonusPay,
        lastMonthBonusRate,
        lastPayPeriodBonusPay,
        lastPayPeriodBonusRate,

        personalBonusStatus,
        developmentCampBonusStatus,
        isDevelopmentCampRole,

        developmentCampStatus: String(user.developmentCampStatus || ""),
        developmentCampStartDate: user.developmentCampStartDate || null,
        developmentCampThrough: user.developmentCampThrough || null,
        developmentCampX: savedDevelopmentCampX,
        developmentCampRevenue: savedDevelopmentCampRevenue,
        developmentCampSalesCount: savedDevelopmentCampSalesCount,
        developmentCampQualified: user.developmentCampQualified ?? null,
        developmentCampBonusAmount: savedDevelopmentCampBonusAmount,
        developmentCampBonusTier: user.developmentCampBonusTier || null,

        achievedCampBonusTierMinX,
        nextCampBonusMinX,
        xToNextCampBonus,

        updatedAt: admin.firestore.FieldValue.serverTimestamp(),

        careerX: lifetimeX,
        careerRevenue: lifetimeRevenue,
      },
      { merge: true }
    );
  }

  logger.info("repCareerStats completed");
}

function resolveCareerPersonalBonusStatus(user, isDevelopmentCampRole) {
  if (isDevelopmentCampRole) {
    return String(user.developmentCampBonusStatus || user.personalBonusStatus || "onBonus");
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
    if (normalized.length > 0) return normalized;
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

function getHighestTierFromListLocal(tiers = [], currentX = 0) {
  if (!Array.isArray(tiers) || tiers.length === 0) return null;

  const sorted = [...tiers].sort((a, b) => Number(a.minX || 0) - Number(b.minX || 0));
  let achieved = null;

  for (const tier of sorted) {
    const minX = Number(tier.minX || 0);
    if (currentX >= minX) achieved = tier;
  }

  return achieved;
}

function getNextTierFromListLocal(tiers = [], currentX = 0) {
  if (!Array.isArray(tiers) || tiers.length === 0) return null;

  const sorted = [...tiers].sort((a, b) => Number(a.minX || 0) - Number(b.minX || 0));

  for (const tier of sorted) {
    const minX = Number(tier.minX || 0);
    if (currentX < minX) return tier;
  }

  return null;
}

function getTierBonusAmount(tier) {
  if (!tier || typeof tier !== "object") return 0;

  return Number(
    tier.bonusAmount ??
      tier.amount ??
      tier.payout ??
      tier.pay ??
      tier.bonusPay ??
      tier.value ??
      0
  );
}

function getTopPersonalBonusRate(role = {}) {
  const candidateLists = [
    role?.personalBonus?.tiers,
    role?.personalBonus?.bonusTiers,
    role?.personalProductionBonus?.tiers,
    role?.personalProductionBonus?.bonusTiers,
    role?.bonusTiers,
    role?.personalComp?.bonusTiers,
    role?.personalComp?.tiers,
  ];

  let topRate = 0;

  for (const value of candidateLists) {
    const tiers = normalizeTierList(value);
    for (const tier of tiers) {
      const rate = Number(
        tier.bonusRate ??
          tier.rate ??
          tier.percent ??
          tier.percentage ??
          tier.bonusPercent ??
          0
      );
      if (rate > topRate) topRate = rate;
    }
  }

  return roundRate(topRate);
}

function avg(rows, field) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  return round2(
    rows.reduce((sum, row) => sum + Number(row[field] || 0), 0) / rows.length
  );
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

function getMonthKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function getPayPeriodKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const half = date.getDate() <= 15 ? "A" : "B";
  return `${year}-${month}-${half}`;
}

function getDayKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatPayPeriodLabel(key) {
  if (!key) return "";

  const parts = String(key).split("-");
  if (parts.length !== 3) return String(key);

  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const half = String(parts[2] || "").toUpperCase();

  if (!year || !month || (half !== "A" && half !== "B")) return String(key);

  const startDay = half === "A" ? 1 : 16;
  const endDay = half === "A" ? 15 : new Date(year, month, 0).getDate();

  const startDate = new Date(year, month - 1, startDay);
  const endDate = new Date(year, month - 1, endDay);

  const startMonth = startDate.toLocaleString("en-US", { month: "short" });
  const endMonth = endDate.toLocaleString("en-US", { month: "short" });

  if (startMonth === endMonth) {
    return `${startMonth} ${startDay} - ${endDay}, ${year}`;
  }

  return `${startMonth} ${startDay} - ${endMonth} ${endDay}, ${year}`;
}

function formatDayLabel(key) {
  if (!key) return "";

  const parts = String(key).split("-");
  if (parts.length !== 3) return String(key);

  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);

  if (!year || !month || !day) return String(key);

  const date = new Date(year, month - 1, day);
  const monthName = date.toLocaleString("en-US", { month: "short" });

  return `${monthName} ${day}, ${year}`;
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
