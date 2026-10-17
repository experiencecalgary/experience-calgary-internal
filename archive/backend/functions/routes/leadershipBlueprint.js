/* functions/routes/leadershipBlueprint.js */

const {
  CURATOR_EMAIL,
  sendLeadershipBlueprintEmail,
} = require("../lib/leadershipBlueprintMailer");
const { createTeamPortalAuth } = require("../lib/teamPortalAuth");

const SECTION_ORDER = [
  "leadershipStandard",
  "weeklyRhythm",
  "channelPlan",
  "fieldOperations",
  "developmentCamp",
  "teamMeetings",
  "customerQuality",
  "teamStandards",
  "teamGrowth",
];

function clean(value) {
  return value == null ? "" : String(value).trim();
}

function getWpUserId(req) {
  return clean(req.portalUser?.repId);
}

function getFirebaseUid(rep) {
  return clean(rep.firebaseUid || rep.uid || rep.userId);
}

function isActiveRep(rep) {
  const status = clean(rep.status).toLowerCase();
  if (status === "inactive") return false;
  return status === "active" || rep.active === true;
}

function publicRep(docId, rep) {
  return {
    wpUserId: docId,
    firebaseUid: getFirebaseUid(rep),
    fullName: clean(rep.fullName || rep.name),
    email: clean(rep.email),
    role: clean(rep.role || rep.roleId),
    status: clean(rep.status),
    active: isActiveRep(rep),
    programDirectorRepId: clean(rep.programDirectorRepId),
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validSectionData(value) {
  if (!isPlainObject(value)) return false;
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") <= 300000;
  } catch (error) {
    return false;
  }
}

module.exports = function registerLeadershipBlueprintRoutes(app, {
  admin,
  db,
  logger,
  STAFF_MAIL_USER,
  STAFF_MAIL_APP_PASSWORD,
}) {
  const FieldValue = admin.firestore.FieldValue;
  const portalAuth = createTeamPortalAuth({ admin, db, logger });
  const protect = [portalAuth.authenticate, portalAuth.requirePermission("leadershipBlueprint")];

  async function loadActiveRep(wpUserId) {
    if (!wpUserId) {
      const error = new Error("Missing Sales Rep ID");
      error.statusCode = 400;
      throw error;
    }

    const repSnap = await db.collection("reps").doc(wpUserId).get();
    if (!repSnap.exists) {
      const error = new Error("No matching rep was found");
      error.statusCode = 404;
      throw error;
    }

    const rep = repSnap.data() || {};
    if (!isActiveRep(rep)) {
      const error = new Error("This Sales Rep ID is not active");
      error.statusCode = 403;
      throw error;
    }

    const firebaseUid = getFirebaseUid(rep);
    if (!firebaseUid) {
      const error = new Error("This rep is missing a Firebase UID");
      error.statusCode = 400;
      throw error;
    }

    return { repSnap, rep, firebaseUid };
  }

  async function resolveOwnedBlueprint(blueprintId, wpUserId) {
    const activeRep = await loadActiveRep(wpUserId);
    const indexRef = db.collection("leadershipBlueprintIndex").doc(blueprintId);
    const indexSnap = await indexRef.get();

    if (!indexSnap.exists) {
      const error = new Error("Leadership Blueprint was not found");
      error.statusCode = 404;
      throw error;
    }

    const index = indexSnap.data() || {};
    if (
      clean(index.ownerWpUserId) !== wpUserId ||
      clean(index.ownerFirebaseUid) !== activeRep.firebaseUid
    ) {
      const error = new Error("This Blueprint does not belong to this rep");
      error.statusCode = 403;
      throw error;
    }

    const blueprintRef = db
      .collection("users")
      .doc(activeRep.firebaseUid)
      .collection("leadershipBlueprints")
      .doc(blueprintId);

    return { ...activeRep, indexRef, indexSnap, index, blueprintRef };
  }

  function sendError(res, err, logKey) {
    logger.error(logKey, { message: err.message });
    return res.status(err.statusCode || 500).json({
      ok: false,
      error: err.statusCode ? err.message : "Leadership Blueprint request failed",
    });
  }

  app.get("/leadership-blueprint/health", async (req, res) => {
    return res.status(200).json({
      ok: true,
      system: "leadershipBlueprint",
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/leadership-blueprint/me", ...protect, async (req, res) => {
    try {
      const wpUserId = getWpUserId(req);
      const { repSnap, rep } = await loadActiveRep(wpUserId);
      return res.status(200).json({
        ok: true,
        rep: publicRep(repSnap.id, rep),
      });
    } catch (err) {
      return sendError(res, err, "LEADERSHIP_BLUEPRINT_ME_ERROR");
    }
  });

  app.get("/leadership-blueprint/current", ...protect, async (req, res) => {
    try {
      const wpUserId = getWpUserId(req);
      const activeRep = await loadActiveRep(wpUserId);
      const ownerRef = db.collection("leadershipBlueprintOwners").doc(wpUserId);
      const ownerSnap = await ownerRef.get();

      if (!ownerSnap.exists || !clean(ownerSnap.data()?.currentBlueprintId)) {
        return res.status(200).json({ ok: true, blueprint: null });
      }

      const blueprintId = clean(ownerSnap.data().currentBlueprintId);
      const blueprintRef = db
        .collection("users")
        .doc(activeRep.firebaseUid)
        .collection("leadershipBlueprints")
        .doc(blueprintId);
      const blueprintSnap = await blueprintRef.get();

      if (!blueprintSnap.exists) {
        return res.status(200).json({ ok: true, blueprint: null });
      }

      return res.status(200).json({
        ok: true,
        blueprint: blueprintSnap.data() || {},
      });
    } catch (err) {
      return sendError(res, err, "LEADERSHIP_BLUEPRINT_CURRENT_ERROR");
    }
  });

  app.post("/leadership-blueprint/create", ...protect, async (req, res) => {
    try {
      const wpUserId = getWpUserId(req);
      const { repSnap, rep, firebaseUid } = await loadActiveRep(wpUserId);
      const ownerRef = db.collection("leadershipBlueprintOwners").doc(wpUserId);
      const ownerSnap = await ownerRef.get();

      if (ownerSnap.exists && clean(ownerSnap.data()?.currentBlueprintId)) {
        const existingId = clean(ownerSnap.data().currentBlueprintId);
        const existingRef = db
          .collection("users")
          .doc(firebaseUid)
          .collection("leadershipBlueprints")
          .doc(existingId);
        const existingSnap = await existingRef.get();

        if (existingSnap.exists) {
          return res.status(200).json({
            ok: true,
            resumed: true,
            blueprint: existingSnap.data() || {},
          });
        }
      }

      const blueprintRef = db
        .collection("users")
        .doc(firebaseUid)
        .collection("leadershipBlueprints")
        .doc();
      const blueprintId = blueprintRef.id;
      const owner = publicRep(repSnap.id, rep);
      const emptySections = SECTION_ORDER.reduce((result, key) => {
        result[key] = {};
        return result;
      }, {});

      const blueprint = {
        blueprintId,
        version: 1,
        ownerWpUserId: wpUserId,
        ownerFirebaseUid: firebaseUid,
        ownerName: owner.fullName,
        ownerEmail: owner.email,
        ownerRoleAtCreation: owner.role,
        programDirectorRepId: owner.programDirectorRepId,
        status: "in_progress",
        currentSection: SECTION_ORDER[0],
        completedSections: [],
        sections: emptySections,
        implementation: {
          firstImplementationDate: "",
          firstOrientationDate: "",
          firstDirectorReviewDate: "",
          firstPriority: "",
        },
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        completedAt: null,
      };

      const indexDoc = {
        blueprintId,
        version: 1,
        ownerWpUserId: wpUserId,
        ownerFirebaseUid: firebaseUid,
        ownerName: owner.fullName,
        ownerEmail: owner.email,
        status: "in_progress",
        currentSection: SECTION_ORDER[0],
        completedSections: [],
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        completedAt: null,
      };

      await db.runTransaction(async (tx) => {
        tx.set(blueprintRef, blueprint);
        tx.set(db.collection("leadershipBlueprintIndex").doc(blueprintId), indexDoc);
        tx.set(ownerRef, {
          ownerWpUserId: wpUserId,
          ownerFirebaseUid: firebaseUid,
          currentBlueprintId: blueprintId,
          currentVersion: 1,
          updatedAt: FieldValue.serverTimestamp(),
        });
      });

      return res.status(201).json({
        ok: true,
        resumed: false,
        blueprint,
        path: `users/${firebaseUid}/leadershipBlueprints/${blueprintId}`,
      });
    } catch (err) {
      return sendError(res, err, "LEADERSHIP_BLUEPRINT_CREATE_ERROR");
    }
  });

  app.get("/leadership-blueprint/:blueprintId", ...protect, async (req, res) => {
    try {
      const blueprintId = clean(req.params.blueprintId);
      const wpUserId = getWpUserId(req);
      const resolved = await resolveOwnedBlueprint(blueprintId, wpUserId);
      const blueprintSnap = await resolved.blueprintRef.get();

      if (!blueprintSnap.exists) {
        const error = new Error("Leadership Blueprint document was not found");
        error.statusCode = 404;
        throw error;
      }

      return res.status(200).json({
        ok: true,
        blueprint: blueprintSnap.data() || {},
      });
    } catch (err) {
      return sendError(res, err, "LEADERSHIP_BLUEPRINT_GET_ERROR");
    }
  });

  app.post("/leadership-blueprint/:blueprintId/section", ...protect, async (req, res) => {
    try {
      const blueprintId = clean(req.params.blueprintId);
      const wpUserId = getWpUserId(req);
      const sectionName = clean(req.body?.sectionName);
      const sectionData = req.body?.data;

      if (!SECTION_ORDER.includes(sectionName)) {
        const error = new Error("Invalid Leadership Blueprint section");
        error.statusCode = 400;
        throw error;
      }
      if (!validSectionData(sectionData)) {
        const error = new Error("Section data is invalid or too large");
        error.statusCode = 400;
        throw error;
      }

      const resolved = await resolveOwnedBlueprint(blueprintId, wpUserId);
      const blueprintSnap = await resolved.blueprintRef.get();
      if (!blueprintSnap.exists) {
        const error = new Error("Leadership Blueprint document was not found");
        error.statusCode = 404;
        throw error;
      }
      if (clean(blueprintSnap.data()?.status) === "completed") {
        const error = new Error("Completed Blueprints are read-only");
        error.statusCode = 409;
        throw error;
      }

      const completedSections = Array.isArray(resolved.index.completedSections)
        ? [...resolved.index.completedSections]
        : [];
      if (!completedSections.includes(sectionName)) completedSections.push(sectionName);

      const currentIndex = SECTION_ORDER.indexOf(sectionName);
      const nextSection = SECTION_ORDER[Math.min(currentIndex + 1, SECTION_ORDER.length - 1)];

      await db.runTransaction(async (tx) => {
        tx.update(resolved.blueprintRef, {
          [`sections.${sectionName}`]: sectionData,
          completedSections,
          currentSection: nextSection,
          updatedAt: FieldValue.serverTimestamp(),
        });
        tx.update(resolved.indexRef, {
          completedSections,
          currentSection: nextSection,
          updatedAt: FieldValue.serverTimestamp(),
        });
      });

      return res.status(200).json({
        ok: true,
        blueprintId,
        sectionName,
        currentSection: nextSection,
        completedSections,
        data: sectionData,
      });
    } catch (err) {
      return sendError(res, err, "LEADERSHIP_BLUEPRINT_SECTION_ERROR");
    }
  });

  app.post("/leadership-blueprint/:blueprintId/complete", ...protect, async (req, res) => {
    try {
      const blueprintId = clean(req.params.blueprintId);
      const wpUserId = getWpUserId(req);
      const implementation = isPlainObject(req.body?.implementation)
        ? req.body.implementation
        : {};
      const resolved = await resolveOwnedBlueprint(blueprintId, wpUserId);
      const blueprintSnap = await resolved.blueprintRef.get();

      if (!blueprintSnap.exists) {
        const error = new Error("Leadership Blueprint document was not found");
        error.statusCode = 404;
        throw error;
      }

      const blueprint = blueprintSnap.data() || {};
      const completed = Array.isArray(blueprint.completedSections)
        ? blueprint.completedSections
        : [];
      const missing = SECTION_ORDER.filter((key) => !completed.includes(key));
      if (missing.length) {
        const error = new Error(`Complete every section first: ${missing.join(", ")}`);
        error.statusCode = 409;
        throw error;
      }

      const userSnap = await db
        .collection("users")
        .doc(resolved.firebaseUid)
        .get();
      const repEmail = clean(userSnap.data()?.email);

      await db.runTransaction(async (tx) => {
        tx.update(resolved.blueprintRef, {
          status: "completed",
          currentSection: "complete",
          completedSections: SECTION_ORDER,
          implementation,
          "notification.status": "sending",
          "notification.attemptedAt": FieldValue.serverTimestamp(),
          completedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        tx.update(resolved.indexRef, {
          status: "completed",
          currentSection: "complete",
          completedSections: SECTION_ORDER,
          completedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      });

      const emailBlueprint = {
        ...blueprint,
        status: "completed",
        currentSection: "complete",
        completedSections: SECTION_ORDER,
        implementation,
        completedAt: new Date(),
      };
      const existingDeliveries = blueprint.notification?.deliveries || {};
      const delivery = {
        curator: {
          email: CURATOR_EMAIL,
          status: clean(existingDeliveries.curator?.status) || "pending",
        },
        rep: {
          email: repEmail,
          status: clean(existingDeliveries.rep?.status) || "pending",
        },
      };

      async function sendRecipient(key, email, recipientType) {
        if (delivery[key].status === "sent") return;
        if (!email) {
          delivery[key] = {
            email: "",
            status: "failed",
            error: "The users document does not contain an email address.",
          };
          return;
        }

        try {
          const result = await sendLeadershipBlueprintEmail({
            to: email,
            recipientType,
            blueprint: emailBlueprint,
            STAFF_MAIL_USER,
            STAFF_MAIL_APP_PASSWORD,
          });
          delivery[key] = {
            email,
            status: "sent",
            messageId: clean(result?.messageId),
          };
        } catch (emailError) {
          logger.error("LEADERSHIP_BLUEPRINT_EMAIL_RECIPIENT_ERROR", {
            blueprintId,
            recipientType,
            message: emailError.message,
          });
          delivery[key] = {
            email,
            status: "failed",
            error: clean(emailError.message).slice(0, 300),
          };
        }
      }

      await sendRecipient("curator", CURATOR_EMAIL, "curator");
      if (repEmail.toLowerCase() === CURATOR_EMAIL.toLowerCase()) {
        delivery.rep = {
          email: repEmail,
          status: delivery.curator.status,
          messageId: delivery.curator.messageId || "",
          sharedDelivery: true,
        };
      } else {
        await sendRecipient("rep", repEmail, "rep");
      }

      const sentCount = Object.values(delivery)
        .filter(item => item.status === "sent").length;
      const notificationStatus = sentCount === 2
        ? "sent"
        : sentCount === 1
          ? "partial"
          : "failed";

      await resolved.blueprintRef.update({
        notification: {
          status: notificationStatus,
          deliveries: delivery,
          attemptedAt: FieldValue.serverTimestamp(),
          sentAt: notificationStatus === "sent"
            ? FieldValue.serverTimestamp()
            : null,
        },
        updatedAt: FieldValue.serverTimestamp(),
      });

      await resolved.indexRef.update({
        notificationStatus,
        updatedAt: FieldValue.serverTimestamp(),
      });

      return res.status(200).json({
        ok: true,
        blueprintId,
        status: "completed",
        notificationStatus,
      });
    } catch (err) {
      return sendError(res, err, "LEADERSHIP_BLUEPRINT_COMPLETE_ERROR");
    }
  });
};
