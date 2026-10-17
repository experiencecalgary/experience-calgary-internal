module.exports = {
  createMonthlyBonusSnapshot,
};

async function createMonthlyBonusSnapshot(db, admin, logger) {
  try {
    return await createMonthlyBonusSnapshotRun(db, admin, logger);
  } catch (error) {
    const bonusMonth = getPreviousMonthWindow(new Date());
    const snapshotId = `monthly_bonus_${bonusMonth.monthKey}`;
    await db.collection("payrollSnapshots").doc(snapshotId).set({
      snapshotId,
      snapshotType: "monthly_bonus",
      monthKey: bonusMonth.monthKey,
      monthStart: admin.firestore.Timestamp.fromDate(bonusMonth.start),
      monthEnd: admin.firestore.Timestamp.fromDate(bonusMonth.end),
      source: "automated_snapshot",
      status: "failed",
      failedAt: admin.firestore.FieldValue.serverTimestamp(),
      failureReason: String(error?.message || error),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    logger.error("monthlyBonusSnapshots failed", {
      snapshotId,
      error: String(error?.stack || error),
    });
    throw error;
  }
}

const {
  calculatePersonalBonusIfEligible,
  calculateLeadershipBonusIfEligible,
  calculateDirectorBonusIfEligible,
} = require("./bonusHelpers");

const {
  getRoleName,
} = require("./roleHelpers");

const {
  resolveRoleForClosedMonth,
} = require("./roleResolver");

async function createMonthlyBonusSnapshotRun(db, admin, logger) {
  logger.info("monthlyBonusSnapshots started");

  const now = new Date();

  /**
   * Run on the 10th for the PREVIOUS full month.
   * Example:
   * May 10 run = April bonuses
   */
  const bonusMonth = getPreviousMonthWindow(now);
  const monthKey = bonusMonth.monthKey;
  const snapshotId = `monthly_bonus_${monthKey}`;

  const snapshotRef = db.collection("payrollSnapshots").doc(snapshotId);
  const snapshotSnap = await snapshotRef.get();

  /**
   * Only skip if the snapshot is truly complete.
   * If an earlier run died mid-write, this allows safe rebuild/recovery.
   */
  if (snapshotSnap.exists) {
    const existing = snapshotSnap.data() || {};
    const existingStatus = String(existing.status || "").trim().toLowerCase();

    if (existingStatus === "complete") {
      logger.info("Monthly bonus snapshot already complete", { snapshotId });
      return;
    }

    logger.warn("Monthly bonus snapshot exists but is not complete, rebuilding", {
      snapshotId,
      existingStatus,
    });
  }

  /**
   * Mark header as writing before doing any heavy work.
   */
  await snapshotRef.set(
    {
      snapshotId,
      snapshotType: "monthly_bonus",

      monthKey,
      monthStart: admin.firestore.Timestamp.fromDate(bonusMonth.start),
      monthEnd: admin.firestore.Timestamp.fromDate(bonusMonth.end),

      source: "automated_snapshot",
      status: "writing",
      rowCount: 0,
      rowsWritten: 0,
      startedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  /**
   * Read users + reps + roles.
   * We do not filter only active users here because reps with earned bonus
   * for the evaluated month must still be payable even if inactive now.
   */
  const [usersSnap, repsSnap, rolesSnap] = await Promise.all([
    db.collection("users").where("userType", "==", "rep").get(),
    db.collection("reps").get(),
    db.collection("roles").get(),
  ]);

  const roleMap = {};
  rolesSnap.forEach((doc) => {
    const d = doc.data() || {};
    const roleId = String(d.roleId || doc.id || "");
    if (!roleId) return;

    roleMap[roleId] = {
      ...d,
      roleId,
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

  const rows = [];

  for (const doc of usersSnap.docs) {
    const user = doc.data() || {};
    const repId = String(user.repId || "");
    if (!repId) continue;

    const rep = repsByRepId[repId] || {};

    /**
     * IMPORTANT:
     * Bonus payout for the evaluated month must use the role that was active
     * during that month, not today's current role.
     */
    let resolvedRoleId = "";

    try {
      const resolution = await resolveRoleForClosedMonth(
        db,
        repId,
        bonusMonth.start.getFullYear(),
        bonusMonth.start.getMonth()
      );

      resolvedRoleId = String(resolution?.roleId || "");
    } catch (err) {
      logger.error("Failed to resolve historical role for monthly bonus", {
        repId,
        monthKey,
        error: String(err),
      });
    }

    const roleId = String(
      resolvedRoleId || rep.currentRoleId || user.currentRoleId || ""
    );
    const role = roleMap[roleId] || {};

    const roleName = String(
      getRoleName(role) ||
        rep.currentRoleName ||
        user.currentRoleName ||
        ""
    );

    const fullName = String(user.fullName || rep.fullName || "");

    /**
     * The current status fields and previousMonth* fields are written by
     * monthlyBonusQualification on the 1st for this snapshot month.
     */
    const personalBonusStatus = String(user.personalBonusStatus || "offBonus");
    const leadershipBonusStatus = String(
      user.leadershipBonusStatus || "offBonus"
    );
    const directorBonusStatus = String(user.directorBonusStatus || "offBonus");

    const previousMonthPersonalX = round2(
      Number(user.previousMonthPersonalX || 0)
    );
    const previousMonthPersonalRevenue = round2(
      Number(user.previousMonthPersonalRevenue || 0)
    );

    const previousMonthPodX = round2(Number(user.previousMonthPodX || 0));
    const previousMonthPodRevenue = round2(
      Number(user.previousMonthPodRevenue || 0)
    );

    const previousMonthQualifiedPdPodX = round2(
      Number(user.previousMonthQualifiedPdPodX || 0)
    );
    const previousMonthQualifiedPdPodRevenue = round2(
      Number(user.previousMonthQualifiedPdPodRevenue || 0)
    );

    /**
     * PERSONAL BONUS
     * ROLE1 is excluded here. Development Camp is evaluated exactly once by
     * developmentCampQualification after its individual 42-day window.
     */
    let personalBonusResult = buildZeroBonusResult("personal");

    if (roleId !== "ROLE1") {
      personalBonusResult = calculatePersonalBonusIfEligible({
        isOnBonus: personalBonusStatus === "onBonus",
        role,
        xValue: previousMonthPersonalX,
        revenue: previousMonthPersonalRevenue,
      });
    }

    /**
     * LEADERSHIP BONUS
     */
    const leadershipBonusResult = calculateLeadershipBonusIfEligible({
      isOnBonus: leadershipBonusStatus === "onBonus",
      role,
      podX: previousMonthPodX,
      podRevenue: previousMonthPodRevenue,
    });

    /**
     * DIRECTOR BONUS
     */
    const directorBonusResult = calculateDirectorBonusIfEligible({
      isOnBonus: directorBonusStatus === "onBonus",
      role,
      orgX: previousMonthQualifiedPdPodX,
      orgRevenue: previousMonthQualifiedPdPodRevenue,
    });

    const personalBonusPay = round2(Number(personalBonusResult.bonusPay || 0));
    const leadershipBonusPay = round2(
      Number(leadershipBonusResult.bonusPay || 0)
    );
    const directorBonusPay = round2(Number(directorBonusResult.bonusPay || 0));

    const totalPay = round2(
      personalBonusPay + leadershipBonusPay + directorBonusPay
    );

    /**
     * Only include rows with money owed.
     */
    if (totalPay <= 0) continue;

    rows.push({
      repId,
      fullName,
      roleId,
      roleName,

      snapshotType: "monthly_bonus",

      monthKey,
      monthStart: admin.firestore.Timestamp.fromDate(bonusMonth.start),
      monthEnd: admin.firestore.Timestamp.fromDate(bonusMonth.end),

      personalBonusStatus,
      leadershipBonusStatus,
      directorBonusStatus,

      previousMonthPersonalX,
      previousMonthPersonalRevenue,
      previousMonthPodX,
      previousMonthPodRevenue,
      previousMonthQualifiedPdPodX,
      previousMonthQualifiedPdPodRevenue,

      personalBonusRate: roundRate(
        Number(personalBonusResult.bonusRate || 0)
      ),
      leadershipBonusRate: roundRate(
        Number(leadershipBonusResult.bonusRate || 0)
      ),
      directorBonusRate: roundRate(
        Number(directorBonusResult.bonusRate || 0)
      ),

      personalAchievedTierMinX: personalBonusResult.tier
        ? Number(personalBonusResult.tier.minX || 0)
        : null,

      leadershipAchievedTierMinX: leadershipBonusResult.tier
        ? Number(leadershipBonusResult.tier.minX || 0)
        : null,

      directorAchievedTierMinX: directorBonusResult.tier
        ? Number(directorBonusResult.tier.minX || 0)
        : null,

      personalBonusPay,
      leadershipBonusPay,
      directorBonusPay,

      totalPay,

      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  /**
   * Sort highest paid first
   */
  rows.sort((a, b) => {
    const diff = Number(b.totalPay || 0) - Number(a.totalPay || 0);
    if (diff !== 0) return diff;

    return String(a.fullName || "").localeCompare(String(b.fullName || ""));
  });

  /**
   * Rewrite header with expected row count before row writes.
   */
  await snapshotRef.set(
    {
      snapshotId,
      snapshotType: "monthly_bonus",

      monthKey,
      monthStart: admin.firestore.Timestamp.fromDate(bonusMonth.start),
      monthEnd: admin.firestore.Timestamp.fromDate(bonusMonth.end),

      source: "automated_snapshot",
      status: "writing",
      rowCount: rows.length,
      rowsWritten: 0,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  /**
   * Clear stale old rows before rewriting.
   */
  await deleteAllRows(snapshotRef, db, logger);

  /**
   * Write rows and track progress.
   */
  const rowsWritten = await writeRowsInChunks(
    db,
    admin,
    snapshotRef,
    rows,
    logger
  );

  /**
   * Finalize header only after successful row writes.
   */
  const totals = rows.reduce((result, row) => ({
    totalPersonalBonusPay:
      result.totalPersonalBonusPay + Number(row.personalBonusPay || 0),
    totalLeadershipBonusPay:
      result.totalLeadershipBonusPay + Number(row.leadershipBonusPay || 0),
    totalDirectorBonusPay:
      result.totalDirectorBonusPay + Number(row.directorBonusPay || 0),
    totalPayout: result.totalPayout + Number(row.totalPay || 0),
  }), {
    totalPersonalBonusPay: 0,
    totalLeadershipBonusPay: 0,
    totalDirectorBonusPay: 0,
    totalPayout: 0,
  });
  Object.keys(totals).forEach((key) => { totals[key] = round2(totals[key]); });

  await snapshotRef.set(
    {
      snapshotId,
      snapshotType: "monthly_bonus",

      monthKey,
      monthStart: admin.firestore.Timestamp.fromDate(bonusMonth.start),
      monthEnd: admin.firestore.Timestamp.fromDate(bonusMonth.end),

      source: "automated_snapshot",
      status: "complete",
      rowCount: rows.length,
      rowsWritten,
      ...totals,
      adjustmentTotal: 0,
      payoutStatus: "pending",
      failureReason: null,
      failedAt: null,
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  logger.info("monthlyBonusSnapshots completed", {
    snapshotId,
    rowCount: rows.length,
    rowsWritten,
  });
}

async function writeRowsInChunks(
  db,
  admin,
  snapshotRef,
  rows,
  logger,
  chunkSize = 300
) {
  let rowsWritten = 0;

  for (let i = 0; i < rows.length; i += chunkSize) {
    const batch = db.batch();

    rows.slice(i, i + chunkSize).forEach((row) => {
      const rowRef = snapshotRef.collection("rows").doc(String(row.repId));
      batch.set(rowRef, row, { merge: true });
    });

    await batch.commit();

    rowsWritten += Math.min(chunkSize, rows.length - i);

    await snapshotRef.set(
      {
        rowsWritten,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    logger.info("monthlyBonusSnapshots chunk committed", {
      snapshotId: snapshotRef.id,
      rowsWritten,
      totalRows: rows.length,
    });
  }

  return rowsWritten;
}

async function deleteAllRows(snapshotRef, db, logger, chunkSize = 300) {
  while (true) {
    const snap = await snapshotRef.collection("rows").limit(chunkSize).get();
    if (snap.empty) break;

    const batch = db.batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();

    logger.info("monthlyBonusSnapshots stale rows deleted", {
      snapshotId: snapshotRef.id,
      deletedCount: snap.size,
    });
  }
}

function buildZeroBonusResult(type) {
  return {
    type,
    qualified: false,
    xValue: 0,
    revenue: 0,
    tier: null,
    bonusRate: 0,
    bonusPay: 0,
    blockedByStatus: false,
  };
}

function getPreviousMonthWindow(now) {
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

  const monthKey = `${start.getFullYear()}-${String(
    start.getMonth() + 1
  ).padStart(2, "0")}`;

  return {
    start,
    end,
    monthKey,
  };
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function roundRate(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 1000000) / 1000000;
}
