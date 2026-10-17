module.exports = {
  createPayrollSnapshot,
};

async function createPayrollSnapshot(db, admin, logger) {
  try {
    return await createPayrollSnapshotRun(db, admin, logger);
  } catch (error) {
    const payWindow = getPreviousCompletedSemiMonthlyPeriod(new Date());
    const snapshotId = buildCommissionSnapshotId(payWindow.start, payWindow.end);
    await db.collection("payrollSnapshots").doc(snapshotId).set({
      snapshotId,
      snapshotType: "commission_override",
      payPeriodLabel: payWindow.label,
      payPeriodStart: admin.firestore.Timestamp.fromDate(payWindow.start),
      payPeriodEnd: admin.firestore.Timestamp.fromDate(payWindow.end),
      source: "automated_snapshot",
      status: "failed",
      failedAt: admin.firestore.FieldValue.serverTimestamp(),
      failureReason: String(error?.message || error),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    logger.error("payrollSnapshots failed", {
      snapshotId,
      error: String(error?.stack || error),
    });
    throw error;
  }
}

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
  resolveRoleForPayPeriod,
} = require("./roleResolver");

async function createPayrollSnapshotRun(db, admin, logger) {
  logger.info("payrollSnapshots started");

  const now = new Date();
  const payWindow = getPreviousCompletedSemiMonthlyPeriod(now);

  const payPeriodLabel = payWindow.label;
  const payPeriodStart = admin.firestore.Timestamp.fromDate(payWindow.start);
  const payPeriodEnd = admin.firestore.Timestamp.fromDate(payWindow.end);

  const snapshotId = buildCommissionSnapshotId(payWindow.start, payWindow.end);
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
      logger.info("Commission snapshot already complete", { snapshotId });
      return;
    }

    logger.warn("Commission snapshot exists but is not complete, rebuilding", {
      snapshotId,
      existingStatus,
    });
  }

  /**
   * Mark header as writing before doing any heavy work.
   * This gives us a recoverable state if the run crashes.
   */
  await snapshotRef.set(
    {
      snapshotId,
      snapshotType: "commission_override",
      payPeriodLabel,
      payPeriodStart,
      payPeriodEnd,
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
   * Read source data
   * Do NOT filter users by active=true.
   * Closed-period payroll must include anyone with payable activity.
   */
  const [usersSnap, rolesSnap, ordersSnap, shiftsSnap, attendanceSnap] =
    await Promise.all([
      db.collection("users").where("userType", "==", "rep").get(),
      db.collection("roles").get(),
      db.collection("orderIngest").get(),
      db.collection("scheduledShifts").get(),
      db.collection("attendanceLogs").get(),
    ]);

  /**
   * Build user map
   */
  const userMap = {};
  usersSnap.forEach((doc) => {
    const d = doc.data() || {};
    const repId = String(d.repId || "");
    if (!repId) return;

    userMap[repId] = {
      repId,
      fullName: String(d.fullName || ""),
      roleId: String(d.currentRoleId || ""),
      roleName: String(d.currentRoleName || ""),
      isLeader: !!d.isLeader,
      active: !!d.active,
    };
  });

  /**
   * Build role map
   */
  const roleMap = {};
  rolesSnap.forEach((doc) => {
    const d = doc.data() || {};
    const roleId = String(d.roleId || doc.id || "");
    if (!roleId) return;
    roleMap[roleId] = d;
  });

  /**
   * Build rows lazily from payable activity rather than current active roster.
   */
  const rowsByRepId = {};

  function ensureRow(repId) {
    const safeRepId = String(repId || "");
    if (!safeRepId) return null;

    if (!rowsByRepId[safeRepId]) {
      const user = userMap[safeRepId] || {};

      rowsByRepId[safeRepId] = {
        repId: safeRepId,
        fullName: String(user.fullName || ""),
        roleId: String(user.roleId || ""),
        roleName: String(user.roleName || ""),

        snapshotType: "commission_override",
        payPeriodLabel,
        payPeriodStart,
        payPeriodEnd,

        currentPayPeriodX: 0,
        currentPayPeriodRevenue: 0,
        currentPayPeriodSalesCount: 0,

        vipSalesCount: 0,
        signatureSalesCount: 0,
        founding500SalesCount: 0,

        commissionRate: 0,
        vipPlusRate: 0,
        pdOverrideRate: 0,
        directorOverrideRate: 0,

        commissionPay: 0,
        vipPlusRevenueBase: 0,
        vipPlusPay: 0,

        pdOverrideRevenueBase: 0,
        directorOverrideRevenueBase: 0,
        pdOverridePay: 0,
        directorOverridePay: 0,
        overridePay: 0,

        workedShiftCount: 0,
        missedShiftCount: 0,
        approvedAbsenceCount: 0,
        daysWorked: 0,
        hoursWorked: 0,

        totalPay: 0,

        isLeader: !!user.isLeader,
        leaderRepId: !!user.isLeader ? safeRepId : null,
        active: !!user.active,

        createdAt: null,
      };
    }

    return rowsByRepId[safeRepId];
  }

  /**
   * Resolve role-based rates for any rep who gets a row.
   * For personal commission/vipPlus, actual pay is computed from order.roleIdAtSale.
   * For PD/director overrides, use role resolved for this closed pay period.
   */
  const roleResolutionCache = {};

  async function getResolvedLeaderRates(repId) {
    const safeRepId = String(repId || "");
    if (!safeRepId) {
      return {
        roleId: "",
        roleName: "",
        pdOverrideRate: 0,
        directorOverrideRate: 0,
      };
    }

    if (roleResolutionCache[safeRepId]) {
      return roleResolutionCache[safeRepId];
    }

    const resolution = await resolveRoleForPayPeriod(
      db,
      safeRepId,
      payWindow.start,
      payWindow.end
    );

    const resolvedRoleId = String(resolution.roleId || "");
    const resolvedRole = roleMap[resolvedRoleId] || {};
    const fallbackUser = userMap[safeRepId] || {};

    const result = {
      roleId: resolvedRoleId || String(fallbackUser.roleId || ""),
      roleName:
        String(resolvedRole.roleName || resolvedRole.displayName || "") ||
        String(fallbackUser.roleName || ""),
      pdOverrideRate: getPdOverrideRate(resolvedRole),
      directorOverrideRate: getDirectorOverrideRate(resolvedRole),
    };

    roleResolutionCache[safeRepId] = result;
    return result;
  }

  /**
   * Walk all orders once and allocate to the correct row(s)
   * for the previous completed pay period.
   */
  ordersSnap.forEach((doc) => {
    const order = normalizeOrder(doc.data() || {});

    const paidAt = parseDate(order.datePaid);
    if (!paidAt) return;
    if (paidAt < payWindow.start || paidAt > payWindow.end) return;
    if (isOrderRefunded(order)) return;
    if (!order.isPayable) return;

    const salesRepId = String(order.salesRepId || "");
    const pdRepId = String(order.programDirectorRepId || "");
    const directorRepId = String(order.directorRepId || "");

    const revenue = Number(order.revenue || 0);
    const xValue = Number(order.xValue || 0);
    const tier = String(order.tier || order.membershipType || "").toLowerCase();

    /**
     * Personal sales
     * Commission/vipPlus use roleIdAtSale, not current role.
     */
    if (salesRepId) {
      const row = ensureRow(salesRepId);
      if (row) {
        const saleRoleId = String(order.roleIdAtSale || "");
        const saleRole = roleMap[saleRoleId] || {};

        const saleCommissionRate = getCommissionRate(saleRole);
        const saleVipPlusRate = getVipPlusRate(saleRole);

        row.currentPayPeriodX += xValue;
        row.currentPayPeriodRevenue += revenue;
        row.currentPayPeriodSalesCount += 1;

        row.commissionPay += revenue * saleCommissionRate;

        if (order.isVipLike) {
          row.vipPlusRevenueBase += revenue;
          row.vipPlusPay += revenue * saleVipPlusRate;
        }

        if (!row.roleId && saleRoleId) {
          row.roleId = saleRoleId;
          row.roleName = String(
            saleRole.roleName || saleRole.displayName || row.roleName || ""
          );
        }

        if (tier === "vip") {
          row.vipSalesCount += 1;
        } else if (tier === "founding500") {
          row.founding500SalesCount += 1;
        } else {
          row.signatureSalesCount += 1;
        }
      }
    }

    /**
     * PD override base
     * Exclude the leader's own personal sales from PD override.
     */
    if (pdRepId && salesRepId && salesRepId !== pdRepId) {
      const row = ensureRow(pdRepId);
      if (row) {
        row.pdOverrideRevenueBase += revenue;
      }
    }

    /**
     * Director override base
     * Indirect only:
     * - directorRepId matches
     * - salesRepId is not the director
     * - programDirectorRepId is not the director
     */
    if (
      directorRepId &&
      salesRepId &&
      salesRepId !== directorRepId &&
      pdRepId !== directorRepId
    ) {
      const row = ensureRow(directorRepId);
      if (row) {
        row.directorOverrideRevenueBase += revenue;
      }
    }
  });

  /**
   * Attendance rollups for the same pay period.
   * completed logs drive workedShiftCount/hours/daysWorked
   * scheduledShifts drive missed + approved absence counts
   */
  const workedDateSetsByRepId = {};

  attendanceSnap.forEach((doc) => {
    const row = doc.data() || {};
    const repId = String(row.repId || "");
    if (!repId) return;

    const status = String(row.status || "").trim().toLowerCase();
    if (status !== "completed") return;

    const shiftDate = parseDate(row.shiftDate);
    if (!shiftDate) return;
    if (shiftDate < payWindow.start || shiftDate > payWindow.end) return;

    const payrollRow = ensureRow(repId);
    if (!payrollRow) return;

    payrollRow.workedShiftCount += 1;

    const clockInAt = parseDate(row.clockInAt);
    const clockOutAt = parseDate(row.clockOutAt);

    if (clockInAt && clockOutAt && clockOutAt >= clockInAt) {
      payrollRow.hoursWorked +=
        (clockOutAt.getTime() - clockInAt.getTime()) / 3600000;
    }

    if (!workedDateSetsByRepId[repId]) {
      workedDateSetsByRepId[repId] = new Set();
    }
    workedDateSetsByRepId[repId].add(formatDateLabel(shiftDate));
  });

  shiftsSnap.forEach((doc) => {
    const row = doc.data() || {};
    const repId = String(row.repId || "");
    if (!repId) return;

    const shiftDate = parseDate(row.shiftDate);
    if (!shiftDate) return;
    if (shiftDate < payWindow.start || shiftDate > payWindow.end) return;

    const status = String(row.status || "").trim().toLowerCase();
    const payrollRow = ensureRow(repId);
    if (!payrollRow) return;

    if (status === "missed") {
      payrollRow.missedShiftCount += 1;
    } else if (
      status === "approved absence" ||
      status === "approved_absence" ||
      status === "approvedabsence"
    ) {
      payrollRow.approvedAbsenceCount += 1;
    }
  });

  /**
   * Finalize role-based override rates, attendance, and total pay.
   */
  const rowRepIds = Object.keys(rowsByRepId);

  for (const repId of rowRepIds) {
    const row = rowsByRepId[repId];
    const resolvedLeaderRates = await getResolvedLeaderRates(repId);

    if (!row.roleId && resolvedLeaderRates.roleId) {
      row.roleId = resolvedLeaderRates.roleId;
    }
    if (!row.roleName && resolvedLeaderRates.roleName) {
      row.roleName = resolvedLeaderRates.roleName;
    }

    row.pdOverrideRate = Number(resolvedLeaderRates.pdOverrideRate || 0);
    row.directorOverrideRate = Number(
      resolvedLeaderRates.directorOverrideRate || 0
    );

    row.currentPayPeriodX = round2(row.currentPayPeriodX);
    row.currentPayPeriodRevenue = round2(row.currentPayPeriodRevenue);

    row.commissionPay = round2(row.commissionPay);
    row.vipPlusRevenueBase = round2(row.vipPlusRevenueBase);
    row.vipPlusPay = round2(row.vipPlusPay);

    row.pdOverrideRevenueBase = round2(row.pdOverrideRevenueBase);
    row.directorOverrideRevenueBase = round2(row.directorOverrideRevenueBase);

    row.pdOverridePay = round2(
      row.pdOverrideRevenueBase * Number(row.pdOverrideRate || 0)
    );

    row.directorOverridePay = round2(
      row.directorOverrideRevenueBase * Number(row.directorOverrideRate || 0)
    );

    row.overridePay = round2(row.pdOverridePay + row.directorOverridePay);

    row.hoursWorked = round2(row.hoursWorked);
    row.daysWorked = Number(workedDateSetsByRepId[repId]?.size || 0);

    row.totalPay = round2(
      row.commissionPay + row.vipPlusPay + row.overridePay
    );

    row.createdAt = admin.firestore.FieldValue.serverTimestamp();
  }

  /**
   * Only include rows with actual payable activity or relevant attendance visibility.
   * Payroll should primarily be earnings-driven.
   */
  const rows = Object.values(rowsByRepId)
    .filter((row) => Number(row.totalPay || 0) > 0)
    .sort((a, b) => {
      const payDiff = Number(b.totalPay || 0) - Number(a.totalPay || 0);
      if (payDiff !== 0) return payDiff;

      const nameA = String(a.fullName || "").toLowerCase();
      const nameB = String(b.fullName || "").toLowerCase();
      if (nameA < nameB) return -1;
      if (nameA > nameB) return 1;
      return 0;
    });

  /**
   * Rewrite header with expected row count before row writes.
   */
  await snapshotRef.set(
    {
      snapshotId,
      snapshotType: "commission_override",
      payPeriodLabel,
      payPeriodStart,
      payPeriodEnd,
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
   * This protects against partial prior runs leaving orphan rows behind.
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
    totalSalesCount: result.totalSalesCount + Number(row.currentPayPeriodSalesCount || 0),
    totalRevenue: result.totalRevenue + Number(row.currentPayPeriodRevenue || 0),
    totalX: result.totalX + Number(row.currentPayPeriodX || 0),
    totalCommissionPay: result.totalCommissionPay + Number(row.commissionPay || 0),
    totalVipPlusPay: result.totalVipPlusPay + Number(row.vipPlusPay || 0),
    totalProgramDirectorOverridePay:
      result.totalProgramDirectorOverridePay + Number(row.pdOverridePay || 0),
    totalDirectorOverridePay:
      result.totalDirectorOverridePay + Number(row.directorOverridePay || 0),
    totalPayout: result.totalPayout + Number(row.totalPay || 0),
  }), {
    totalSalesCount: 0,
    totalRevenue: 0,
    totalX: 0,
    totalCommissionPay: 0,
    totalVipPlusPay: 0,
    totalProgramDirectorOverridePay: 0,
    totalDirectorOverridePay: 0,
    totalPayout: 0,
  });
  Object.keys(totals).forEach((key) => { totals[key] = round2(totals[key]); });

  await snapshotRef.set(
    {
      snapshotId,
      snapshotType: "commission_override",
      payPeriodLabel,
      payPeriodStart,
      payPeriodEnd,
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

  logger.info("payrollSnapshots completed", {
    snapshotId,
    snapshotType: "commission_override",
    payPeriodLabel,
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
    const chunk = rows.slice(i, i + chunkSize);
    const batch = db.batch();

    chunk.forEach((row) => {
      const rowRef = snapshotRef.collection("rows").doc(String(row.repId));
      batch.set(rowRef, row, { merge: true });
    });

    await batch.commit();

    rowsWritten += chunk.length;

    await snapshotRef.set(
      {
        rowsWritten,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    logger.info("payrollSnapshots chunk committed", {
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

    logger.info("payrollSnapshots stale rows deleted", {
      snapshotId: snapshotRef.id,
      deletedCount: snap.size,
    });
  }
}

function getPreviousCompletedSemiMonthlyPeriod(now) {
  const year = now.getFullYear();
  const month = now.getMonth();
  const day = now.getDate();

  /**
   * On the 1st–15th, the previous completed pay period
   * is the 16th–end of the previous month.
   *
   * On the 16th–end, the previous completed pay period
   * is the 1st–15th of the current month.
   */
  if (day <= 15) {
    const prevMonthDate = new Date(year, month - 1, 1);
    const prevYear = prevMonthDate.getFullYear();
    const prevMonth = prevMonthDate.getMonth();
    const lastDay = getLastDayOfMonth(prevYear, prevMonth);

    const start = new Date(prevYear, prevMonth, 16, 0, 0, 0, 0);
    const end = new Date(prevYear, prevMonth, lastDay, 23, 59, 59, 999);

    return {
      start,
      end,
      label: buildPayPeriodLabel(start, end),
    };
  }

  const start = new Date(year, month, 1, 0, 0, 0, 0);
  const end = new Date(year, month, 15, 23, 59, 59, 999);

  return {
    start,
    end,
    label: buildPayPeriodLabel(start, end),
  };
}

function getLastDayOfMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function buildCommissionSnapshotId(start, end) {
  return `commission_${formatDateLabel(start)}_${formatDateLabel(end)}`;
}

function buildPayPeriodLabel(start, end) {
  return `${formatDateLabel(start)} - ${formatDateLabel(end)}`;
}

function formatDateLabel(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}
