"use strict";

const nodemailer = require("nodemailer");

const { appendRoleHistoryEntry } = require("./roleResolver");
const { recomputeRepCurrentStats } = require("./repCurrentStats");
const { recomputeLeaderCurrentStats } = require("./leaderCurrentStats");
const { recomputeRepCareerStats } = require("./repCareerStats");
const { recomputeLeaderCareerStats } = require("./leaderCareerStats");
const { recomputeLeaderboards } = require("./leaderboards");
const {
  canonicalHierarchyForRole,
  validateRepHierarchy,
} = require("./repHierarchy");

module.exports = {
  scanPromotionQualifications,
  activateApprovedPromotions,
};

/* -------------------------------------------------------------------------- */
/*                              PUBLIC FUNCTIONS                              */
/* -------------------------------------------------------------------------- */

async function scanPromotionQualifications(db, admin, logger, options = {}) {
  const now = toDateOrNull(options.now) || new Date();
  const notificationEmails = normalizeEmailList(
    options.notificationEmails || ["curator@experiencecalgary.ca"]
  );

  logger.info("promotions.scan started", {
    now: now.toISOString(),
    notificationEmails,
  });

  const [
    rolesSnap,
    repsSnap,
    usersSnap,
    repCareerStatsSnap,
    leaderCareerStatsSnap,
    ordersSnap,
  ] = await Promise.all([
    db.collection("roles").get(),
    db.collection("reps").where("active", "==", true).get(),
    db.collection("users").where("userType", "==", "rep").where("active", "==", true).get(),
    db.collection("repCareerStats").get(),
    db.collection("leaderCareerStats").get(),
    db.collection("orderIngest").get(),
  ]);

  const roleMap = buildRoleMap(rolesSnap);
  const repMap = buildDocMapById(repsSnap);
  const userMapByRepId = buildUserMapByRepId(usersSnap);
  const repCareerStatsMap = buildDocMapById(repCareerStatsSnap);
  const leaderCareerStatsMap = buildDocMapById(leaderCareerStatsSnap);
  const recentSixWeekStatsMap = buildRecentSixWeekStatsByRepId(ordersSnap, now);

  let scannedCount = 0;
  let newlyQualifiedCount = 0;
  let emailedCount = 0;
  let alreadyOpenCount = 0;
  let noNextRoleCount = 0;

  for (const repId of Object.keys(repMap)) {
    scannedCount += 1;

    const rep = repMap[repId] || {};
    const user = userMapByRepId[repId] || {};
    const currentRoleId = String(
      rep.currentRoleId || user.currentRoleId || ""
    ).trim();

    if (!currentRoleId) {
      logger.warn("promotions.scan missing currentRoleId", { repId });
      continue;
    }

    const currentRole = roleMap[currentRoleId] || null;
    if (!currentRole) {
      logger.warn("promotions.scan missing current role config", {
        repId,
        currentRoleId,
      });
      continue;
    }

    const promotionRules = cleanObject(currentRole.promotionRules);
    const nextRoleId = String(promotionRules.nextRoleId || "").trim();

    if (!nextRoleId) {
      noNextRoleCount += 1;
      continue;
    }

    const nextRole = roleMap[nextRoleId] || null;
    if (!nextRole) {
      logger.warn("promotions.scan missing next role config", {
        repId,
        currentRoleId,
        nextRoleId,
      });
      continue;
    }

    const repCareerStats = repCareerStatsMap[repId] || {};
    const leaderCareerStats = leaderCareerStatsMap[repId] || {};
    const monthlyQualificationSummary =
      await getMonthlyQualificationSummaryForRep(db, repId);
    const recentSixWeekStats = recentSixWeekStatsMap[repId] || {
      x: 0,
      revenue: 0,
      salesCount: 0,
    };

    const identity = {
      repId,
      rep,
      user,
      fullName: String(user.fullName || rep.fullName || "").trim(),
      firebaseUid: String(user.uid || rep.firebaseUid || "").trim(),
      userDocId: String(user.docId || "").trim(),
      repDocId: String(rep.docId || repId).trim(),
      currentRoleId,
    };

    const evaluation = evaluatePromotionReadiness({
      identity,
      currentRole,
      nextRole,
      promotionRules,
      repCareerStats,
      leaderCareerStats,
      monthlyQualificationSummary,
      recentSixWeekStats,
    });

    if (!evaluation.isQualified) {
      continue;
    }

    const repRef = db.collection("reps").doc(repId);
    const existingOpen = await findExistingOpenPromotionForTarget(repRef, nextRoleId);

    if (existingOpen) {
      alreadyOpenCount += 1;
      continue;
    }

    const effectiveDate = getNextMonthStart(now);
    const promotionRef = repRef.collection("promotions").doc();

    const promotionPayload = {
      repId,
      firebaseUid: identity.firebaseUid || "",
      userDocId: identity.userDocId || "",
      repDocId: identity.repDocId || repId,

      fromRoleId: currentRoleId,
      fromRoleName: getRoleDisplayName(currentRole),
      toRoleId: nextRoleId,
      toRoleName: getRoleDisplayName(nextRole),

      qualifiedDate: admin.firestore.Timestamp.fromDate(now),
      effectiveDate: admin.firestore.Timestamp.fromDate(effectiveDate),

      status: "qualified_pending_review",
      approvalRequired: true,

      qualificationSummary: evaluation.summary,
      qualificationMetrics: evaluation.metrics,
      qualificationChecks: evaluation.checks,

      emailSentAt: null,
      approvedAt: null,
      approvedBy: null,
      approvalNotes: "",
      declinedAt: null,
      declinedBy: null,
      declineReason: "",

      source: "daily_scan",
      activationMode: "scheduled_or_manual",

      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await promotionRef.set(promotionPayload, { merge: true });
    newlyQualifiedCount += 1;

    const emailSent = await sendPromotionQualificationEmail({
      logger,
      STAFF_MAIL_USER: options.STAFF_MAIL_USER,
      STAFF_MAIL_APP_PASSWORD: options.STAFF_MAIL_APP_PASSWORD,
      toEmails: notificationEmails,
      promotion: {
        id: promotionRef.id,
        ...promotionPayload,
      },
      identity,
    });

    if (emailSent) {
      emailedCount += 1;
      await promotionRef.set(
        {
          emailSentAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
  }

  logger.info("promotions.scan completed", {
    scannedCount,
    newlyQualifiedCount,
    emailedCount,
    alreadyOpenCount,
    noNextRoleCount,
  });

  return {
    scannedCount,
    newlyQualifiedCount,
    emailedCount,
    alreadyOpenCount,
    noNextRoleCount,
  };
}

async function activateApprovedPromotions(db, admin, logger, options = {}) {
  const now = toDateOrNull(options.now) || new Date();
  const dryRun = Boolean(options.dryRun);
  const limit = toNumber(options.limit || 0);

  logger.info("promotions.activate started", {
    now: now.toISOString(),
    dryRun,
    limit,
  });

  const snap = await db
    .collectionGroup("promotions")
    .where("status", "==", "approved_pending_activation")
    .get();

  let candidates = snap.docs
    .map((doc) => ({ id: doc.id, ref: doc.ref, data: doc.data() || {} }))
    .filter((row) => {
      const effectiveDate = toDateOrNull(row.data.effectiveDate);
      if (!effectiveDate) return true;
      return effectiveDate.getTime() <= now.getTime();
    })
    .sort((a, b) => {
      const aDate = toDateOrNull(a.data.effectiveDate);
      const bDate = toDateOrNull(b.data.effectiveDate);
      return (aDate ? aDate.getTime() : 0) - (bDate ? bDate.getTime() : 0);
    });

  if (limit > 0) {
    candidates = candidates.slice(0, limit);
  }

  let activatedCount = 0;
  let skippedCount = 0;
  const affectedRepIds = new Set();

  for (const candidate of candidates) {
    const promotion = candidate.data || {};
    const repId = String(promotion.repId || "").trim();
    const toRoleId = String(promotion.toRoleId || "").trim();

    if (!repId || !toRoleId) {
      skippedCount += 1;
      logger.warn("promotions.activate skipped invalid promotion", {
        promotionId: candidate.id,
        repId,
        toRoleId,
      });
      continue;
    }

    if (dryRun) {
      activatedCount += 1;
      affectedRepIds.add(repId);
      continue;
    }

    await activateSinglePromotion({
      db,
      admin,
      logger,
      promotionRef: candidate.ref,
      promotionId: candidate.id,
      promotion,
      activatedAt: now,
    });

    activatedCount += 1;
    affectedRepIds.add(repId);
  }

  if (!dryRun && activatedCount > 0) {
    await recomputeDerivedStatsAfterPromotions(db, admin, logger);
  }

  logger.info("promotions.activate completed", {
    activatedCount,
    skippedCount,
    affectedRepIds: Array.from(affectedRepIds),
    dryRun,
  });

  return {
    activatedCount,
    skippedCount,
    affectedRepIds: Array.from(affectedRepIds),
    dryRun,
  };
}

/* -------------------------------------------------------------------------- */
/*                              ACTIVATE ONE                                  */
/* -------------------------------------------------------------------------- */

async function activateSinglePromotion({
  db,
  admin,
  logger,
  promotionRef,
  promotionId,
  promotion,
  activatedAt,
}) {
  const repId = String(promotion.repId || "").trim();
  const fromRoleId = String(promotion.fromRoleId || "").trim();
  const toRoleId = String(promotion.toRoleId || "").trim();
  const effectiveDate =
    toDateOrNull(promotion.effectiveDate) || toDateOrNull(activatedAt) || new Date();

  const [roleSnap, repSnap] = await Promise.all([
    db.collection("roles").doc(toRoleId).get(),
    db.collection("reps").doc(repId).get(),
  ]);

  if (!roleSnap.exists) {
    throw new Error(`Target role ${toRoleId} not found for promotion ${promotionId}`);
  }

  const role = roleSnap.data() || {};
  const roleName = getRoleDisplayName(role);
  const repDoc = repSnap.exists ? repSnap.data() || {} : {};
  const bonusGrace = buildPromotionBonusGrace({
    admin,
    role,
    activatedAt,
  });

  let userRef = null;
  if (promotion.firebaseUid) {
    userRef = db.collection("users").doc(String(promotion.firebaseUid));
  } else if (repDoc.firebaseUid) {
    userRef = db.collection("users").doc(String(repDoc.firebaseUid));
  } else {
    const userSnap = await db
      .collection("users")
      .where("repId", "==", repId)
      .limit(1)
      .get();
    if (!userSnap.empty) {
      userRef = userSnap.docs[0].ref;
    }
  }

  const flags = deriveRoleStateFlags(role, repDoc);
  const hierarchy = canonicalHierarchyForRole({
    repId,
    roleId: toRoleId,
    programDirectorRepId: repDoc.programDirectorRepId,
    directorRepId: repDoc.directorRepId,
  });
  await validateRepHierarchy(db, {
    repId,
    currentRoleId: toRoleId,
    ...hierarchy,
  });

  await appendRoleHistoryEntry(db, admin, repId, {
    roleId: toRoleId,
    effectiveStart: effectiveDate,
    source: "promotion",
    reason: `Promotion activated from ${fromRoleId || "unknown"} to ${toRoleId}`,
    createdBy: "system",
    closePreviousEntry: true,
  });

  await db.collection("reps").doc(repId).set(
    {
      currentRoleId: toRoleId,
      currentRoleName: roleName,
      roleStartDate: admin.firestore.Timestamp.fromDate(effectiveDate),
      ...hierarchy,

      isLeader: flags.isLeader,
      canApproveTimeOff: flags.canApproveTimeOff,
      canManageSchedule: flags.canManageSchedule,
      canReviewPayroll: flags.canReviewPayroll,

      ...bonusGrace,

      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  if (userRef) {
    await userRef.set(
      {
        currentRoleId: toRoleId,
        currentRoleName: roleName,
        roleStartDate: admin.firestore.Timestamp.fromDate(effectiveDate),
        ...hierarchy,

        isLeader: flags.isLeader,
        canApproveTimeOff: flags.canApproveTimeOff,
        canManageSchedule: flags.canManageSchedule,
        canReviewPayroll: flags.canReviewPayroll,

        ...bonusGrace,

        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }

  await promotionRef.set(
    {
      status: "activated",
      appliedRoleId: toRoleId,
      appliedRoleName: roleName,
      activatedAt: admin.firestore.Timestamp.fromDate(activatedAt),
      bonusGraceStartDate: bonusGrace.bonusGraceStartDate,
      bonusGraceThrough: bonusGrace.bonusGraceThrough,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  logger.info("promotions.activate single completed", {
    promotionId,
    repId,
    fromRoleId,
    toRoleId,
  });
}

/* -------------------------------------------------------------------------- */
/*                           EVALUATION LOGIC                                 */
/* -------------------------------------------------------------------------- */

function evaluatePromotionReadiness({
  identity,
  currentRole,
  nextRole,
  promotionRules,
  repCareerStats,
  leaderCareerStats,
  monthlyQualificationSummary,
  recentSixWeekStats,
}) {
  const currentRoleId = String(identity.currentRoleId || "").trim();
  const nextRoleId = String(nextRole.roleId || nextRole.id || "").trim();

  const checks = [];
  const metrics = buildBaseMetrics({
    identity,
    currentRole,
    nextRole,
    repCareerStats,
    leaderCareerStats,
    monthlyQualificationSummary,
    recentSixWeekStats,
  });

  const campGraduationRules = cleanObject(currentRole.campGraduationRules);
  const personalOnBonusRules = cleanObject(currentRole.personalOnBonusRules);
  const leadershipOnBonusRules = cleanObject(currentRole.leadershipOnBonusRules);

  if (currentRoleId === "ROLE1") {
    const minX = toNumber(campGraduationRules.minXRequired || 15000);
    const maxRefundRate = normalizeRate(campGraduationRules.maxRefundRate || 0.07);
    const maxUnapprovedAbsences = toNumber(
      campGraduationRules.maxUnapprovedAbsences ?? 0
    );

    checks.push(
      buildMinCheck("careerX", metrics.careerX, minX),
      buildMaxCheck("refundRate", metrics.refundRate, maxRefundRate),
      buildMaxCheck(
        "unapprovedAbsences",
        metrics.unapprovedAbsences,
        maxUnapprovedAbsences
      )
    );

    // This is the one manual-ish requirement in ROLE1 graduation text.
    // We treat it as informational, not blocking automation beyond the measurable items.
    checks.push(
      buildInfoCheck("campCompletionManualReview", 1, 1, true)
    );
  } else {
    const qualifiedMonthsRequired = toNumber(
      promotionRules.qualifiedMonthsRequired || 0
    );
    const qualifiedMonthsType = String(
      promotionRules.qualifiedMonthsType || ""
    ).trim();

    const careerXRequired = toNumber(
      promotionRules.careerXRequired || 0
    );

    if (careerXRequired > 0) {
      checks.push(
        buildMinCheck("careerX", metrics.careerX, careerXRequired)
      );
    }

    if (qualifiedMonthsRequired > 0) {
      const actualQualifiedMonths = getQualifiedMonthsForType(
        qualifiedMonthsType,
        monthlyQualificationSummary
      );

      checks.push(
        buildMinCheck(
          `qualifiedMonths:${qualifiedMonthsType || "default"}`,
          actualQualifiedMonths,
          qualifiedMonthsRequired
        )
      );
    }

    if (promotionRules.firstCodedRepRequired === true) {
      const firstCodedRepCount = toNumber(leaderCareerStats.firstCodedRepCount || 0);
      checks.push(
        buildMinCheck("firstCodedRepCount", firstCodedRepCount, 1)
      );

      // Keep admin review required for AMP → PD even if measurable checks pass.
      checks.push(
        buildInfoCheck("leadershipReadinessManualReview", 1, 1, true)
      );
    }

    if (toNumber(promotionRules.recent6WeekXRequired || 0) > 0) {
      checks.push(
        buildMinCheck(
          "recent6WeekX",
          metrics.recentSixWeekX,
          toNumber(promotionRules.recent6WeekXRequired || 0)
        )
      );
    }

    if (toNumber(promotionRules.activePdPodsRequired || 0) > 0) {
      checks.push(
        buildMinCheck(
          "activePdPods",
          metrics.activePdCount,
          toNumber(promotionRules.activePdPodsRequired || 0)
        )
      );
    }
  }

  const standardsSource = selectStandardsSource({
    currentRoleId,
    campGraduationRules,
    personalOnBonusRules,
    leadershipOnBonusRules,
  });

  const standardsMaxRefundRate = normalizeRate(
    standardsSource.maxRefundRate ||
      inferRefundRateThresholdFromCurrentRole(currentRole)
  );
  const standardsMaxUnapprovedAbsences = toNumber(
    standardsSource.maxUnapprovedAbsences ?? 0
  );

  if (!checks.some((c) => c.name === "refundRate")) {
    checks.push(
      buildMaxCheck("refundRate", metrics.refundRate, standardsMaxRefundRate)
    );
  }

  if (!checks.some((c) => c.name === "unapprovedAbsences")) {
    checks.push(
      buildMaxCheck(
        "unapprovedAbsences",
        metrics.unapprovedAbsences,
        standardsMaxUnapprovedAbsences
      )
    );
  }

  const blockingChecks = checks.filter((c) => !c.infoOnly);
  const isQualified = blockingChecks.every((c) => c.passed);

  const summary = [
    `${getRoleDisplayName(currentRole)} → ${getRoleDisplayName(nextRole)}`,
    `Career X: ${metrics.careerX}`,
    `Refund Rate: ${metrics.refundRate}`,
    `Unapproved Absences: ${metrics.unapprovedAbsences}`,
    `Personal Qualified Months: ${metrics.personalQualifiedMonths}`,
    `Leadership Qualified Months: ${metrics.leadershipQualifiedMonths}`,
    `Director Qualified Months: ${metrics.directorQualifiedMonths}`,
    `Recent 6 Week X: ${metrics.recentSixWeekX}`,
    `Active PD Count: ${metrics.activePdCount}`,
  ].join(" | ");

  return {
    isQualified,
    summary,
    metrics: {
      ...metrics,
      qualifiedMonthsType: String(promotionRules.qualifiedMonthsType || "").trim(),
    },
    checks,
  };
}

function buildBaseMetrics({
  repCareerStats,
  leaderCareerStats,
  monthlyQualificationSummary,
  recentSixWeekStats,
  currentRole,
  nextRole,
}) {
  return {
    currentRoleName: getRoleDisplayName(currentRole),
    nextRoleName: getRoleDisplayName(nextRole),

    careerX: round2(
      toNumber(repCareerStats.careerX || repCareerStats.lifetimeX || 0)
    ),
    refundRate: normalizeRate(
      repCareerStats.refundRate ||
        monthlyQualificationSummary.latestRefundRate ||
        0
    ),
    unapprovedAbsences: toNumber(
      monthlyQualificationSummary.latestUnapprovedAbsences || 0
    ),

    personalQualifiedMonths: toNumber(
      monthlyQualificationSummary.personalQualifiedMonths || 0
    ),
    leadershipQualifiedMonths: toNumber(
      monthlyQualificationSummary.leadershipQualifiedMonths || 0
    ),
    directorQualifiedMonths: toNumber(
      monthlyQualificationSummary.directorQualifiedMonths || 0
    ),

    recentSixWeekX: round2(toNumber(recentSixWeekStats.x || 0)),
    recentSixWeekRevenue: round2(toNumber(recentSixWeekStats.revenue || 0)),
    recentSixWeekSalesCount: toNumber(recentSixWeekStats.salesCount || 0),

    activePdCount: toNumber(leaderCareerStats.activePdCount || 0),
    qualifiedPdCount: toNumber(monthlyQualificationSummary.latestQualifiedPdCount || 0),
  };
}

function selectStandardsSource({
  currentRoleId,
  campGraduationRules,
  personalOnBonusRules,
  leadershipOnBonusRules,
}) {
  if (currentRoleId === "ROLE1") return campGraduationRules;
  if (["ROLE7", "ROLE8", "ROLE9", "ROLE10", "ROLE11"].includes(currentRoleId)) {
    return leadershipOnBonusRules;
  }
  return personalOnBonusRules;
}

function getQualifiedMonthsForType(type, monthlyQualificationSummary) {
  const normalized = String(type || "").trim().toLowerCase();

  if (normalized === "on_personal_bonus") {
    return toNumber(monthlyQualificationSummary.personalQualifiedMonths || 0);
  }

  if (normalized === "on_leadership_bonus") {
    return toNumber(monthlyQualificationSummary.leadershipQualifiedMonths || 0);
  }

  if (normalized === "on_director_bonus") {
    return toNumber(monthlyQualificationSummary.directorQualifiedMonths || 0);
  }

  return toNumber(monthlyQualificationSummary.personalQualifiedMonths || 0);
}

/* -------------------------------------------------------------------------- */
/*                      MONTHLY QUALIFICATION SUMMARY                          */
/* -------------------------------------------------------------------------- */

async function getMonthlyQualificationSummaryForRep(db, repId) {
  const snap = await db
    .collection("reps")
    .doc(String(repId))
    .collection("monthlyQualifications")
    .get();

  const rows = [];
  snap.forEach((doc) => {
    const data = doc.data() || {};
    rows.push({
      id: doc.id,
      monthKey: String(data.monthKey || doc.id || ""),
      personalBonusStatus: String(data.personalBonusStatus || "").trim(),
      leadershipBonusStatus: String(data.leadershipBonusStatus || "").trim(),
      directorBonusStatus: String(data.directorBonusStatus || "").trim(),
      refundRate: normalizeRate(data.refundRate || 0),
      unapprovedAbsences: toNumber(data.unapprovedAbsences || 0),
      qualifiedPdIds: Array.isArray(data.qualifiedPdIds) ? data.qualifiedPdIds : [],
      calculatedAt: toDateOrNull(data.calculatedAt || data.updatedAt),
    });
  });

  rows.sort((a, b) => String(a.monthKey).localeCompare(String(b.monthKey)));

  const latest = rows.length ? rows[rows.length - 1] : null;

  return {
    personalQualifiedMonths: rows.filter((r) => r.personalBonusStatus === "onBonus")
      .length,
    leadershipQualifiedMonths: rows.filter(
      (r) => r.leadershipBonusStatus === "onBonus"
    ).length,
    directorQualifiedMonths: rows.filter(
      (r) => r.directorBonusStatus === "onBonus"
    ).length,
    latestRefundRate: latest ? normalizeRate(latest.refundRate || 0) : 0,
    latestUnapprovedAbsences: latest ? toNumber(latest.unapprovedAbsences || 0) : 0,
    latestQualifiedPdCount: latest ? latest.qualifiedPdIds.length : 0,
  };
}

/* -------------------------------------------------------------------------- */
/*                                   EMAIL                                    */
/* -------------------------------------------------------------------------- */

async function sendPromotionQualificationEmail({
  logger,
  STAFF_MAIL_USER,
  STAFF_MAIL_APP_PASSWORD,
  toEmails,
  promotion,
  identity,
}) {
  const mailUser = readSecretValue(STAFF_MAIL_USER);
  const mailPass = readSecretValue(STAFF_MAIL_APP_PASSWORD);

  if (!mailUser || !mailPass) {
    logger.warn("promotions email skipped: mailer secrets missing");
    return false;
  }

  const recipients = normalizeEmailList(toEmails);
  if (!recipients.length) {
    logger.warn("promotions email skipped: no recipients");
    return false;
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: mailUser,
      pass: mailPass,
    },
  });

  const repName = String(
    identity.fullName || identity.rep?.fullName || identity.user?.fullName || promotion.repId || "Unknown Rep"
  ).trim();

  const checks = Array.isArray(promotion.qualificationChecks)
    ? promotion.qualificationChecks
    : [];

  const checksText = checks
    .map((row) => {
      const requirementLabel = row.mode === "max" ? `max ${row.required}` : `min ${row.required}`;
      const tag = row.infoOnly ? "INFO" : row.passed ? "PASSED" : "FAILED";
      return `- ${row.name}: actual ${row.actual} | required ${requirementLabel} | ${tag}`;
    })
    .join("\n");

  const subject =
    `Promotion Qualification Alert — ${repName} — ` +
    `${promotion.toRoleName || promotion.toRoleId || "Promotion"}`;

  const text = `A rep has qualified for promotion review.

Rep: ${repName}
Rep ID: ${promotion.repId || ""}
Current Role: ${promotion.fromRoleName || promotion.fromRoleId || ""}
Qualified Next Role: ${promotion.toRoleName || promotion.toRoleId || ""}
Promotion Record ID: ${promotion.id || ""}
Qualified Date: ${formatDateForEmail(promotion.qualifiedDate)}
Planned Effective Date: ${formatDateForEmail(promotion.effectiveDate)}
Status: ${promotion.status || ""}

Summary:
${promotion.qualificationSummary || ""}

Checks:
${checksText || "- No detailed checks recorded"}

To approve:
Change this promotion document status to:
approved_pending_activation

Firestore Path:
reps/${promotion.repId}/promotions/${promotion.id}
`;

  const htmlChecks = checks
    .map((row) => {
      const requirementLabel =
        row.mode === "max" ? `max ${escapeHtml(String(row.required))}` : `min ${escapeHtml(String(row.required))}`;
      const tag = row.infoOnly ? "INFO" : row.passed ? "PASSED" : "FAILED";

      return `<li><strong>${escapeHtml(String(row.name))}</strong>: actual ${escapeHtml(
        String(row.actual)
      )} | required ${requirementLabel} | <strong>${tag}</strong></li>`;
    })
    .join("");

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;color:#111;">
    <h2>Promotion Qualification Alert</h2>
    <p>A rep has qualified for promotion review.</p>

    <p>
      <strong>Rep:</strong> ${escapeHtml(repName)}<br/>
      <strong>Rep ID:</strong> ${escapeHtml(String(promotion.repId || ""))}<br/>
      <strong>Current Role:</strong> ${escapeHtml(
        String(promotion.fromRoleName || promotion.fromRoleId || "")
      )}<br/>
      <strong>Qualified Next Role:</strong> ${escapeHtml(
        String(promotion.toRoleName || promotion.toRoleId || "")
      )}<br/>
      <strong>Promotion Record ID:</strong> ${escapeHtml(String(promotion.id || ""))}<br/>
      <strong>Qualified Date:</strong> ${escapeHtml(
        formatDateForEmail(promotion.qualifiedDate)
      )}<br/>
      <strong>Planned Effective Date:</strong> ${escapeHtml(
        formatDateForEmail(promotion.effectiveDate)
      )}<br/>
      <strong>Status:</strong> ${escapeHtml(String(promotion.status || ""))}
    </p>

    <p><strong>Summary:</strong><br/>${escapeHtml(
      String(promotion.qualificationSummary || "")
    )}</p>

    <p><strong>Checks:</strong></p>
    <ul>
      ${htmlChecks || "<li>No detailed checks recorded</li>"}
    </ul>

    <p>
      To approve, change this promotion document status to:<br/>
      <strong>approved_pending_activation</strong>
    </p>

    <p>
      Firestore Path:<br/>
      <code>reps/${escapeHtml(String(promotion.repId || ""))}/promotions/${escapeHtml(
        String(promotion.id || "")
      )}</code>
    </p>
  </div>
  `;

  await transporter.sendMail({
    from: mailUser,
    to: recipients.join(", "),
    subject,
    text,
    html,
  });

  return true;
}

/* -------------------------------------------------------------------------- */
/*                         RECOMPUTE DERIVED DOCS                             */
/* -------------------------------------------------------------------------- */

async function recomputeDerivedStatsAfterPromotions(db, admin, logger) {
  logger.info("promotions.recomputeDerivedStats started");

  await recomputeRepCurrentStats(db, admin, logger);
  await recomputeLeaderCurrentStats(db, admin, logger);
  await recomputeRepCareerStats(db, admin, logger);
  await recomputeLeaderCareerStats(db, admin, logger);
  await recomputeLeaderboards(db, admin, logger);

  logger.info("promotions.recomputeDerivedStats completed");
}

/* -------------------------------------------------------------------------- */
/*                                  HELPERS                                   */
/* -------------------------------------------------------------------------- */

function buildRoleMap(rolesSnap) {
  const map = {};
  rolesSnap.forEach((doc) => {
    const data = doc.data() || {};
    const roleId = String(data.roleId || doc.id || "").trim();
    if (!roleId) return;
    map[roleId] = { id: doc.id, ...data };
  });
  return map;
}

function buildDocMapById(snap) {
  const map = {};
  snap.forEach((doc) => {
    map[String(doc.id)] = { docId: doc.id, ...(doc.data() || {}) };
  });
  return map;
}

function buildUserMapByRepId(usersSnap) {
  const map = {};
  usersSnap.forEach((doc) => {
    const data = doc.data() || {};
    const repId = String(data.repId || "").trim();
    if (!repId) return;
    map[repId] = { docId: doc.id, ...(data || {}) };
  });
  return map;
}

function buildRecentSixWeekStatsByRepId(ordersSnap, now) {
  const start = new Date(now);
  start.setDate(start.getDate() - 42);
  start.setHours(0, 0, 0, 0);

  const map = {};

  ordersSnap.forEach((doc) => {
    const row = doc.data() || {};
    if (isRefundedOrder(row)) return;

    const repId = String(row.salesRepId || row.repId || "").trim();
    if (!repId) return;

    const paidAt =
      toDateOrNull(row.datePaid) ||
      toDateOrNull(row.paidAt) ||
      toDateOrNull(row.orderDateTime) ||
      toDateOrNull(row.createdAt);

    if (!paidAt) return;
    if (paidAt < start || paidAt > now) return;

    if (!map[repId]) {
      map[repId] = { x: 0, revenue: 0, salesCount: 0 };
    }

    map[repId].x += toNumber(row.xValue || 0);
    map[repId].revenue += toNumber(row.revenue || 0);
    map[repId].salesCount += 1;
  });

  Object.keys(map).forEach((repId) => {
    map[repId].x = round2(map[repId].x);
    map[repId].revenue = round2(map[repId].revenue);
  });

  return map;
}

async function findExistingOpenPromotionForTarget(repRef, toRoleId) {
  const snap = await repRef.collection("promotions").get();

  const openStatuses = new Set([
    "qualified_pending_review",
    "approved_pending_activation",
  ]);

  let existing = null;

  snap.forEach((doc) => {
    if (existing) return;

    const row = doc.data() || {};
    const status = String(row.status || "").trim();
    const target = String(row.toRoleId || "").trim();

    if (target === String(toRoleId || "").trim() && openStatuses.has(status)) {
      existing = {
        id: doc.id,
        ref: doc.ref,
        data: row,
      };
    }
  });

  return existing;
}

function deriveRoleStateFlags(role = {}, existing = {}) {
  const roleId = String(role.roleId || "").trim();
  const roleRank = toNumber(role.roleRank || 0);
  const leadershipEligible = Boolean(role.leadershipEligible);

  const isLeader =
    leadershipEligible ||
    roleRank >= 7 ||
    ["ROLE7", "ROLE8", "ROLE9", "ROLE10", "ROLE11"].includes(roleId);

  return {
    isLeader,
    canApproveTimeOff: isLeader ? true : Boolean(existing.canApproveTimeOff),
    canManageSchedule: isLeader ? true : Boolean(existing.canManageSchedule),
    canReviewPayroll: roleRank >= 8 ? true : Boolean(existing.canReviewPayroll),
  };
}

function getRoleDisplayName(role = {}) {
  return String(role.displayName || role.roleName || role.roleId || "").trim();
}

function inferRefundRateThresholdFromCurrentRole(role = {}) {
  const roleId = String(role.roleId || "").trim();
  if (["ROLE4", "ROLE5", "ROLE7", "ROLE8", "ROLE9", "ROLE10", "ROLE11"].includes(roleId)) {
    return 0.05;
  }
  return 0.07;
}

function buildMinCheck(name, actual, required) {
  return {
    name: String(name || ""),
    mode: "min",
    actual: normalizeCheckNumber(actual),
    required: normalizeCheckNumber(required),
    passed: normalizeCheckNumber(actual) >= normalizeCheckNumber(required),
    infoOnly: false,
  };
}

function buildMaxCheck(name, actual, required) {
  return {
    name: String(name || ""),
    mode: "max",
    actual: normalizeCheckNumber(actual),
    required: normalizeCheckNumber(required),
    passed: normalizeCheckNumber(actual) <= normalizeCheckNumber(required),
    infoOnly: false,
  };
}

function buildInfoCheck(name, actual, required, passed) {
  return {
    name: String(name || ""),
    mode: "info",
    actual: normalizeCheckNumber(actual),
    required: normalizeCheckNumber(required),
    passed: Boolean(passed),
    infoOnly: true,
  };
}

function normalizeCheckNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

function normalizeEmailList(input) {
  const list = Array.isArray(input) ? input : [input];
  return list
    .map((v) => String(v || "").trim().toLowerCase())
    .filter(Boolean);
}

function readSecretValue(secretMaybe) {
  if (!secretMaybe) return "";
  if (typeof secretMaybe === "string") return secretMaybe;
  if (typeof secretMaybe.value === "function") {
    return String(secretMaybe.value() || "").trim();
  }
  return "";
}

function cleanObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function isRefundedOrder(order = {}) {
  const status = String(order.orderStatus || order.status || "")
    .trim()
    .toLowerCase();
  return status === "refunded";
}

function formatDateForEmail(value) {
  const d = toDateOrNull(value);
  if (!d) return "";
  return d.toISOString().slice(0, 10);
}

function toDateOrNull(value) {
  if (!value) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value?.toDate === "function") {
    const d = value.toDate();
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;

  const cleaned = String(value).replace(/[%,$\s]/g, "").trim();
  if (!cleaned) return 0;

  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeRate(value) {
  const n = toNumber(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1 ? round4(n / 100) : round4(n);
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function round4(value) {
  return Math.round(Number(value || 0) * 10000) / 10000;
}

function getNextMonthStart(now) {
  return new Date(
    now.getFullYear(),
    now.getMonth() + 1,
    1,
    0,
    0,
    0,
    0
  );
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildPromotionBonusGrace({ admin, role = {}, activatedAt }) {
  const graceStart = toDateOrNull(activatedAt) || new Date();
  const graceThrough = new Date(
    graceStart.getFullYear(),
    graceStart.getMonth() + 2,
    0,
    23,
    59,
    59,
    999
  );

  const roleId = String(role.roleId || "").trim();
  const roleRank = toNumber(role.roleRank || 0);
  const isLeadershipRole =
    Boolean(role.leadershipEligible) ||
    roleRank >= 7 ||
    ["ROLE7", "ROLE8", "ROLE9", "ROLE10", "ROLE11"].includes(roleId);

  const reason =
    "New role promotion grace period through the end of the first full calendar month";

  const update = {
    personalBonusStatus: "onBonus",
    personalBonusReason: reason,
    inNewRoleGracePeriod: true,
    bonusGraceStartDate: admin.firestore.Timestamp.fromDate(graceStart),
    bonusGraceThrough: admin.firestore.Timestamp.fromDate(graceThrough),
  };

  if (isLeadershipRole) {
    update.leadershipBonusStatus = "onBonus";
    update.leadershipBonusReason = reason;
  }

  return update;
}
