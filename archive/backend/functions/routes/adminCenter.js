"use strict";

const { isOrderRefunded } = require("../lib/orderNormalizer");
const { isPlatformAdmin } = require("./repLifecycle");
const { createAdminCenterActions } = require("../lib/adminCenterActions");
const { resolveSnapshotPayout } = require("../lib/accountingCompatibility");

const clean = (value) => String(value ?? "").trim();
const lower = (value) => clean(value).toLowerCase();
const clamp = (value, fallback = 25, max = 50) =>
  Math.min(Math.max(Number(value) || fallback, 1), max);

function serialize(value) {
  if (value == null) return value;
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(serialize);
  if (value.path && typeof value.path === "string") return { path: value.path };
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serialize(item)]));
  }
  return value;
}

function first(data, fields, fallback = null) {
  for (const field of fields) {
    if (data[field] !== undefined && data[field] !== null && data[field] !== "") {
      return data[field];
    }
  }
  return fallback;
}

function orderPaymentState(data = {}) {
  if (isOrderRefunded(data)) return "refunded";
  return data.datePaid ? "paid" : "unpaid";
}

function orderProcessingState(data = {}) {
  if (data.processed === true) return "processed";
  if (data.processing === true) return "processing";
  if (clean(data.error)) return "error";
  return "not_processed";
}

function orderSummary(doc) {
  const data = doc.data() || {};
  return serialize({
    id: doc.id,
    wooOrderId: clean(data.wooOrderId || doc.id),
    status: data.status || null,
    paymentState: orderPaymentState(data),
    datePaid: data.datePaid || null,
    processingState: orderProcessingState(data),
    processingError: clean(data.error) || null,
    purchaseType: data.purchaseType || null,
    billingEmail: data.billingEmail || null,
    total: data.total ?? null,
    currency: data.currency || null,
    salesRepId: data.salesRepId || null,
    salesRepName: data.salesRepName || null,
    attributionStatus: data.attributionStatus || null,
    attributionSource: data.attributionSource || null,
    membershipId: data.membershipId || null,
    accessAccountId: data.accessAccountId || null,
    receivedAt: data.receivedAt || null,
    updatedAt: data.updatedAt || null,
  });
}

function fullDocument(doc, { omit = [] } = {}) {
  const data = { id: doc.id, ...(doc.data() || {}) };
  for (const field of omit) delete data[field];
  return serialize(data);
}

function reviewSummary(doc) {
  const data = doc.data() || {};
  return serialize({
    id: doc.id,
    wooOrderId: first(data, ["wooOrderId", "orderId"], doc.id),
    status: data.status || null,
    issue: first(data, ["issue", "attributionIssue", "reason"]),
    submittedSalesRepId: data.submittedSalesRepId || null,
    salesRepId: data.salesRepId || null,
    customerName: data.customerName || null,
    customerEmail: data.customerEmail || null,
    orderTotal: data.orderTotal ?? null,
    currency: data.currency || null,
    createdAt: data.createdAt || null,
    updatedAt: data.updatedAt || null,
  });
}

function membershipSummary(doc) {
  const data = doc.data() || {};
  return serialize({
    id: doc.id,
    membershipId: first(data, ["membershipId"], doc.id),
    uid: first(data, ["uid", "userId"]),
    billingEmail: first(data, ["billingEmail", "email", "memberEmail"]),
    email: first(data, ["billingEmail", "email", "memberEmail"]),
    firstName: first(data, ["firstName", "billingFirstName"]),
    lastName: first(data, ["lastName", "billingLastName"]),
    fullName: first(data, ["fullName", "memberName", "billingName"]),
    tier: first(data, ["tier", "membershipType", "plan"]),
    cityId: data.cityId || null,
    active: first(data, ["active", "isActive"], null),
    source: data.source || null,
    wooOrderId: first(data, ["sourceWooOrderId", "wooOrderId", "orderId"], doc.id),
    startedAt: first(data, ["startedAt", "startAt", "createdAt"]),
    expiresAt: first(data, ["expiresAt", "endAt"]),
    revokedAt: data.revokedAt || null,
    revocationReason: data.revocationReason || null,
    offersRemainingCount: data.offersRemainingCount ?? null,
    offersTotalCount: data.offersTotalCount ?? null,
    savingsRemainingDollars: data.savingsRemainingDollars ?? null,
    vipGiftsRemaining: data.vipGiftsRemaining ?? null,
    entitlementsProvisioned: data.entitlementsProvisioned ?? null,
    entitlementProvisionedAt: first(data, ["entitlementProvisionedAt", "entitlementsProvisionedAt"]),
    updatedAt: data.updatedAt || null,
  });
}

function accessAccountSummary(doc) {
  const data = doc.data() || {};
  return serialize({
    id: doc.id,
    accountId: first(data, ["accountId"], doc.id),
    ownerUid: first(data, ["ownerUid", "uid"]),
    uid: first(data, ["ownerUid", "uid"]),
    ownerName: first(data, ["ownerName", "customerName", "billingName"]),
    ownerEmail: first(data, ["ownerEmail", "email", "billingEmail"]),
    email: first(data, ["ownerEmail", "email", "billingEmail"]),
    ownerPhone: data.ownerPhone || null,
    companyName: data.companyName || null,
    status: data.status || null,
    activationEnabled: data.activationEnabled ?? null,
    availablePasses: first(data, ["availablePasses", "passesAvailable"], 0),
    purchasedPasses: first(data, ["purchasedPasses", "totalPurchased"], null),
    totalPurchased: first(data, ["totalPurchased", "purchasedPasses"], null),
    totalActivated: data.totalActivated ?? null,
    activationUpdatedAt: data.activationUpdatedAt || null,
    createdAt: data.createdAt || null,
    updatedAt: data.updatedAt || null,
  });
}

function accountingSummary(doc) {
  const data = doc.data() || {};
  const snapshotType = clean(data.snapshotType || "pay_period");
  const payoutStatus = clean(data.payoutStatus || (
    data.status === "complete" ? "pending" : data.status
  ));
  return serialize({
    id: doc.id,
    snapshotId: data.snapshotId || doc.id,
    snapshotType,
    payPeriodLabel: data.payPeriodLabel || data.monthLabel || data.monthKey || null,
    payPeriodStart: data.payPeriodStart || data.monthStart || null,
    payPeriodEnd: data.payPeriodEnd || data.monthEnd || null,
    monthKey: data.monthKey || null,
    status: data.status || null,
    runStatus: data.status || null,
    payoutStatus,
    rowCount: data.rowCount ?? null,
    rowsWritten: data.rowsWritten ?? null,
    totalSalesCount: first(data, ["totalSalesCount", "salesCount"], null),
    totalRevenue: first(data, ["totalRevenue", "revenue"], null),
    totalX: first(data, ["totalX", "x"], null),
    commissionPay: first(data, ["commissionPay", "totalCommissionPay"], null),
    vipPlusPay: first(data, ["vipPlusPay", "totalVipPlusPay"], null),
    programDirectorOverridePay: first(data, [
      "programDirectorOverridePay", "pdOverridePay", "totalProgramDirectorOverridePay"
    ], null),
    directorOverridePay: first(data, [
      "directorOverridePay", "totalDirectorOverridePay"
    ], null),
    personalBonusPay: first(data, ["personalBonusPay", "totalPersonalBonusPay"], null),
    leadershipBonusPay: first(data, ["leadershipBonusPay", "totalLeadershipBonusPay"], null),
    directorBonusPay: first(data, ["directorBonusPay", "totalDirectorBonusPay"], null),
    totalPayout: first(data, ["totalPayout", "grandTotal", "totalPay"], null),
    adjustmentTotal: data.adjustmentTotal ?? null,
    approvedAt: data.approvedAt || null,
    approvedByUid: data.approvedByUid || null,
    exportedAt: data.exportedAt || null,
    exportedByUid: data.exportedByUid || null,
    paidAt: data.paidAt || null,
    paidByUid: data.paidByUid || null,
    voidedAt: data.voidedAt || null,
    voidedByUid: data.voidedByUid || null,
    startedAt: data.startedAt || null,
    completedAt: data.completedAt || null,
    failedAt: data.failedAt || null,
    error: first(data, ["error", "failureReason"], null),
    updatedAt: data.updatedAt || null,
  });
}

function timestampMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  const millis = new Date(value).getTime();
  return Number.isFinite(millis) ? millis : 0;
}

function newestFirst(items) {
  return [...items].sort((left, right) => {
    const leftData = left.data() || {};
    const rightData = right.data() || {};
    const byTime = timestampMillis(first(rightData, ["createdAt", "timestamp", "updatedAt"])) -
      timestampMillis(first(leftData, ["createdAt", "timestamp", "updatedAt"]));
    return byTime || right.id.localeCompare(left.id);
  });
}

function auditSummary(doc) {
  const data = doc.data() || {};
  return serialize({
    id: doc.id,
    action: first(data, ["action", "actionType", "eventType"]),
    actorUid: first(data, ["actorUid", "adminUid"]),
    actorEmail: first(data, ["actorEmail", "adminEmail"]),
    targetType: data.targetType || null,
    targetId: data.targetId || null,
    requestId: first(data, ["requestId", "operationId"]),
    success: data.success ?? null,
    status: first(data, ["status", "resultStatus"]),
    reason: first(data, ["reason", "note"]),
    result: data.result || null,
    createdAt: first(data, ["createdAt", "timestamp"]),
  });
}

function attributionAuditSummary(doc) {
  const data = doc.data() || {};
  return serialize({
    id: doc.id,
    wooOrderId: first(data, ["wooOrderId", "orderId"]),
    action: first(data, ["action", "actionType", "eventType"]),
    reason: first(data, ["reason", "attributionIssue", "note"]),
    source: first(data, ["source", "attributionSource"]),
    previousSalesRepId: first(data, ["previousSalesRepId", "fromSalesRepId", "oldSalesRepId"]),
    salesRepId: first(data, ["salesRepId", "newSalesRepId", "toSalesRepId"]),
    affectedPayPeriod: first(data, ["affectedPayPeriod", "payPeriodId", "payrollSnapshotId"]),
    actorUid: first(data, ["actorUid", "adminUid"]),
    actorEmail: first(data, ["actorEmail", "adminEmail"]),
    requestId: first(data, ["requestId", "operationId"]),
    createdAt: first(data, ["createdAt", "timestamp", "updatedAt"]),
  });
}

function repSummary(doc, userDoc = null) {
  const rep = doc.data() || {};
  const user = userDoc?.exists ? userDoc.data() || {} : {};
  return serialize({
    id: doc.id,
    repId: rep.repId || doc.id,
    firebaseUid: rep.firebaseUid || null,
    firstName: first(rep, ["firstName"], user.firstName || null),
    lastName: first(rep, ["lastName"], user.lastName || null),
    fullName: first(rep, ["fullName", "displayName"], first(user, ["fullName", "displayName"])),
    email: first(rep, ["email"], user.email || null),
    active: first(rep, ["active"], user.active ?? null),
    status: first(rep, ["status"], user.status || null),
    currentRoleId: first(rep, ["currentRoleId"], user.currentRoleId || null),
    currentRoleName: first(rep, ["currentRoleName"], user.currentRoleName || null),
    programDirectorRepId: first(rep, ["programDirectorRepId"], user.programDirectorRepId || null),
    directorRepId: first(rep, ["directorRepId"], user.directorRepId || null),
    membershipActive: user.membershipActive ?? null,
    onboardingStatus: first(rep, ["onboardingStatus"], user.onboardingStatus || null),
    updatedAt: first(rep, ["updatedAt"], user.updatedAt || null),
  });
}

const SUMMARY_MAPPERS = Object.freeze({
  reviews: reviewSummary,
  memberships: membershipSummary,
  accessAccounts: accessAccountSummary,
  accountingSnapshots: accountingSummary,
  audit: auditSummary,
});

const RESOURCE_COLLECTIONS = Object.freeze({
  reviews: "salesAttributionReviews",
  memberships: "memberships",
  accessAccounts: "accessAccounts",
  accountingSnapshots: "payrollSnapshots",
  audit: "adminAudit",
});

async function actorFromRequest(req, admin, db) {
  const header = clean(req.headers.authorization);
  if (!header.startsWith("Bearer ")) {
    throw Object.assign(new Error("Authentication required"), { statusCode: 401, code: "authentication_required" });
  }
  let token;
  try {
    token = await admin.auth().verifyIdToken(header.slice(7));
  } catch (_) {
    throw Object.assign(new Error("Invalid or expired authentication token"), {
      statusCode: 401,
      code: "invalid_authentication_token",
    });
  }
  const snap = await db.collection("users").doc(token.uid).get();
  const user = snap.exists ? snap.data() || {} : {};
  if (!isPlatformAdmin(token, user)) {
    throw Object.assign(new Error("Platform administrator access required"), { statusCode: 403, code: "permission_denied" });
  }
  return { uid: token.uid, email: clean(token.email || user.email) };
}

function encodeCursor(doc, extra = {}) {
  return doc ? Buffer.from(JSON.stringify({ id: doc.id, ...extra })).toString("base64url") : null;
}

function decodeCursor(value) {
  if (!clean(value)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(clean(value), "base64url").toString("utf8"));
    if (!parsed || typeof parsed.id !== "string" || !parsed.id) throw new Error("bad");
    return parsed;
  } catch (_) {
    throw Object.assign(new Error("Invalid cursor"), { statusCode: 400, code: "invalid_cursor" });
  }
}

async function pageById(db, collectionName, mapper, input = {}) {
  const limit = clamp(input.limit);
  const cursor = decodeCursor(input.cursor);
  let query = db.collection(collectionName).orderBy("__name__").limit(limit + 1);
  if (cursor) query = query.startAfter(cursor.id);
  const snap = await query.get();
  const docs = snap.docs.slice(0, limit);
  return {
    items: docs.map(mapper),
    nextCursor: snap.docs.length > limit ? encodeCursor(docs[docs.length - 1]) : null,
  };
}

async function pageNewestFirst(db, collectionName, mapper, input = {}) {
  return pageOrdered(db, collectionName, mapper, "createdAt", input);
}

async function pageOrdered(db, collectionName, mapper, orderField, input = {}) {
  const limit = clamp(input.limit);
  const cursor = decodeCursor(input.cursor);
  if (cursor?.phase === "legacy") {
    return pageLegacyWithoutField(db, collectionName, mapper, orderField, cursor, limit);
  }
  let query = db.collection(collectionName)
    .orderBy(orderField, "desc")
    .orderBy("__name__", "desc")
    .limit(limit + 1);
  if (cursor) {
    const cursorDoc = await db.collection(collectionName).doc(cursor.id).get();
    if (!cursorDoc.exists) {
      throw Object.assign(new Error("Invalid cursor"), { statusCode: 400, code: "invalid_cursor" });
    }
    query = query.startAfter(cursorDoc);
  }
  const snap = await query.get();
  const docs = snap.docs.slice(0, limit);
  return {
    items: docs.map(mapper),
    nextCursor: snap.docs.length > limit
      ? encodeCursor(docs[docs.length - 1], { phase: "ordered" })
      : encodeCursor({ id: "__start__" }, { phase: "legacy" }),
  };
}

async function pageLegacyWithoutField(db, collectionName, mapper, orderField, cursor, limit) {
  const found = [];
  let afterId = cursor.id === "__start__" ? null : cursor.id;
  const batchSize = Math.max(100, Math.min(500, limit * 4));

  while (found.length <= limit) {
    let query = db.collection(collectionName).orderBy("__name__").limit(batchSize);
    if (afterId) query = query.startAfter(afterId);
    const snap = await query.get();
    if (snap.empty || snap.docs.length === 0) break;

    for (const row of snap.docs) {
      afterId = row.id;
      const data = row.data() || {};
      if (!Object.prototype.hasOwnProperty.call(data, orderField)) found.push(row);
      if (found.length > limit) break;
    }
    if (found.length > limit || snap.docs.length < batchSize) break;
  }

  const docs = found.slice(0, limit);
  return {
    items: docs.map(mapper),
    nextCursor: found.length > limit
      ? encodeCursor(docs[docs.length - 1], { phase: "legacy" })
      : null,
  };
}

async function countWhere(db, collection, field, operator, value) {
  return (await db.collection(collection).where(field, operator, value).count().get()).data().count;
}

async function overview(db) {
  const [reviews, errors, processing, snapshots] = await Promise.all([
    countWhere(db, "salesAttributionReviews", "status", "in", ["open", "in_review", "waiting"]),
    countWhere(db, "orderIngest", "error", ">", ""),
    countWhere(db, "orderIngest", "processing", "==", true),
    db.collection("payrollSnapshots").orderBy("updatedAt", "desc").limit(1).get(),
  ]);
  return {
    openSalesReviews: reviews,
    systemExceptions: errors,
    ordersProcessing: processing,
    currentAccountingSnapshot: snapshots.empty ? null : accountingSummary(snapshots.docs[0]),
  };
}

const ORDER_EXACT_FIELDS = Object.freeze([
  "wooOrderId", "billingEmail", "salesRepId", "membershipId", "accessAccountId",
]);

async function exactOrderSearch(db, value, limit) {
  const term = clean(value);
  if (!term) return [];
  const found = new Map();
  const direct = await db.collection("orderIngest").doc(term).get();
  if (direct.exists) found.set(direct.id, direct);
  for (const field of ORDER_EXACT_FIELDS) {
    if (found.size >= limit) break;
    const candidates = field === "billingEmail"
      ? Array.from(new Set([term, lower(term)]))
      : [term];
    for (const candidate of candidates) {
      const snap = await db.collection("orderIngest").where(field, "==", candidate).limit(limit).get();
      for (const doc of snap.docs) found.set(doc.id, doc);
      if (found.size >= limit) break;
    }
  }
  return newestFirst(Array.from(found.values())).slice(0, limit).map(orderSummary);
}

async function listOrders(db, input = {}) {
  const limit = clamp(input.limit);
  if (clean(input.search)) {
    return { items: await exactOrderSearch(db, input.search, limit), nextCursor: null, exactSearch: true };
  }
  return pageOrdered(db, "orderIngest", orderSummary, "receivedAt", input);
}

async function exactResourceSearch(db, collectionName, mapper, fields, input = {}) {
  const term = clean(input.search);
  if (!term) return pageOrdered(db, collectionName, mapper, "createdAt", input);
  const limit = clamp(input.limit);
  const found = new Map();
  const direct = await db.collection(collectionName).doc(term).get();
  if (direct.exists) found.set(direct.id, direct);
  for (const field of fields) {
    if (found.size >= limit) break;
    const candidates = field.toLowerCase().includes("email")
      ? Array.from(new Set([term, lower(term)])) : [term];
    for (const candidate of candidates) {
      const snap = await db.collection(collectionName)
        .where(field, "==", candidate).limit(limit).get();
      for (const doc of snap.docs) found.set(doc.id, doc);
      if (found.size >= limit) break;
    }
  }
  return { items: newestFirst(Array.from(found.values())).slice(0, limit).map(mapper),
    nextCursor: null, exactSearch: true };
}

async function getMembershipDetail(db, id) {
  const membershipId = clean(id);
  if (!membershipId) throw Object.assign(new Error("Membership ID is required"), { statusCode: 400 });
  const snap = await db.collection("memberships").doc(membershipId).get();
  if (!snap.exists) throw Object.assign(new Error("Membership not found"), { statusCode: 404 });
  return { membership: fullDocument(snap) };
}

async function getAccessAccountDetail(db, id) {
  const accountId = clean(id);
  if (!accountId) throw Object.assign(new Error("Access Account ID is required"), { statusCode: 400 });
  const snap = await db.collection("accessAccounts").doc(accountId).get();
  if (!snap.exists) throw Object.assign(new Error("Access Account not found"), { statusCode: 404 });
  return { accessAccount: fullDocument(snap) };
}

function payrollRowSummary(doc) {
  const data = doc.data() || {};
  return serialize({
    id: doc.id,
    repId: data.repId || doc.id,
    fullName: data.fullName || null,
    roleId: data.roleId || null,
    roleName: data.roleName || null,
    salesCount: first(data, ["currentPayPeriodSalesCount", "salesCount"], null),
    revenue: first(data, ["currentPayPeriodRevenue", "revenue"], null),
    x: first(data, ["currentPayPeriodX", "totalX", "x"], null),
    commissionPay: first(data, ["commissionPay", "baseCommissionPay"], null),
    vipPlusPay: data.vipPlusPay ?? null,
    programDirectorOverridePay: first(data, ["programDirectorOverridePay", "pdOverridePay"], null),
    directorOverridePay: data.directorOverridePay ?? null,
    overridePay: data.overridePay ?? null,
    personalBonusPay: data.personalBonusPay ?? null,
    leadershipBonusPay: data.leadershipBonusPay ?? null,
    directorBonusPay: data.directorBonusPay ?? null,
    adjustmentPay: data.adjustmentPay ?? null,
    totalPay: first(data, ["totalPay", "totalPayout"], null),
    workedShiftCount: data.workedShiftCount ?? null,
    missedShiftCount: data.missedShiftCount ?? null,
    approvedAbsenceCount: data.approvedAbsenceCount ?? null,
    hoursWorked: data.hoursWorked ?? null,
  });
}

async function getAccountingDetail(db, id, input = {}) {
  const snapshotId = clean(id);
  if (!snapshotId) throw Object.assign(new Error("Snapshot ID is required"), { statusCode: 400 });
  const ref = db.collection("payrollSnapshots").doc(snapshotId);
  const header = await ref.get();
  if (!header.exists) throw Object.assign(new Error("Payroll snapshot not found"), { statusCode: 404 });
  const limit = clamp(input.limit, 50, 50);
  const cursor = decodeCursor(input.cursor);
  let query = ref.collection("rows").orderBy("__name__").limit(limit + 1);
  if (cursor) query = query.startAfter(cursor.id);
  const rows = await query.get();
  const docs = rows.docs.slice(0, limit);
  return {
    snapshot: fullDocument(header),
    rows: docs.map(payrollRowSummary),
    nextCursor: rows.docs.length > limit ? encodeCursor(docs[docs.length - 1]) : null,
  };
}

function csvCell(value) {
  if (value == null) return "";
  const text = typeof value === "object" ? JSON.stringify(serialize(value)) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function getAccountingExport(db, id) {
  const snapshotId = clean(id);
  if (!snapshotId) throw Object.assign(new Error("Snapshot ID is required"), { statusCode: 400 });
  const ref = db.collection("payrollSnapshots").doc(snapshotId);
  const [header, rows, adjustments] = await Promise.all([
    ref.get(),
    ref.collection("rows").orderBy("__name__").get(),
    db.collection("accountingAdjustments").where("snapshotId", "==", snapshotId).get(),
  ]);
  if (!header.exists) throw Object.assign(new Error("Payroll snapshot not found"), { statusCode: 404 });
  const adjustmentDocs = adjustments.docs.map((row) => fullDocument(row));
  const unresolved = adjustmentDocs.filter((row) => ["pending", "approved"].includes(lower(row.status)));
  if (unresolved.length) {
    throw Object.assign(new Error("Resolve all adjustments before export"), {
      statusCode: 409, code: "unresolved_adjustments"
    });
  }
  const posted = adjustmentDocs.filter((row) => lower(row.status) === "posted");
  const byRep = new Map();
  for (const adjustment of posted) {
    const repId = clean(adjustment.repId);
    if (repId) byRep.set(repId, (byRep.get(repId) || 0) + Number(adjustment.amount || 0));
  }
  const columns = [
    "repId", "fullName", "roleId", "roleName", "salesCount", "revenue", "x",
    "commissionPay", "vipPlusPay", "programDirectorOverridePay", "directorOverridePay",
    "overridePay", "personalBonusPay", "leadershipBonusPay", "directorBonusPay",
    "basePay", "adjustmentPay", "totalPay"
  ];
  const output = [columns.join(",")];
  let exportTotal = 0;
  const normalizedRows = rows.docs.map(payrollRowSummary);
  for (const row of normalizedRows) {
    const basePay = Number(row.totalPay || 0);
    const adjustmentPay = byRep.get(clean(row.repId)) || 0;
    byRep.delete(clean(row.repId));
    const exportRow = { ...row, basePay, adjustmentPay, totalPay: basePay + adjustmentPay };
    exportTotal += exportRow.totalPay;
    output.push(columns.map((column) => csvCell(exportRow[column])).join(","));
  }
  for (const [repId, adjustmentPay] of byRep) {
    const exportRow = { repId, fullName: "Adjustment only", basePay: 0,
      adjustmentPay, totalPay: adjustmentPay };
    exportTotal += adjustmentPay;
    output.push(columns.map((column) => csvCell(exportRow[column])).join(","));
  }
  const unassignedAdjustmentTotal = posted
    .filter((row) => !clean(row.repId))
    .reduce((total, row) => total + Number(row.amount || 0), 0);
  if (unassignedAdjustmentTotal) {
    const exportRow = { repId: "UNASSIGNED", fullName: "Unassigned posted adjustments",
      basePay: 0, adjustmentPay: unassignedAdjustmentTotal, totalPay: unassignedAdjustmentTotal };
    exportTotal += unassignedAdjustmentTotal;
    output.push(columns.map((column) => csvCell(exportRow[column])).join(","));
  }
  return {
    snapshot: accountingSummary(header),
    filename: `experience-calgary-accounting-${snapshotId}.csv`,
    contentType: "text/csv; charset=utf-8",
    csv: output.join("\r\n"),
    rowCount: output.length - 1,
    baseRowCount: rows.size,
    postedAdjustmentCount: posted.length,
    exportTotal: Math.round(exportTotal * 100) / 100,
    adjustments: adjustmentDocs,
  };
}
async function getAccountingReconciliation(db, id) {
  const snapshotId = clean(id);
  if (!snapshotId) throw Object.assign(new Error("Snapshot ID is required"), { statusCode: 400 });
  const ref = db.collection("payrollSnapshots").doc(snapshotId);
  const header = await ref.get();
  if (!header.exists) throw Object.assign(new Error("Payroll snapshot not found"), { statusCode: 404 });
  const data = header.data() || {};
  const [rows, adjustments] = await Promise.all([
    ref.collection("rows").get(),
    db.collection("accountingAdjustments").where("snapshotId", "==", snapshotId).get(),
  ]);
  const normalizedRows = rows.docs.map(payrollRowSummary);
  const sum = (field) => normalizedRows.reduce((total, row) =>
    total + (Number.isFinite(Number(row[field])) ? Number(row[field]) : 0), 0);
  const adjustmentRows = adjustments.docs.map((row) => fullDocument(row));
  const postedAdjustments = adjustmentRows.filter((row) => lower(row.status) === "posted");
  const unresolvedAdjustments = adjustmentRows.filter((row) =>
    ["pending", "approved"].includes(lower(row.status))
  );
  const adjustmentTotal = postedAdjustments.reduce((total, row) => {
    const amount = Number(row.amount);
    return total + (Number.isFinite(amount) ? amount : 0);
  }, 0);
  const rowPayout = sum("totalPay");
  const resolvedPayout = resolveSnapshotPayout(data, rowPayout);
  const storedPayout = resolvedPayout.value;
  const rowsMatchHeader = Number(data.rowCount || 0) === rows.size &&
    Number(data.rowsWritten || 0) === rows.size;
  const payoutMatchesHeader = resolvedPayout.valid &&
    Math.abs(storedPayout - rowPayout) < 0.01;
  return serialize({
    snapshot: accountingSummary(header),
    totals: {
      rowCount: rows.size,
      salesCount: sum("salesCount"),
      revenue: sum("revenue"),
      x: sum("x"),
      commissionPay: sum("commissionPay"),
      vipPlusPay: sum("vipPlusPay"),
      programDirectorOverridePay: sum("programDirectorOverridePay"),
      directorOverridePay: sum("directorOverridePay"),
      personalBonusPay: sum("personalBonusPay"),
      leadershipBonusPay: sum("leadershipBonusPay"),
      directorBonusPay: sum("directorBonusPay"),
      rowPayout,
      adjustmentTotal,
      adjustedPayout: rowPayout + adjustmentTotal,
      storedPayout,
      storedPayoutSource: resolvedPayout.source,
      legacyTotalDerived: resolvedPayout.legacyDerived,
    },
    checks: {
      rowsMatchHeader,
      payoutMatchesHeader,
      snapshotComplete: clean(data.status).toLowerCase() === "complete",
      unresolvedAdjustmentCount: unresolvedAdjustments.length,
      readyForApproval: clean(data.status).toLowerCase() === "complete" &&
        rowsMatchHeader && payoutMatchesHeader && unresolvedAdjustments.length === 0,
    },
    adjustments: adjustmentRows,
  });
}
async function hydrateReps(db, docs) {
  const refs = docs
    .map((doc) => clean((doc.data() || {}).firebaseUid))
    .filter(Boolean)
    .map((uid) => db.collection("users").doc(uid));
  const userSnaps = refs.length ? await db.getAll(...refs) : [];
  const users = new Map(userSnaps.map((doc) => [doc.id, doc]));
  return docs.map((doc) => repSummary(
    doc,
    users.get(clean((doc.data() || {}).firebaseUid))
  ));
}

async function listReps(db, input = {}) {
  const limit = clamp(input.limit);
  const term = clean(input.search);
  if (term) {
    const found = new Map();
    const direct = await db.collection("reps").doc(term).get();
    if (direct.exists) found.set(direct.id, direct);
    for (const field of ["repId", "email", "fullName"]) {
      const candidates = field === "email"
        ? Array.from(new Set([term, lower(term)])) : [term];
      for (const candidate of candidates) {
        const snap = await db.collection("reps")
          .where(field, "==", candidate).limit(limit).get();
        for (const doc of snap.docs) found.set(doc.id, doc);
        if (found.size >= limit) break;
      }
      if (found.size >= limit) break;
    }
    const docs = newestFirst(Array.from(found.values())).slice(0, limit);
    return { items: await hydrateReps(db, docs), nextCursor: null, exactSearch: true };
  }

  const page = await pageOrdered(db, "reps", (row) => row, "updatedAt", input);
  return {
    items: await hydrateReps(db, page.items),
    nextCursor: page.nextCursor,
  };
}

async function queryByOrderId(db, collectionName, orderId, limit = 50) {
  const snap = await db.collection(collectionName).where("wooOrderId", "==", orderId).limit(limit).get();
  return snap.docs;
}

async function getOrderDetail(db, id) {
  const orderId = clean(id);
  if (!orderId) throw Object.assign(new Error("Order id is required"), { statusCode: 400 });
  const snap = await db.collection("orderIngest").doc(orderId).get();
  if (!snap.exists) throw Object.assign(new Error("Order not found"), { statusCode: 404 });
  const data = snap.data() || {};
  const wooOrderId = clean(data.wooOrderId || orderId);
  const [review, membership, access, adminAudits, attributionAudits] = await Promise.all([
    db.collection("salesAttributionReviews").doc(wooOrderId).get(),
    data.membershipId ? db.collection("memberships").doc(clean(data.membershipId)).get() : Promise.resolve(null),
    data.accessAccountId ? db.collection("accessAccounts").doc(clean(data.accessAccountId)).get() : Promise.resolve(null),
    db.collection("adminAudit").where("targetId", "==", orderId).limit(50).get(),
    queryByOrderId(db, "salesAttributionAudits", wooOrderId),
  ]);
  return {
    order: fullDocument(snap, { omit: ["payloadRaw"] }),
    attribution: serialize({
      salesRepId: data.salesRepId || null,
      salesRepName: data.salesRepName || null,
      roleIdAtSale: data.roleIdAtSale || null,
      programDirectorRepId: data.programDirectorRepId || null,
      directorRepId: data.directorRepId || null,
      attributionStatus: data.attributionStatus || null,
      attributionSource: data.attributionSource || null,
      attributionIssue: data.attributionIssue || null,
      attributionVersion: data.attributionVersion || null,
      attributionFinalized: data.attributionFinalized === true,
      attributionCapturedAt: data.attributionCapturedAt || null,
      attributionValidatedAt: data.attributionValidatedAt || null,
    }),
    review: review.exists ? reviewSummary(review) : null,
    membership: membership?.exists ? fullDocument(membership) : null,
    accessAccount: access?.exists ? fullDocument(access) : null,
    history: {
      admin: newestFirst(adminAudits.docs).map(auditSummary),
      attribution: newestFirst(attributionAudits).map(attributionAuditSummary),
    },
  };
}

module.exports = function registerAdminCenterRoutes(app, dependencies) {
  const { admin, db, logger } = dependencies;
  const executeAction = createAdminCenterActions(dependencies);
  const wrap = (handler) => async (req, res) => {
    try {
      const actor = await actorFromRequest(req, admin, db);
      const result = await handler(req.body || {}, actor);
      return res.status(200).json({ ok: true, result });
    } catch (error) {
      logger.error("ADMIN_CENTER_ERROR", { path: req.path, error: error.message });
      return res.status(error.statusCode || 400).json({
        ok: false, code: error.code || "admin_center_error", error: error.message,
      });
    }
  };

  app.get("/admin/center/overview", wrap(() => overview(db)));
  app.post("/admin/center/query", wrap(async (input) => {
    const resource = clean(input.resource);
    if (resource === "orders") return listOrders(db, input);
    if (resource === "orderDetail") return getOrderDetail(db, input.id);
    if (resource === "memberships") return exactResourceSearch(
      db, "memberships", membershipSummary,
      ["membershipId", "billingEmail", "email", "memberEmail"], input);
    if (resource === "membershipDetail") return getMembershipDetail(db, input.id);
    if (resource === "accessAccounts") return exactResourceSearch(
      db, "accessAccounts", accessAccountSummary,
      ["accountId", "ownerEmail", "email", "billingEmail"], input);
    if (resource === "accessAccountDetail") return getAccessAccountDetail(db, input.id);
    if (resource === "accountingDetail") return getAccountingDetail(db, input.id, input);
    if (resource === "accountingReconciliation") return getAccountingReconciliation(db, input.id);
    if (resource === "accountingExport") return getAccountingExport(db, input.id);
    if (resource === "accountingAdjustments") {
      return pageOrdered(db, "accountingAdjustments", (row) => fullDocument(row), "createdAt", input);
    }
    if (resource === "reps") return listReps(db, input);
    if (resource === "repDetail") {
      const result = await require("../lib/repLifecycle").getRepLifecycle({ db, repId: input.id });
      return serialize(result);
    }
    if (resource === "audit") return pageNewestFirst(db, "adminAudit", auditSummary, input);
    const collectionName = RESOURCE_COLLECTIONS[resource];
    const mapper = SUMMARY_MAPPERS[resource];
    if (collectionName && mapper) {
      const field = resource === "accountingSnapshots" ? "updatedAt" : "createdAt";
      return pageOrdered(db, collectionName, mapper, field, input);
    }
    throw Object.assign(new Error("Unsupported Admin Center resource"), { statusCode: 400 });
  }));

  app.post("/admin/center/action", wrap(executeAction));
};

module.exports.actorFromRequest = actorFromRequest;
module.exports.auditSummary = auditSummary;
module.exports.accessAccountSummary = accessAccountSummary;
module.exports.accountingSummary = accountingSummary;
module.exports.decodeCursor = decodeCursor;
module.exports.attributionAuditSummary = attributionAuditSummary;
module.exports.isRefundedOrder = isOrderRefunded;
module.exports.membershipSummary = membershipSummary;
module.exports.newestFirst = newestFirst;
module.exports.overview = overview;
module.exports.orderPaymentState = orderPaymentState;
module.exports.orderProcessingState = orderProcessingState;
module.exports.orderSummary = orderSummary;
module.exports.pageNewestFirst = pageNewestFirst;
module.exports.pageOrdered = pageOrdered;
module.exports.fullDocument = fullDocument;
module.exports.repSummary = repSummary;
module.exports.exactOrderSearch = exactOrderSearch;
module.exports.exactResourceSearch = exactResourceSearch;
module.exports.getAccountingDetail = getAccountingDetail;
module.exports.getAccountingExport = getAccountingExport;
module.exports.getAccountingReconciliation = getAccountingReconciliation;
module.exports.getAccessAccountDetail = getAccessAccountDetail;
module.exports.getMembershipDetail = getMembershipDetail;
module.exports.listReps = listReps;
module.exports.payrollRowSummary = payrollRowSummary;
