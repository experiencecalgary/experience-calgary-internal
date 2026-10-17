"use strict";

const { normalizeOrder, isOrderRefunded } = require("./orderNormalizer");

const EDMONTON_TIME_ZONE = "America/Edmonton";

async function recomputeLeaderboards(db, admin, logger, options = {}) {
  logger.info("leaderboards started");

  const [configSnap, usersSnap, ordersSnap, repStatsSnap] = await Promise.all([
    db.collection("appConfig").doc("global").get(),
    db.collection("users").where("userType", "==", "rep").where("active", "==", true).get(),
    db.collection("orderIngest").get(),
    db.collection("repCurrentStats").get(),
  ]);

  if (!configSnap.exists) throw new Error("Missing appConfig/global");

  const config = configSnap.data() || {};
  const payPeriodStart = parseDate(config.currentPayPeriodStart);
  const payPeriodEnd = parseDate(config.currentPayPeriodEnd);
  if (!payPeriodStart || !payPeriodEnd || payPeriodStart >= payPeriodEnd) {
    throw new Error("Invalid current pay-period boundaries in appConfig/global");
  }

  const now = parseDate(options.now) || new Date();
  const monthKey = getEdmontonMonthKey(now);
  const users = snapshotRows(usersSnap).map((doc) => normalizeUser(doc.data));
  const repStats = new Map(
    snapshotRows(repStatsSnap).map((doc) => {
      const data = doc.data || {};
      return [String(data.repId || doc.id), data];
    })
  );

  const eligibleOrders = snapshotRows(ordersSnap)
    .map((doc) => qualifyLeaderboardOrder(doc.data))
    .filter(Boolean);

  const boards = buildAllBoards({
    users,
    eligibleOrders,
    repStats,
    monthKey,
    payPeriodStart,
    payPeriodEnd,
    payPeriodLabel: String(config.currentPayPeriodLabel || ""),
  });

  await Promise.all(
    boards.map(({ id, payload }) => writeBoardDoc(db, admin, id, payload))
  );

  logger.info("leaderboards completed", {
    eligibleOrders: eligibleOrders.length,
    monthKey,
    boards: boards.length,
  });
}

function buildAllBoards(context) {
  const periods = [
    {
      suffix: "current_pay_period",
      periodType: "pay_period",
      contains: (date) => date >= context.payPeriodStart && date < context.payPeriodEnd,
      metadata: {
        payPeriodLabel: context.payPeriodLabel,
        payPeriodStart: context.payPeriodStart,
        payPeriodEnd: context.payPeriodEnd,
      },
      label: "Current Pay Period",
    },
    {
      suffix: "current_month",
      periodType: "month",
      contains: (date) => getEdmontonMonthKey(date) === context.monthKey,
      metadata: { monthKey: context.monthKey },
      label: "Current Month",
    },
  ];

  const boards = [];
  for (const period of periods) {
    const orders = context.eligibleOrders.filter((order) => period.contains(order.paidAt));
    boards.push(
      makeRepBoard(context, period, orders),
      makePdBoard(context, period, orders),
      makeDirectorBoard(context, period, orders)
    );
  }
  return boards;
}

function makeRepBoard(context, period, orders) {
  const reps = context.users.filter((user) => user.repId);
  const totals = aggregateOrders(orders, (order) => order.salesRepId);
  const rows = reps.map((rep) => {
    const total = totals.get(rep.repId) || emptyTotals();
    const storedStats = context.repStats.get(rep.repId) || {};
    return {
      repId: rep.repId,
      fullName: rep.fullName,
      roleId: rep.roleId,
      roleName: rep.roleName,
      totalX: round2(total.x),
      revenue: round2(total.revenue),
      salesCount: total.salesCount,
      ...(period.periodType === "pay_period"
        ? { estimatedPay: Number(storedStats.estimatedTotalPay || 0) }
        : {}),
    };
  });
  const id = `rep_${period.suffix}_x`;
  return board(id, {
    boardType: "rep",
    metricType: "x",
    period,
    title: `${period.label} Rep Leaderboard`,
    rows,
  });
}

function makePdBoard(context, period, orders) {
  const pds = context.users.filter((user) => user.roleId === "ROLE7" && user.repId);
  const totals = aggregateOrders(orders, (order) => order.programDirectorRepId);
  const activeReps = countUsers(context.users, (user) =>
    user.programDirectorRepId && user.repId !== user.programDirectorRepId
      ? user.programDirectorRepId
      : ""
  );
  const rows = pds.map((pd) => ({
    leaderRepId: pd.repId,
    repId: pd.repId,
    fullName: pd.fullName,
    roleId: pd.roleId,
    roleName: pd.roleName,
    totalX: round2((totals.get(pd.repId) || emptyTotals()).x),
    revenue: round2((totals.get(pd.repId) || emptyTotals()).revenue),
    salesCount: (totals.get(pd.repId) || emptyTotals()).salesCount,
    activeReps: activeReps.get(pd.repId) || 0,
  }));
  const id = `pd_${period.suffix}_pod_x`;
  return board(id, {
    boardType: "pd",
    metricType: "pod_x",
    period,
    title: `${period.label} PD Pod Leaderboard`,
    rows,
  });
}

function makeDirectorBoard(context, period, orders) {
  const directors = context.users.filter((user) => isDirectorRole(user.roleId) && user.repId);
  const totals = aggregateOrders(orders, (order) => {
    if (!order.directorRepId) return "";
    if (order.salesRepId === order.directorRepId) return "";
    if (order.programDirectorRepId === order.directorRepId) return "";
    return order.directorRepId;
  });
  const activePds = countUsers(context.users, (user) =>
    user.directorRepId && user.repId !== user.directorRepId && isLeadershipRole(user.roleId)
      ? user.directorRepId
      : ""
  );
  const rows = directors.map((director) => ({
    leaderRepId: director.repId,
    repId: director.repId,
    fullName: director.fullName,
    roleId: director.roleId,
    roleName: director.roleName,
    totalX: round2((totals.get(director.repId) || emptyTotals()).x),
    revenue: round2((totals.get(director.repId) || emptyTotals()).revenue),
    salesCount: (totals.get(director.repId) || emptyTotals()).salesCount,
    activePdCount: activePds.get(director.repId) || 0,
  }));
  const id = `director_${period.suffix}_org_x`;
  return board(id, {
    boardType: "director",
    metricType: "org_x",
    period,
    title: `${period.label} Director Org Leaderboard`,
    rows,
  });
}

function qualifyLeaderboardOrder(rawOrder = {}) {
  const paidAt = parseActualDatePaid(rawOrder);
  if (!paidAt) return null;

  const order = normalizeOrder(rawOrder);
  const revenue = Number(order.revenue || 0);
  if (isOrderRefunded(rawOrder)) return null;
  if (!order.salesRepId || revenue <= 0 || Number(order.xValue) <= 0) return null;

  return {
    paidAt,
    salesRepId: String(order.salesRepId),
    programDirectorRepId: String(order.programDirectorRepId || ""),
    directorRepId: String(order.directorRepId || ""),
    xValue: Number(order.xValue),
    revenue,
  };
}

function parseActualDatePaid(rawOrder = {}) {
  const payload = parsePayload(rawOrder.payloadRaw);
  return parseDate(rawOrder.datePaid || payload.date_paid || null);
}

function parsePayload(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return {};
  try { return JSON.parse(value); } catch (_) { return {}; }
}

function normalizeUser(data = {}) {
  return {
    repId: String(data.repId || ""),
    fullName: String(data.fullName || ""),
    roleId: String(data.currentRoleId || ""),
    roleName: String(data.currentRoleName || ""),
    programDirectorRepId: String(data.programDirectorRepId || ""),
    directorRepId: String(data.directorRepId || ""),
  };
}

function aggregateOrders(orders, keyForOrder) {
  const result = new Map();
  for (const order of orders) {
    const key = String(keyForOrder(order) || "");
    if (!key) continue;
    const total = result.get(key) || emptyTotals();
    total.x += order.xValue;
    total.revenue += order.revenue;
    total.salesCount += 1;
    result.set(key, total);
  }
  return result;
}

function countUsers(users, keyForUser) {
  const result = new Map();
  for (const user of users) {
    const key = String(keyForUser(user) || "");
    if (key) result.set(key, (result.get(key) || 0) + 1);
  }
  return result;
}

function emptyTotals() { return { x: 0, revenue: 0, salesCount: 0 }; }

function board(id, { boardType, metricType, period, title, rows }) {
  return {
    id,
    payload: {
      boardId: id,
      boardType,
      metricType,
      periodType: period.periodType,
      ...period.metadata,
      title,
      rows: rankRows(rows, "totalX", ["salesCount", "revenue", "fullName"]),
    },
  };
}

async function writeBoardDoc(db, admin, docId, payload) {
  await db.collection("leaderboards").doc(docId).set({
    ...payload,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

function rankRows(rows, primaryMetric, secondaryKeys = []) {
  return [...rows].sort((a, b) => {
    const primary = Number(b[primaryMetric] || 0) - Number(a[primaryMetric] || 0);
    if (primary) return primary;
    for (const key of secondaryKeys) {
      if (typeof a[key] === "number" || typeof b[key] === "number") {
        const difference = Number(b[key] || 0) - Number(a[key] || 0);
        if (difference) return difference;
      } else {
        const difference = String(a[key] || "").localeCompare(String(b[key] || ""), undefined, { sensitivity: "base" });
        if (difference) return difference;
      }
    }
    return String(a.repId || "").localeCompare(String(b.repId || ""), undefined, { numeric: true });
  }).map((row, index) => ({ rank: index + 1, ...row }));
}

function snapshotRows(snapshot) {
  const rows = [];
  snapshot.forEach((doc) => rows.push({ id: doc.id, data: doc.data() || {} }));
  return rows;
}

function parseDate(value) {
  if (!value) return null;
  const date = typeof value.toDate === "function" ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getEdmontonMonthKey(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: EDMONTON_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year").value;
  const month = parts.find((part) => part.type === "month").value;
  return `${year}-${month}`;
}

function isDirectorRole(roleId) { return ["ROLE8", "ROLE9", "ROLE10", "ROLE11"].includes(roleId); }
function isLeadershipRole(roleId) { return roleId === "ROLE7" || isDirectorRole(roleId); }
function round2(value) { return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100; }

module.exports = {
  recomputeLeaderboards,
  _test: { buildAllBoards, qualifyLeaderboardOrder, parseActualDatePaid, getEdmontonMonthKey, rankRows },
};
