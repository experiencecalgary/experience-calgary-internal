"use strict";

/**
 * bonusHelpers.js
 *
 * Purpose:
 * Centralized bonus calculation helpers.
 *
 * Business rules:
 * - X unlocks the bonus tier.
 * - Revenue determines payout.
 * - Personal, leadership, and director bonuses are separate engines.
 * - Development camp completion bonus is separate from normal revenue bonus tiers.
 * - currentBonusRate / estimatedCurrentBonus should represent PERSONAL production bonus only.
 */

const {
  getPersonalBonusTier,
  getLeadershipBonusTier,
  getDirectorBonusTier,
  getPersonalBonusRate,
  getLeadershipBonusRate,
  getDirectorBonusRate,
  getCampCompletionBonus,
  getCampGraduationRules,
  isDevelopmentCampRole,
} = require("./roleHelpers");

/* -------------------------------------------------------------------------- */
/*                            Generic payout helpers                          */
/* -------------------------------------------------------------------------- */

function calculateRateBonus({ xValue = 0, revenue = 0, tiers = [] } = {}) {
  const x = toNumber(xValue);
  const rev = toMoney(revenue);

  if (x <= 0 || rev <= 0 || !Array.isArray(tiers) || tiers.length === 0) {
    return {
      qualified: false,
      xValue: x,
      revenue: rev,
      tier: null,
      bonusRate: 0,
      bonusPay: 0,
    };
  }

  const tier = getHighestTierFromList(tiers, x);
  const bonusRate = normalizeRate(tier?.bonusRate);

  if (!tier || bonusRate <= 0) {
    return {
      qualified: false,
      xValue: x,
      revenue: rev,
      tier: null,
      bonusRate: 0,
      bonusPay: 0,
    };
  }

  return {
    qualified: true,
    xValue: x,
    revenue: rev,
    tier,
    bonusRate,
    bonusPay: roundMoney(rev * bonusRate),
  };
}

function calculateBonusFromRate({ revenue = 0, bonusRate = 0 } = {}) {
  const rev = toMoney(revenue);
  const rate = normalizeRate(bonusRate);

  if (rev <= 0 || rate <= 0) return 0;
  return roundMoney(rev * rate);
}

/* -------------------------------------------------------------------------- */
/*                         Personal / leadership / director                   */
/* -------------------------------------------------------------------------- */

function calculatePersonalBonus(role = {}, xValue = 0, revenue = 0) {
  const x = toNumber(xValue);
  const rev = toMoney(revenue);
  const tier = getPersonalBonusTier(role, x);
  const bonusRate = getPersonalBonusRate(role, x);

  return {
    type: "personal",
    qualified: Boolean(tier && bonusRate > 0 && rev > 0),
    xValue: x,
    revenue: rev,
    tier,
    bonusRate,
    bonusPay: calculateBonusFromRate({ revenue: rev, bonusRate }),
  };
}

function calculateLeadershipBonus(role = {}, podX = 0, podRevenue = 0) {
  const x = toNumber(podX);
  const rev = toMoney(podRevenue);
  const tier = getLeadershipBonusTier(role, x);
  const bonusRate = getLeadershipBonusRate(role, x);

  return {
    type: "leadership",
    qualified: Boolean(tier && bonusRate > 0 && rev > 0),
    xValue: x,
    revenue: rev,
    tier,
    bonusRate,
    bonusPay: calculateBonusFromRate({ revenue: rev, bonusRate }),
  };
}

function calculateDirectorBonus(role = {}, orgX = 0, orgRevenue = 0) {
  const x = toNumber(orgX);
  const rev = toMoney(orgRevenue);
  const tier = getDirectorBonusTier(role, x);
  const bonusRate = getDirectorBonusRate(role, x);

  return {
    type: "director",
    qualified: Boolean(tier && bonusRate > 0 && rev > 0),
    xValue: x,
    revenue: rev,
    tier,
    bonusRate,
    bonusPay: calculateBonusFromRate({ revenue: rev, bonusRate }),
  };
}

/* -------------------------------------------------------------------------- */
/*                  Current PERSONAL bonus snapshot for app stats             */
/* -------------------------------------------------------------------------- */

/**
 * Returns the two fields you want to write into stats docs:
 * - currentBonusRate
 * - estimatedCurrentBonus
 *
 * Meaning:
 * - Development Camp: fixed completion payout, no rate => currentBonusRate = 0
 * - All other roles: achieved personal bonus rate × revenue
 *
 * This is PERSONAL production only.
 * It does not mix in leadership or director bonus engines.
 */
function calculateCurrentPersonalBonusSnapshot(
  role = {},
  xValue = 0,
  revenue = 0
) {
  const x = toNumber(xValue);
  const rev = toMoney(revenue);

  if (isDevelopmentCampRole(role)) {
    const camp = calculateCampCompletionBonus(role, x);

    return {
      bonusType: "camp_completion",
      qualified: Boolean(camp.qualified),
      xValue: x,
      revenue: rev,
      currentBonusRate: 0,
      estimatedCurrentBonus: toMoney(camp.bonusPay || 0),
      tier: null,
      milestone: camp.milestone || null,
      detail: {
        bonusPay: toMoney(camp.bonusPay || 0),
        config: camp.config || null,
      },
    };
  }

  const personal = calculatePersonalBonus(role, x, rev);

  return {
    bonusType: "personal_rate",
    qualified: Boolean(personal.qualified),
    xValue: x,
    revenue: rev,
    currentBonusRate: normalizeRate(personal.bonusRate || 0),
    estimatedCurrentBonus: toMoney(personal.bonusPay || 0),
    tier: personal.tier || null,
    milestone: null,
    detail: {
      bonusRate: normalizeRate(personal.bonusRate || 0),
      bonusPay: toMoney(personal.bonusPay || 0),
    },
  };
}

/**
 * Small convenience helper when you only want the two flat fields.
 */
function getCurrentPersonalBonusFields(role = {}, xValue = 0, revenue = 0) {
  const snapshot = calculateCurrentPersonalBonusSnapshot(role, xValue, revenue);

  return {
    currentBonusRate: normalizeRate(snapshot.currentBonusRate || 0),
    estimatedCurrentBonus: toMoney(snapshot.estimatedCurrentBonus || 0),
  };
}

/* -------------------------------------------------------------------------- */
/*                       Development camp completion bonus                     */
/* -------------------------------------------------------------------------- */

function calculateCampCompletionBonus(role = {}, xValue = 0) {
  const x = toNumber(xValue);
  const config = getCampCompletionBonus(role);

  if (!isDevelopmentCampRole(role) || !config) {
    return {
      qualified: false,
      xValue: x,
      milestone: null,
      bonusPay: 0,
      config: null,
    };
  }

  // Supported shapes:
  // 1) [{ minX: 21000, payout: 800 }, ...]
  // 2) { tiers: [{ minX, payout }...] }
  // 3) direct number (rare/simple fallback)
  let milestones = [];

  if (Array.isArray(config)) {
    milestones = normalizeCampMilestones(config);
  } else if (isPlainObject(config) && Array.isArray(config.tiers)) {
    milestones = normalizeCampMilestones(config.tiers);
  } else if (typeof config === "number") {
    return {
      qualified: x > 0 && config > 0,
      xValue: x,
      milestone: x > 0 ? { minX: 0, payout: toMoney(config) } : null,
      bonusPay: x > 0 ? toMoney(config) : 0,
      config,
    };
  }

  const milestone = getHighestCampMilestone(milestones, x);
  const bonusPay = toMoney(milestone?.payout);

  return {
    qualified: Boolean(milestone && bonusPay > 0),
    xValue: x,
    milestone,
    bonusPay,
    config,
  };
}

function checkCampGraduation(role = {}, metrics = {}) {
  const rules = getCampGraduationRules(role);
  if (!isDevelopmentCampRole(role) || !isPlainObject(rules)) {
    return {
      qualified: false,
      checks: {},
      rules: {},
    };
  }

  const xValue = toNumber(metrics.xValue);
  const attendanceRate = toNumber(metrics.attendanceRate);
  const unapprovedAbsences = toNumber(metrics.unapprovedAbsences);
  const refundRate = normalizeRate(metrics.refundRate);
  const completedWeeks = toNumber(metrics.completedWeeks);
  const fullCompletion = Boolean(metrics.fullCompletion);

  const checks = {};

  if (rules.minimumX !== undefined) {
    checks.minimumX = xValue >= toNumber(rules.minimumX);
  }

  if (rules.minX !== undefined) {
    checks.minX = xValue >= toNumber(rules.minX);
  }

  if (rules.fullCompletion !== undefined) {
    checks.fullCompletion = Boolean(fullCompletion) === Boolean(rules.fullCompletion);
  }

  if (rules.completedWeeks !== undefined) {
    checks.completedWeeks = completedWeeks >= toNumber(rules.completedWeeks);
  }

  if (rules.minimumWeeks !== undefined) {
    checks.minimumWeeks = completedWeeks >= toNumber(rules.minimumWeeks);
  }

  if (rules.attendanceRate !== undefined) {
    checks.attendanceRate = attendanceRate >= normalizeRate(rules.attendanceRate);
  }

  if (rules.require100Attendance === true) {
    checks.require100Attendance = attendanceRate >= 1;
  }

  if (rules.maxUnapprovedAbsences !== undefined) {
    checks.maxUnapprovedAbsences =
      unapprovedAbsences <= toNumber(rules.maxUnapprovedAbsences);
  }

  if (rules.zeroUnapprovedAbsences === true) {
    checks.zeroUnapprovedAbsences = unapprovedAbsences === 0;
  }

  if (rules.maxRefundRate !== undefined) {
    checks.maxRefundRate = refundRate <= normalizeRate(rules.maxRefundRate);
  }

  const values = Object.values(checks);
  const qualified = values.length > 0 && values.every(Boolean);

  return {
    qualified,
    checks,
    rules: cloneObject(rules),
  };
}

/* -------------------------------------------------------------------------- */
/*                         Monthly status gated helpers                        */
/* -------------------------------------------------------------------------- */

function calculatePersonalBonusIfEligible({
  isOnBonus = false,
  role = {},
  xValue = 0,
  revenue = 0,
} = {}) {
  if (!isOnBonus) {
    return buildBlockedBonusResult("personal", xValue, revenue);
  }
  return calculatePersonalBonus(role, xValue, revenue);
}

function calculateLeadershipBonusIfEligible({
  isOnBonus = false,
  role = {},
  podX = 0,
  podRevenue = 0,
} = {}) {
  if (!isOnBonus) {
    return buildBlockedBonusResult("leadership", podX, podRevenue);
  }
  return calculateLeadershipBonus(role, podX, podRevenue);
}

function calculateDirectorBonusIfEligible({
  isOnBonus = false,
  role = {},
  orgX = 0,
  orgRevenue = 0,
} = {}) {
  if (!isOnBonus) {
    return buildBlockedBonusResult("director", orgX, orgRevenue);
  }
  return calculateDirectorBonus(role, orgX, orgRevenue);
}

/* -------------------------------------------------------------------------- */
/*                                   Utility                                  */
/* -------------------------------------------------------------------------- */

function getHighestTierFromList(tiers = [], xValue = 0) {
  const x = toNumber(xValue);
  const safeTiers = Array.isArray(tiers)
    ? tiers
        .map((tier) => {
          if (!isPlainObject(tier)) return null;
          return {
            ...cloneObject(tier),
            minX: toNumber(tier.minX),
            bonusRate: normalizeRate(tier.bonusRate),
          };
        })
        .filter(Boolean)
        .sort((a, b) => a.minX - b.minX)
    : [];

  let winner = null;
  for (const tier of safeTiers) {
    if (x >= tier.minX) {
      winner = tier;
    }
  }

  return winner;
}

function normalizeCampMilestones(list = []) {
  if (!Array.isArray(list)) return [];

  return list
    .map((item) => {
      if (!isPlainObject(item)) return null;

      const minX = toNumber(item.minX ?? item.x ?? item.thresholdX ?? 0);
      const payout = toMoney(
        item.payout ?? item.payoutAmount ?? item.amount ?? item.bonus ?? 0
      );

      return {
        ...cloneObject(item),
        minX,
        payout,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.minX - b.minX);
}

function getHighestCampMilestone(milestones = [], xValue = 0) {
  const x = toNumber(xValue);
  let winner = null;

  for (const milestone of milestones) {
    if (x >= milestone.minX) {
      winner = milestone;
    }
  }

  return winner;
}

function buildBlockedBonusResult(type, xValue, revenue) {
  return {
    type,
    qualified: false,
    xValue: toNumber(xValue),
    revenue: toMoney(revenue),
    tier: null,
    bonusRate: 0,
    bonusPay: 0,
    blockedByStatus: true,
  };
}

function normalizeRate(value) {
  const n = toNumber(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1 ? roundRate(n / 100) : roundRate(n);
}

function roundRate(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1000000) / 1000000;
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function toMoney(value) {
  return roundMoney(toNumber(value));
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

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneObject(value) {
  if (!isPlainObject(value)) return {};
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  calculateRateBonus,
  calculateBonusFromRate,

  calculatePersonalBonus,
  calculateLeadershipBonus,
  calculateDirectorBonus,

  calculateCurrentPersonalBonusSnapshot,
  getCurrentPersonalBonusFields,

  calculateCampCompletionBonus,
  checkCampGraduation,

  calculatePersonalBonusIfEligible,
  calculateLeadershipBonusIfEligible,
  calculateDirectorBonusIfEligible,

  getHighestTierFromList,
};
