const { recordFirstActualShift } = require("./repLifecycle");

module.exports = {
  resolveAttendanceStatuses,
};

async function resolveAttendanceStatuses(db, admin, logger) {
  logger.info("attendanceResolver started");

  const yesterday = getYesterdayLocal();
  const yesterdayKey = formatDateKey(yesterday);

  logger.info(`attendanceResolver resolving shiftDateKey=${yesterdayKey}`);

  const [shiftsSnap, timeOffSnap, attendanceSnap] = await Promise.all([
    db
      .collection("scheduledShifts")
      .where("shiftDateKey", "==", yesterdayKey)
      .where("status", "==", "Scheduled")
      .get(),

    db
      .collection("timeOffRequests")
      .where("status", "==", "Approved")
      .get(),

    db.collection("attendanceLogs").get(),
  ]);

  const approvedTimeOffByRepAndDateKey = {};
  timeOffSnap.forEach((doc) => {
    const row = doc.data() || {};
    const repId = String(row.repId || "");
    if (!repId) return;

    const requestedDate = parseDate(row.requestedDate);
    if (!requestedDate) return;

    const requestedDateKey = formatDateKey(requestedDate);
    const mapKey = `${repId}__${requestedDateKey}`;
    approvedTimeOffByRepAndDateKey[mapKey] = true;
  });

  const attendanceByShiftId = {};
  attendanceSnap.forEach((doc) => {
    const row = doc.data() || {};
    const shiftId = String(row.shiftId || "");
    if (!shiftId) return;

    if (!attendanceByShiftId[shiftId]) {
      attendanceByShiftId[shiftId] = [];
    }

    attendanceByShiftId[shiftId].push({
      docId: doc.id,
      ...row,
    });
  });

  let completedCount = 0;
  let approvedAbsenceCount = 0;
  let missedCount = 0;

  for (const shiftDoc of shiftsSnap.docs) {
    const shift = shiftDoc.data() || {};
    const scheduledShiftDocId = String(shiftDoc.id || "");
    const repId = String(shift.repId || "");
    const shiftDate = parseDate(shift.shiftDate);
    const shiftDateKey = String(shift.shiftDateKey || yesterdayKey);

    if (!scheduledShiftDocId || !repId) continue;

    const linkedAttendanceRows = attendanceByShiftId[scheduledShiftDocId] || [];
    const completedAttendance = linkedAttendanceRows.find((row) =>
      isCompletedAttendance(row)
    );

    /**
     * 1) COMPLETED
     * If an attendance log exists for this shift and shows completion,
     * the scheduled shift should also be marked Completed.
     */
    if (completedAttendance) {
      await Promise.all([
        shiftDoc.ref.set(
          {
            status: "Completed",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        ),
        db
          .collection("attendanceLogs")
          .doc(completedAttendance.docId)
          .set(
            {
              status: "Completed",
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          ),
      ]);

      const firstShiftAt =
        parseDate(completedAttendance.clockInAt) ||
        parseDate(shift.scheduledStartAt) ||
        shiftDate;
      if (firstShiftAt) {
        await recordFirstActualShift({
          db,
          admin,
          repId,
          shiftAt: firstShiftAt,
        });
      }

      completedCount += 1;
      continue;
    }

    /**
     * 2) APPROVED ABSENCE
     * Match by repId + requestedDate for the same day.
     */
    const approvedMapKey = `${repId}__${shiftDateKey}`;
    const hasApprovedAbsence = !!approvedTimeOffByRepAndDateKey[approvedMapKey];

    if (hasApprovedAbsence) {
      await Promise.all([
        shiftDoc.ref.set(
          {
            status: "Approved Absence",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        ),
        upsertAttendanceStatusForShift(
          db,
          admin,
          linkedAttendanceRows,
          shift,
          scheduledShiftDocId,
          repId,
          shiftDate,
          shiftDateKey,
          "Approved Absence"
        ),
      ]);

      approvedAbsenceCount += 1;
      continue;
    }

    /**
     * 3) MISSED
     * No completed attendance and no approved time off.
     */
    await Promise.all([
      shiftDoc.ref.set(
        {
          status: "Missed",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      ),
      upsertAttendanceStatusForShift(
        db,
        admin,
        linkedAttendanceRows,
        shift,
        scheduledShiftDocId,
        repId,
        shiftDate,
        shiftDateKey,
        "Missed"
      ),
    ]);

    missedCount += 1;
  }

  logger.info(
    `attendanceResolver completed | completed=${completedCount} approvedAbsence=${approvedAbsenceCount} missed=${missedCount}`
  );
}

async function upsertAttendanceStatusForShift(
  db,
  admin,
  linkedAttendanceRows,
  shift,
  scheduledShiftDocId,
  repId,
  shiftDate,
  shiftDateKey,
  status
) {
  const nowTs = admin.firestore.FieldValue.serverTimestamp();

  if (linkedAttendanceRows.length > 0) {
    const targetDocId = String(linkedAttendanceRows[0].docId || "");
    if (!targetDocId) return;

    await db
      .collection("attendanceLogs")
      .doc(targetDocId)
      .set(
        {
          status,
          updatedAt: nowTs,
        },
        { merge: true }
      );

    return;
  }

  await db.collection("attendanceLogs").add({
    shiftId: scheduledShiftDocId,
    repId,
    shiftDate: shiftDate || null,
    shiftDateKey: shiftDateKey || "",
    scheduledStart: shift.scheduledStart || null,
    scheduledEnd: shift.scheduledEnd || null,
    locationName: shift.locationName || "",
    locationType: shift.locationType || "",
    locationId: shift.locationId || "",
    programDirectorRepId: shift.programDirectorRepId || "",
    directorRepId: shift.directorRepId || "",
    status,
    createdAt: nowTs,
    updatedAt: nowTs,
  });
}

function isCompletedAttendance(row) {
  const status = String(row?.status || "").trim().toLowerCase();

  if (status === "completed") return true;

  const clockInAt = parseDate(row?.clockInAt);
  const clockOutAt = parseDate(row?.clockOutAt);

  return !!(clockInAt && clockOutAt && clockOutAt >= clockInAt);
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

function getYesterdayLocal() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
}

function formatDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
