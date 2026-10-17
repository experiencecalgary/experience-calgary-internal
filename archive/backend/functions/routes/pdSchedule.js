/* functions/routes/pdSchedule.js */

function clean(v) {
  return v == null ? "" : String(v).trim();
}

function boolValue(v) {
  return v === true || String(v).toLowerCase() === "true";
}

function normalizeDateKey(v) {
  const s = clean(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";
  return s;
}

function normalizeTime(v) {
  const s = clean(v);
  if (!/^\d{2}:\d{2}$/.test(s)) return "";
  return s;
}

function normalizeWeeks(v) {
  const n = Number(v || 1);
  if (!Number.isFinite(n)) return 1;
  if (n < 1) return 1;
  if (n > 6) return 6;
  return Math.floor(n);
}

function normalizeLocationKey(v) {
  return clean(v)
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function titleCaseLocation(v) {
  const s = clean(v);
  if (!s) return "";

  return s
    .split(/\s+/)
    .map((word) => {
      if (!word) return "";
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

function addDaysToDateKey(dateKey, days) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days, 12, 0, 0));
  return [
    dt.getUTCFullYear(),
    String(dt.getUTCMonth() + 1).padStart(2, "0"),
    String(dt.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function buildWeekEndDateKey(weekStartDateKey) {
  return addDaysToDateKey(weekStartDateKey, 6);
}

function buildRangeEndDateKey(startDateKey, weeks) {
  return addDaysToDateKey(startDateKey, normalizeWeeks(weeks) * 7 - 1);
}

function durationHours(startTime, endTime) {
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);

  if (
    !Number.isFinite(sh) ||
    !Number.isFinite(sm) ||
    !Number.isFinite(eh) ||
    !Number.isFinite(em)
  ) {
    return null;
  }

  return ((eh * 60 + em) - (sh * 60 + sm)) / 60;
}

function toEdmontonTimestamp(admin, dateKey, timeString) {
  const localIso = `${dateKey}T${timeString}:00`;
  const asDate = new Date(localIso);

  if (Number.isNaN(asDate.getTime())) return null;

  return admin.firestore.Timestamp.fromDate(asDate);
}

function getHeader(req, name) {
  return clean(req.headers[name.toLowerCase()]);
}

function getWpUserId(req) {
  return clean(
    getHeader(req, "x-wp-user-id") ||
      req.query.wpUserId ||
      req.body?.wpUserId ||
      req.body?.wordpressUserId
  );
}

function getRequestSecret(req) {
  return clean(
    getHeader(req, "x-pd-schedule-secret") ||
      req.query.secret ||
      req.body?.secret
  );
}

function buildRepPayload(doc) {
  const d = doc.data() || {};

  return {
    uid: doc.id,
    repId: clean(d.repId),
    fullName: clean(d.fullName),
    firstName: clean(d.firstName),
    lastName: clean(d.lastName),
    email: clean(d.email),
    phone: clean(d.phone),
    photo_url: clean(d.photo_url),
    currentRoleId: clean(d.currentRoleId),
    currentRoleName: clean(d.currentRoleName),
    programDirectorRepId: clean(d.programDirectorRepId),
    active: d.active === true,
    status: clean(d.status || "active"),
    isSelf: false,
  };
}

async function requirePdActor({ req, db, logger, PD_SCHEDULE_SECRET }) {
  const expectedSecret =
    PD_SCHEDULE_SECRET && typeof PD_SCHEDULE_SECRET.value === "function"
      ? clean(PD_SCHEDULE_SECRET.value())
      : "";

  if (expectedSecret) {
    const incomingSecret = getRequestSecret(req);
    if (!incomingSecret || incomingSecret !== expectedSecret) {
      const err = new Error("Invalid scheduler secret");
      err.status = 401;
      throw err;
    }
  }

  const wpUserId = getWpUserId(req);

  if (!wpUserId) {
    const err = new Error("Missing WordPress user ID");
    err.status = 401;
    throw err;
  }

  const userSnap = await db
    .collection("users")
    .where("wordpressUserId", "==", wpUserId)
    .limit(1)
    .get();

  let pdDoc = null;
  let pdUid = null;

  if (!userSnap.empty) {
    const doc = userSnap.docs[0];
    pdDoc = doc.data() || {};
    pdUid = doc.id;
  } else {
    const fallbackSnap = await db
      .collection("users")
      .where("wpUserId", "==", wpUserId)
      .limit(1)
      .get();

    if (!fallbackSnap.empty) {
      const doc = fallbackSnap.docs[0];
      pdDoc = doc.data() || {};
      pdUid = doc.id;
    }
  }

  if (!pdDoc || !pdUid) {
    const err = new Error("No matching PD user found");
    err.status = 403;
    throw err;
  }

  const active = pdDoc.active === true && pdDoc.status !== "inactive";
  const disabled = pdDoc.disabled === true || pdDoc.enabled === false;
  const canManageSchedule = pdDoc.canManageSchedule === true;
  const repId = clean(pdDoc.repId);

  if (!active || disabled || !canManageSchedule || !repId) {
    logger.warn("PD_SCHEDULE_FORBIDDEN", {
      wpUserId,
      pdUid,
      repId,
      active,
      disabled,
      canManageSchedule,
    });

    const err = new Error("User is not allowed to manage schedules");
    err.status = 403;
    throw err;
  }

  return {
    uid: pdUid,
    repId,
    fullName: clean(pdDoc.fullName),
    email: clean(pdDoc.email),
    currentRoleId: clean(pdDoc.currentRoleId),
    currentRoleName: clean(pdDoc.currentRoleName),
    raw: pdDoc,
  };
}

async function getPdTeam({ db, pdRepId }) {
  const teamSnap = await db
    .collection("users")
    .where("userType", "==", "rep")
    .where("programDirectorRepId", "==", pdRepId)
    .where("active", "==", true)
    .get();

  const team = teamSnap.docs
    .map(buildRepPayload)
    .filter((rep) => rep.repId);

  const selfSnap = await db
    .collection("users")
    .where("repId", "==", pdRepId)
    .where("active", "==", true)
    .limit(1)
    .get();

  if (!selfSnap.empty) {
    const selfRep = buildRepPayload(selfSnap.docs[0]);
    selfRep.isSelf = true;
    selfRep.programDirectorRepId = clean(selfRep.programDirectorRepId);

    const alreadyIncluded = team.some(
      (rep) => clean(rep.repId) === clean(selfRep.repId)
    );

    if (selfRep.repId && !alreadyIncluded) {
      team.unshift(selfRep);
    }
  }

  return team.sort((a, b) => {
    if (a.isSelf && !b.isSelf) return -1;
    if (!a.isSelf && b.isSelf) return 1;
    return a.fullName.localeCompare(b.fullName);
  });
}

async function assertRepBelongsToPd({ db, pdRepId, repId }) {
  const requestedRepId = clean(repId);
  const actorRepId = clean(pdRepId);

  if (!requestedRepId || !actorRepId) return null;

  if (requestedRepId === actorRepId) {
    const selfSnap = await db
      .collection("users")
      .where("repId", "==", actorRepId)
      .where("active", "==", true)
      .limit(1)
      .get();

    if (selfSnap.empty) return null;

    const doc = selfSnap.docs[0];
    const d = doc.data() || {};

    return {
      uid: doc.id,
      repId: clean(d.repId),
      fullName: clean(d.fullName),
      email: clean(d.email),
      currentRoleId: clean(d.currentRoleId),
      currentRoleName: clean(d.currentRoleName),
      isSelf: true,
    };
  }

  const snap = await db
    .collection("users")
    .where("repId", "==", requestedRepId)
    .where("programDirectorRepId", "==", actorRepId)
    .where("active", "==", true)
    .limit(1)
    .get();

  if (snap.empty) return null;

  const doc = snap.docs[0];
  const d = doc.data() || {};

  return {
    uid: doc.id,
    repId: clean(d.repId),
    fullName: clean(d.fullName),
    email: clean(d.email),
    currentRoleId: clean(d.currentRoleId),
    currentRoleName: clean(d.currentRoleName),
    isSelf: false,
  };
}

async function findExistingShift({ db, repId, dateKey }) {
  const snap = await db
    .collection("scheduledShifts")
    .where("repId", "==", repId)
    .where("shiftDateKey", "==", dateKey)
    .limit(5)
    .get();

  if (snap.empty) return null;

  const protectedStatuses = new Set([
    "Completed",
    "Missed",
    "Approved Absence",
    "Review Needed",
    "Forgot Clock Out",
  ]);

  const docs = snap.docs.map((doc) => ({
    id: doc.id,
    ref: doc.ref,
    data: doc.data() || {},
  }));

  const protectedDoc = docs.find((row) =>
    protectedStatuses.has(clean(row.data.status))
  );

  if (protectedDoc) return protectedDoc;

  return docs[0];
}

async function getLocations({ db }) {
  const snap = await db.collection("locations").get();

  return snap.docs
    .map((doc) => {
      const d = doc.data() || {};
      const locationName = clean(d.location || d.locationName || d.name);
      const locationKey =
        clean(d.locationKey) || normalizeLocationKey(locationName);

      return {
        id: doc.id,
        location: locationName,
        locationName,
        locationKey,
        active: d.active !== false,
      };
    })
    .filter((row) => row.locationName && row.active)
    .sort((a, b) => a.locationName.localeCompare(b.locationName));
}

async function findLocationByKey({ db, locationKey }) {
  if (!locationKey) return null;

  const byKeySnap = await db
    .collection("locations")
    .where("locationKey", "==", locationKey)
    .limit(1)
    .get();

  if (!byKeySnap.empty) {
    const doc = byKeySnap.docs[0];
    const d = doc.data() || {};
    return {
      id: doc.id,
      ref: doc.ref,
      location: clean(d.location || d.locationName || d.name),
      locationKey: clean(d.locationKey) || locationKey,
    };
  }

  const allSnap = await db.collection("locations").get();

  for (const doc of allSnap.docs) {
    const d = doc.data() || {};
    const locationName = clean(d.location || d.locationName || d.name);
    const existingKey =
      clean(d.locationKey) || normalizeLocationKey(locationName);

    if (existingKey === locationKey) {
      return {
        id: doc.id,
        ref: doc.ref,
        location: locationName,
        locationKey: existingKey,
      };
    }
  }

  return null;
}

function mapShiftDoc(doc) {
  const d = doc.data() || {};

  return {
    id: doc.id,
    repId: clean(d.repId),
    repName: clean(d.repName),
    shiftDateKey: clean(d.shiftDateKey),
    scheduledStartTime: clean(d.scheduledStartTime),
    scheduledEndTime: clean(d.scheduledEndTime),
    locationName: clean(d.locationName),
    locationId: clean(d.locationId),
    locationType: clean(d.locationType),
    notes: clean(d.notes),
    status: clean(d.status),
    source: clean(d.source),
    scheduleBatchId: clean(d.scheduleBatchId),
  };
}

module.exports = function registerPdScheduleRoutes(
  app,
  {
    admin,
    db,
    logger,
    PD_SCHEDULE_SECRET = null,
  }
) {
  app.get("/pd-schedule/health", async (req, res) => {
    return res.status(200).json({
      ok: true,
      route: "pd-schedule",
      version: "v3-range",
    });
  });

  app.get("/pd-schedule/me", async (req, res) => {
    try {
      const actor = await requirePdActor({
        req,
        db,
        logger,
        PD_SCHEDULE_SECRET,
      });

      return res.status(200).json({
        ok: true,
        pd: {
          uid: actor.uid,
          repId: actor.repId,
          fullName: actor.fullName,
          email: actor.email,
          currentRoleId: actor.currentRoleId,
          currentRoleName: actor.currentRoleName,
        },
      });
    } catch (err) {
      logger.error("PD_SCHEDULE_ME_ERROR", err);
      return res.status(err.status || 500).json({
        ok: false,
        error: err.message || "Unable to load PD",
      });
    }
  });

  app.get("/pd-schedule/team", async (req, res) => {
    try {
      const actor = await requirePdActor({
        req,
        db,
        logger,
        PD_SCHEDULE_SECRET,
      });

      const team = await getPdTeam({
        db,
        pdRepId: actor.repId,
      });

      return res.status(200).json({
        ok: true,
        pd: {
          uid: actor.uid,
          repId: actor.repId,
          fullName: actor.fullName,
        },
        team,
      });
    } catch (err) {
      logger.error("PD_SCHEDULE_TEAM_ERROR", err);
      return res.status(err.status || 500).json({
        ok: false,
        error: err.message || "Unable to load team",
      });
    }
  });

  app.get("/pd-schedule/locations", async (req, res) => {
    try {
      await requirePdActor({
        req,
        db,
        logger,
        PD_SCHEDULE_SECRET,
      });

      const locations = await getLocations({ db });

      return res.status(200).json({
        ok: true,
        locations,
      });
    } catch (err) {
      logger.error("PD_SCHEDULE_LOCATIONS_ERROR", err);
      return res.status(err.status || 500).json({
        ok: false,
        error: err.message || "Unable to load locations",
      });
    }
  });

  app.post("/pd-schedule/locations/create", async (req, res) => {
    try {
      const actor = await requirePdActor({
        req,
        db,
        logger,
        PD_SCHEDULE_SECRET,
      });

      const rawLocationName = clean(
        req.body?.location ||
          req.body?.locationName ||
          req.body?.name
      );

      const locationName = titleCaseLocation(rawLocationName);
      const locationKey = normalizeLocationKey(locationName);

      if (!locationName || !locationKey) {
        return res.status(400).json({
          ok: false,
          error: "Missing location name",
        });
      }

      if (locationName.length > 80) {
        return res.status(400).json({
          ok: false,
          error: "Location name is too long",
        });
      }

      const existing = await findLocationByKey({
        db,
        locationKey,
      });

      if (existing) {
        return res.status(200).json({
          ok: true,
          created: false,
          location: {
            id: existing.id,
            location: existing.location,
            locationName: existing.location,
            locationKey: existing.locationKey,
          },
        });
      }

      const docRef = db.collection("locations").doc(locationKey);

      await docRef.set(
        {
          location: locationName,
          locationName,
          locationKey,
          active: true,
          source: "pd_web_scheduler",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          createdByUid: actor.uid,
          createdByRepId: actor.repId,
          createdByName: actor.fullName,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      return res.status(200).json({
        ok: true,
        created: true,
        location: {
          id: docRef.id,
          location: locationName,
          locationName,
          locationKey,
        },
      });
    } catch (err) {
      logger.error("PD_SCHEDULE_CREATE_LOCATION_ERROR", err);
      return res.status(err.status || 500).json({
        ok: false,
        error: err.message || "Unable to create location",
      });
    }
  });

  app.get("/pd-schedule/week", async (req, res) => {
    try {
      const actor = await requirePdActor({
        req,
        db,
        logger,
        PD_SCHEDULE_SECRET,
      });

      const weekStartDateKey = normalizeDateKey(req.query.weekStart);
      if (!weekStartDateKey) {
        return res.status(400).json({
          ok: false,
          error: "Missing or invalid weekStart. Use YYYY-MM-DD.",
        });
      }

      const weekEndDateKey = buildWeekEndDateKey(weekStartDateKey);

      const snap = await db
        .collection("scheduledShifts")
        .where("programDirectorRepId", "==", actor.repId)
        .where("shiftDateKey", ">=", weekStartDateKey)
        .where("shiftDateKey", "<=", weekEndDateKey)
        .get();

      const shifts = snap.docs.map(mapShiftDoc);

      return res.status(200).json({
        ok: true,
        weekStartDateKey,
        weekEndDateKey,
        shifts,
      });
    } catch (err) {
      logger.error("PD_SCHEDULE_WEEK_ERROR", err);
      return res.status(err.status || 500).json({
        ok: false,
        error: err.message || "Unable to load week",
      });
    }
  });

  app.get("/pd-schedule/range", async (req, res) => {
    try {
      const actor = await requirePdActor({
        req,
        db,
        logger,
        PD_SCHEDULE_SECRET,
      });

      const startDateKey = normalizeDateKey(req.query.start);
      const weeks = normalizeWeeks(req.query.weeks || 1);

      if (!startDateKey) {
        return res.status(400).json({
          ok: false,
          error: "Missing or invalid start. Use YYYY-MM-DD.",
        });
      }

      const endDateKey = buildRangeEndDateKey(startDateKey, weeks);

      const snap = await db
        .collection("scheduledShifts")
        .where("programDirectorRepId", "==", actor.repId)
        .where("shiftDateKey", ">=", startDateKey)
        .where("shiftDateKey", "<=", endDateKey)
        .get();

      const shifts = snap.docs.map(mapShiftDoc);

      return res.status(200).json({
        ok: true,
        startDateKey,
        endDateKey,
        weeks,
        shifts,
      });
    } catch (err) {
      logger.error("PD_SCHEDULE_RANGE_ERROR", err);
      return res.status(err.status || 500).json({
        ok: false,
        error: err.message || "Unable to load schedule range",
      });
    }
  });

  app.post("/pd-schedule/save", async (req, res) => {
    try {
      const actor = await requirePdActor({
        req,
        db,
        logger,
        PD_SCHEDULE_SECRET,
      });

      const body = req.body || {};
      const weekStartDateKey = normalizeDateKey(body.weekStartDateKey);
      const repeatWeeks = normalizeWeeks(body.repeatWeeks || body.weeks || 1);
      const rangeEndDateKey = weekStartDateKey
        ? buildRangeEndDateKey(weekStartDateKey, repeatWeeks)
        : "";

      const shifts = Array.isArray(body.shifts) ? body.shifts : [];
      const replaceExisting = boolValue(body.replaceExisting);
      const publishNow = body.publishNow !== false;

      if (!weekStartDateKey) {
        return res.status(400).json({
          ok: false,
          error: "Missing or invalid weekStartDateKey.",
        });
      }

      if (!shifts.length) {
        return res.status(400).json({
          ok: false,
          error: "No shifts provided.",
        });
      }

      if (shifts.length > 500) {
        return res.status(400).json({
          ok: false,
          error: "Too many shifts in one request. Max 500.",
        });
      }

      const now = admin.firestore.FieldValue.serverTimestamp();
      const batchId = `pd_${actor.repId}_${weekStartDateKey}_${Date.now()}`;
      const batchRef = db.collection("scheduleBatches").doc(batchId);

      const created = [];
      const updated = [];
      const skipped = [];
      const conflicts = [];
      const errors = [];

      const writeBatch = db.batch();

      writeBatch.set(batchRef, {
        batchId,
        weekStartDateKey,
        rangeStartDateKey: weekStartDateKey,
        rangeEndDateKey,
        repeatWeeks,
        status: publishNow ? "Published" : "Draft",
        programDirectorRepId: actor.repId,
        programDirectorName: actor.fullName,
        createdByUid: actor.uid,
        createdByRepId: actor.repId,
        createdByName: actor.fullName,
        source: "pd_web_scheduler",
        requestedShiftCount: shifts.length,
        createdAt: now,
        updatedAt: now,
      });

      for (const rawShift of shifts) {
        const repId = clean(rawShift.repId);
        const dateKey = normalizeDateKey(
          rawShift.shiftDateKey || rawShift.dateKey
        );
        const startTime = normalizeTime(
          rawShift.scheduledStartTime || rawShift.startTime
        );
        const endTime = normalizeTime(
          rawShift.scheduledEndTime || rawShift.endTime
        );

        const locationName = clean(rawShift.locationName);
        const locationId = clean(rawShift.locationId);
        const locationType = clean(rawShift.locationType || "field");
        const notes = clean(rawShift.notes);

        if (!repId || !dateKey || !startTime || !endTime) {
          errors.push({
            repId,
            dateKey,
            error: "Missing repId, dateKey, startTime, or endTime",
          });
          continue;
        }

       

        if (dateKey < weekStartDateKey || dateKey > rangeEndDateKey) {
          errors.push({
            repId,
            dateKey,
            error: "Shift date is outside selected schedule range",
          });
          continue;
        }

        const hours = durationHours(startTime, endTime);

        if (hours == null || hours <= 0) {
          errors.push({
            repId,
            dateKey,
            error: "End time must be after start time",
          });
          continue;
        }

        if (hours > 9) {
          errors.push({
            repId,
            dateKey,
            error: `Shift is ${hours} hours. Max allowed is 9 hours.`,
          });
          continue;
        }

        const rep = await assertRepBelongsToPd({
          db,
          pdRepId: actor.repId,
          repId,
        });

        if (!rep) {
          errors.push({
            repId,
            dateKey,
            error: "Rep does not belong to this Program Director",
          });
          continue;
        }

        const existing = await findExistingShift({
          db,
          repId,
          dateKey,
        });

        if (existing) {
          const existingStatus = clean(existing.data.status || "Scheduled");

          if (!replaceExisting) {
            conflicts.push({
              repId,
              repName: rep.fullName,
              dateKey,
              existingShiftId: existing.id,
              existingStatus,
              error: "Shift already exists",
            });
            continue;
          }

          if (existingStatus !== "Scheduled" && existingStatus !== "Draft") {
            conflicts.push({
              repId,
              repName: rep.fullName,
              dateKey,
              existingShiftId: existing.id,
              existingStatus,
              error: "Existing shift is protected and cannot be replaced",
            });
            continue;
          }
        }

        const scheduledStartAt = toEdmontonTimestamp(
          admin,
          dateKey,
          startTime
        );
        const scheduledEndAt = toEdmontonTimestamp(admin, dateKey, endTime);

        if (!scheduledStartAt || !scheduledEndAt) {
          errors.push({
            repId,
            dateKey,
            error: "Invalid scheduled time",
          });
          continue;
        }

        const shiftRef = existing
          ? existing.ref
          : db.collection("scheduledShifts").doc();

        const shiftPayload = {
          repId,
          repUserUid: rep.uid,
          repName: rep.fullName,
          repEmail: rep.email,

          programDirectorRepId: actor.repId,
          programDirectorUid: actor.uid,
          programDirectorName: actor.fullName,

          shiftDateKey: dateKey,
          scheduledStartTime: startTime,
          scheduledEndTime: endTime,
          scheduledStartAt,
          scheduledEndAt,
          scheduledDurationHours: hours,
          timezone: "America/Edmonton",

          locationName,
          locationId,
          locationType,
          notes,

          status: publishNow ? "Scheduled" : "Draft",
          source: "pd_web_scheduler_v3",
          scheduleBatchId: batchId,

          createdByUid: actor.uid,
          createdByRepId: actor.repId,
          createdByName: actor.fullName,

          updatedAt: now,
        };

        if (!existing) {
          shiftPayload.createdAt = now;
        }

        writeBatch.set(shiftRef, shiftPayload, { merge: true });

        if (existing) {
          updated.push({
            id: shiftRef.id,
            repId,
            repName: rep.fullName,
            dateKey,
          });
        } else {
          created.push({
            id: shiftRef.id,
            repId,
            repName: rep.fullName,
            dateKey,
          });
        }
      }

      writeBatch.update(batchRef, {
        createdCount: created.length,
        updatedCount: updated.length,
        skippedCount: skipped.length,
        conflictCount: conflicts.length,
        errorCount: errors.length,
        finalShiftCount: created.length + updated.length,
        updatedAt: now,
      });

      if (!created.length && !updated.length) {
        return res.status(409).json({
          ok: false,
          error: "No shifts were saved",
          batchId,
          created,
          updated,
          skipped,
          conflicts,
          errors,
        });
      }

      await writeBatch.commit();

      return res.status(200).json({
        ok: true,
        batchId,
        weekStartDateKey,
        rangeStartDateKey: weekStartDateKey,
        rangeEndDateKey,
        repeatWeeks,
        created,
        updated,
        skipped,
        conflicts,
        errors,
      });
    } catch (err) {
      logger.error("PD_SCHEDULE_SAVE_ERROR", err);
      return res.status(err.status || 500).json({
        ok: false,
        error: err.message || "Unable to save schedule",
      });
    }
  });

  app.post("/pd-schedule/delete", async (req, res) => {
    try {
      const actor = await requirePdActor({
        req,
        db,
        logger,
        PD_SCHEDULE_SECRET,
      });

      const shiftId = clean(req.body?.shiftId);

      if (!shiftId) {
        return res.status(400).json({
          ok: false,
          error: "Missing shiftId",
        });
      }

      const shiftRef = db.collection("scheduledShifts").doc(shiftId);
      const shiftSnap = await shiftRef.get();

      if (!shiftSnap.exists) {
        return res.status(404).json({
          ok: false,
          error: "Shift not found",
        });
      }

      const shift = shiftSnap.data() || {};

      if (clean(shift.programDirectorRepId) !== actor.repId) {
        return res.status(403).json({
          ok: false,
          error: "This shift does not belong to this Program Director",
        });
      }

      const status = clean(shift.status || "Scheduled");

      if (status !== "Scheduled" && status !== "Draft") {
        return res.status(409).json({
          ok: false,
          error: `Cannot delete a shift with status ${status}`,
        });
      }

      await shiftRef.set(
        {
          status: "Cancelled",
          cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
          cancelledByUid: actor.uid,
          cancelledByRepId: actor.repId,
          cancelledByName: actor.fullName,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      return res.status(200).json({
        ok: true,
        shiftId,
        status: "Cancelled",
      });
    } catch (err) {
      logger.error("PD_SCHEDULE_DELETE_ERROR", err);
      return res.status(err.status || 500).json({
        ok: false,
        error: err.message || "Unable to delete shift",
      });
    }
  });
};