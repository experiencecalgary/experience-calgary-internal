"use strict";

/**
 * roleResolver.js
 *
 * Purpose:
 * Resolve the correct role for a rep at a specific date or over a period.
 *
 * Design:
 * - reps.currentRoleId remains the fast current-state pointer.
 * - reps/{repId}/roleHistory is the historical truth for period-accurate logic.
 * - If no matching roleHistory exists, resolver falls back to currentRoleId.
 *
 * Expected roleHistory doc shape:
 * {
 *   roleId: "ROLE2",
 *   effectiveStart: Timestamp | ISO string | Date,
 *   effectiveEnd: Timestamp | ISO string | Date | null,
 *   createdAt: Timestamp,
 *   source: "onboarding" | "promotion" | "manual_update",
 *   reason: "Initial onboarding" | "Promotion to ROLE3" | ...
 * }
 */

async function resolveRoleAtDate(db, repId, asOfDate, options = {}) {
  const date = toDateOrNull(asOfDate);
  if (!repId) {
    return buildEmptyResolution("Missing repId");
  }
  if (!date) {
    return buildEmptyResolution("Invalid asOfDate");
  }

  const { repDoc, historyEntries } = await loadRepAndRoleHistory(db, repId);

  const matched = findRoleHistoryEntryForDate(historyEntries, date);

  if (matched) {
    return {
      repId: String(repId),
      roleId: String(matched.roleId || ""),
      source: "roleHistory",
      matchedHistoryEntryId: String(matched.id || ""),
      effectiveStart: matched.effectiveStart || null,
      effectiveEnd: matched.effectiveEnd || null,
      repDocExists: Boolean(repDoc),
      fallbackUsed: false,
      note: "",
    };
  }

  const fallbackRoleId = getRepCurrentRoleId(repDoc);
  if (fallbackRoleId) {
    return {
      repId: String(repId),
      roleId: fallbackRoleId,
      source: "rep.currentRoleId",
      matchedHistoryEntryId: "",
      effectiveStart: null,
      effectiveEnd: null,
      repDocExists: Boolean(repDoc),
      fallbackUsed: true,
      note: "No matching roleHistory entry found; used currentRoleId fallback.",
    };
  }

  return buildEmptyResolution(
    "No matching roleHistory entry and no currentRoleId fallback.",
    repId
  );
}

async function resolveRoleForClosedMonth(db, repId, year, monthIndexZeroBased) {
  /**
   * Example:
   * year=2026, monthIndexZeroBased=3 => April 2026
   *
   * Strategy:
   * Resolve role as of the LAST MOMENT of the evaluated month.
   * That matches your no-mid-month-promotion rule much better than using runtime current role.
   */
  const endOfMonth = new Date(
    year,
    monthIndexZeroBased + 1,
    0,
    23,
    59,
    59,
    999
  );

  return resolveRoleAtDate(db, repId, endOfMonth);
}

async function resolveRoleForPayPeriod(db, repId, periodStart, periodEnd) {
  /**
   * For now, pay-period role resolution uses the role active at the END of the period.
   * This is usually correct for your rule set as long as promotions do not activate mid-month.
   *
   * Sale-time commission math should still use roleIdAtSale from orderIngest wherever possible.
   */
  const end = toDateOrNull(periodEnd) || toDateOrNull(periodStart);
  return resolveRoleAtDate(db, repId, end);
}

async function getRoleHistoryEntries(db, repId) {
  if (!repId) return [];

  const snap = await db
    .collection("reps")
    .doc(String(repId))
    .collection("roleHistory")
    .get();

  const entries = [];
  snap.forEach((doc) => {
    const row = doc.data() || {};
    entries.push(normalizeRoleHistoryEntry(doc.id, row));
  });

  return sortRoleHistoryEntries(entries);
}

async function createInitialRoleHistoryEntry(
  db,
  admin,
  repId,
  {
    roleId,
    effectiveStart,
    source = "onboarding",
    reason = "Initial onboarding",
    createdBy = "system",
  } = {}
) {
  if (!repId) {
    throw new Error("createInitialRoleHistoryEntry: missing repId");
  }

  const safeRoleId = String(roleId || "").trim();
  if (!safeRoleId) {
    throw new Error("createInitialRoleHistoryEntry: missing roleId");
  }

  const safeStart = toDateOrNull(effectiveStart);
  if (!safeStart) {
    throw new Error("createInitialRoleHistoryEntry: invalid effectiveStart");
  }

  const ref = db
    .collection("reps")
    .doc(String(repId))
    .collection("roleHistory")
    .doc();

  await ref.set({
    repId: String(repId),
    roleId: safeRoleId,
    effectiveStart: admin.firestore.Timestamp.fromDate(safeStart),
    effectiveEnd: null,
    source: String(source || "onboarding"),
    reason: String(reason || "Initial onboarding"),
    createdBy: String(createdBy || "system"),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return ref.id;
}

async function appendRoleHistoryEntry(
  db,
  admin,
  repId,
  {
    roleId,
    effectiveStart,
    source = "manual_update",
    reason = "",
    createdBy = "system",
    closePreviousEntry = true,
  } = {}
) {
  if (!repId) {
    throw new Error("appendRoleHistoryEntry: missing repId");
  }

  const safeRoleId = String(roleId || "").trim();
  if (!safeRoleId) {
    throw new Error("appendRoleHistoryEntry: missing roleId");
  }

  const safeStart = toDateOrNull(effectiveStart);
  if (!safeStart) {
    throw new Error("appendRoleHistoryEntry: invalid effectiveStart");
  }

  const roleHistoryRef = db
    .collection("reps")
    .doc(String(repId))
    .collection("roleHistory");

  const existingEntries = await getRoleHistoryEntries(db, repId);
  const latestOpenEntry = getLatestOpenRoleHistoryEntry(existingEntries);

  const batch = db.batch();

  if (closePreviousEntry && latestOpenEntry?.id) {
    batch.set(
      roleHistoryRef.doc(latestOpenEntry.id),
      {
        effectiveEnd: admin.firestore.Timestamp.fromDate(
          new Date(safeStart.getTime() - 1)
        ),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }

  const newRef = roleHistoryRef.doc();
  batch.set(newRef, {
    repId: String(repId),
    roleId: safeRoleId,
    effectiveStart: admin.firestore.Timestamp.fromDate(safeStart),
    effectiveEnd: null,
    source: String(source || "manual_update"),
    reason: String(reason || ""),
    createdBy: String(createdBy || "system"),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  batch.set(
    db.collection("reps").doc(String(repId)),
    {
      currentRoleId: safeRoleId,
      roleStartDate: admin.firestore.Timestamp.fromDate(safeStart),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  await batch.commit();

  return newRef.id;
}

/* -------------------------------------------------------------------------- */
/*                                  Internals                                  */
/* -------------------------------------------------------------------------- */

async function loadRepAndRoleHistory(db, repId) {
  const repRef = db.collection("reps").doc(String(repId));
  const [repSnap, historySnap] = await Promise.all([
    repRef.get(),
    repRef.collection("roleHistory").get(),
  ]);

  const repDoc = repSnap.exists ? repSnap.data() || {} : null;

  const historyEntries = [];
  historySnap.forEach((doc) => {
    historyEntries.push(normalizeRoleHistoryEntry(doc.id, doc.data() || {}));
  });

  return {
    repDoc,
    historyEntries: sortRoleHistoryEntries(historyEntries),
  };
}

function findRoleHistoryEntryForDate(historyEntries = [], date) {
  const target = toDateOrNull(date);
  if (!target) return null;

  for (const entry of historyEntries) {
    const start = toDateOrNull(entry.effectiveStart);
    const end = toDateOrNull(entry.effectiveEnd);

    if (!start) continue;

    const startsOnOrBefore = start.getTime() <= target.getTime();
    const endsAfterOrOpen = !end || end.getTime() >= target.getTime();

    if (startsOnOrBefore && endsAfterOrOpen) {
      return entry;
    }
  }

  return null;
}

function normalizeRoleHistoryEntry(id, row = {}) {
  return {
    id: String(id || ""),
    repId: String(row.repId || ""),
    roleId: String(row.roleId || ""),
    effectiveStart: toDateOrNull(row.effectiveStart),
    effectiveEnd: toDateOrNull(row.effectiveEnd),
    source: String(row.source || ""),
    reason: String(row.reason || ""),
    createdBy: String(row.createdBy || ""),
    createdAt: toDateOrNull(row.createdAt),
    updatedAt: toDateOrNull(row.updatedAt),
  };
}

function sortRoleHistoryEntries(entries = []) {
  return [...entries].sort((a, b) => {
    const aStart = toDateOrNull(a.effectiveStart);
    const bStart = toDateOrNull(b.effectiveStart);

    const aTime = aStart ? aStart.getTime() : 0;
    const bTime = bStart ? bStart.getTime() : 0;

    if (aTime !== bTime) return aTime - bTime;

    const aCreated = toDateOrNull(a.createdAt);
    const bCreated = toDateOrNull(b.createdAt);

    const aCreatedTime = aCreated ? aCreated.getTime() : 0;
    const bCreatedTime = bCreated ? bCreated.getTime() : 0;

    return aCreatedTime - bCreatedTime;
  });
}

function getLatestOpenRoleHistoryEntry(entries = []) {
  const openEntries = entries.filter((entry) => !toDateOrNull(entry.effectiveEnd));
  if (openEntries.length === 0) return null;
  return openEntries[openEntries.length - 1];
}

function getRepCurrentRoleId(repDoc = null) {
  if (!repDoc || typeof repDoc !== "object") return "";
  return String(repDoc.currentRoleId || "").trim();
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

function buildEmptyResolution(note = "", repId = "") {
  return {
    repId: String(repId || ""),
    roleId: "",
    source: "",
    matchedHistoryEntryId: "",
    effectiveStart: null,
    effectiveEnd: null,
    repDocExists: false,
    fallbackUsed: false,
    note: String(note || ""),
  };
}

module.exports = {
  resolveRoleAtDate,
  resolveRoleForClosedMonth,
  resolveRoleForPayPeriod,
  getRoleHistoryEntries,
  createInitialRoleHistoryEntry,
  appendRoleHistoryEntry,
};
