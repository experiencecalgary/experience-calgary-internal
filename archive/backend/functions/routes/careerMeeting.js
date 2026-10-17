/* functions/routes/careerMeeting.js */

const {
  CURATOR_EMAIL,
  sendCareerMeetingEmail,
} = require("../lib/careerMeetingMailer");
const { createTeamPortalAuth } = require("../lib/teamPortalAuth");

const SECTION_ORDER = [
  "foundation",
  "vision",
  "elevation",
  "lifestyle",
  "momentum",
  "moments",
];

function clean(value) {
  return value == null ? "" : String(value).trim();
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function getWpUserId(req) {
  return clean(req.portalUser?.repId);
}

function getFirebaseUid(rep) {
  return clean(rep.firebaseUid || rep.uid || rep.userId);
}

function buildRepPublic(docId, rep) {
  return {
    wpUserId: docId,
    firebaseUid: getFirebaseUid(rep),
    fullName: clean(rep.fullName || rep.name),
    email: clean(rep.email),
    role: clean(rep.role || rep.roleId),
    status: clean(rep.status),
    active: rep.active === true || clean(rep.status).toLowerCase() === "active",
  };
}

function calculateFoundation(raw) {
  const foundation = raw && typeof raw === "object" ? raw : {};
  const expenses = foundation.expenses || {};
  const monthlyNeed = [
    "housing",
    "transportation",
    "food",
    "debtPayments",
    "phoneUtilities",
    "lifestyleFun",
    "savingsGoal",
    "other",
  ].reduce((total, key) => total + asNumber(expenses[key]), 0);

  const growthIncomeGoal = asNumber(foundation.growthIncomeGoal);
  const workDaysPerMonth = 22;
  const payPeriodsPerMonth = 2;
  const personalXPerDollar = 5;
  const teamXPerLeadershipDollar = 30;
  const personalIncomeShare = 0.60;
  const teamIncomeShare = 0.40;
  const expectedMemberDailyX = 1750;

  const securityMonthlyX = Math.ceil(monthlyNeed * personalXPerDollar);
  const personalIncomeTarget = growthIncomeGoal * personalIncomeShare;
  const teamIncomeTarget = growthIncomeGoal * teamIncomeShare;
  const personalMonthlyX = Math.ceil(personalIncomeTarget * personalXPerDollar);
  const teamMonthlyX = Math.ceil(teamIncomeTarget * teamXPerLeadershipDollar);
  const personalDailyX = growthIncomeGoal
    ? Math.ceil(personalMonthlyX / workDaysPerMonth)
    : 0;
  const teamDailyX = growthIncomeGoal
    ? Math.ceil(teamMonthlyX / workDaysPerMonth)
    : 0;
  const producingTeamMembersRequired = teamDailyX
    ? Math.max(1, Math.ceil(teamDailyX / expectedMemberDailyX))
    : 0;

  return {
    ...foundation,
    expenses,
    monthlyNeed,
    growthIncomeGoal,
    workDaysPerMonth,
    payPeriodsPerMonth,
    personalXPerDollar,
    teamXPerLeadershipDollar,
    personalIncomeShare,
    teamIncomeShare,
    expectedMemberDailyX,
    securityMonthlyX,
    securityPayPeriodX: Math.ceil(securityMonthlyX / payPeriodsPerMonth),
    securityDailyX: Math.ceil(securityMonthlyX / workDaysPerMonth),
    personalIncomeTarget,
    personalMonthlyX,
    personalPayPeriodX: Math.ceil(personalMonthlyX / payPeriodsPerMonth),
    personalDailyX,
    teamIncomeTarget,
    teamMonthlyX,
    teamPayPeriodX: Math.ceil(teamMonthlyX / payPeriodsPerMonth),
    teamDailyX,
    producingTeamMembersRequired,
    teamMemberDailyRange: { minimum: 1500, target: 1750, maximum: 2000 },
  };
}

module.exports = function registerCareerMeetingRoutes(app, {
  admin,
  db,
  logger,
  STAFF_MAIL_USER,
  STAFF_MAIL_APP_PASSWORD,
}) {
  const FieldValue = admin.firestore.FieldValue;
  const portalAuth = createTeamPortalAuth({ admin, db, logger });
  const protect = [portalAuth.authenticate, portalAuth.requirePermission("careerMeeting")];

  function sendError(res, error, key) {
    logger.error(key, { message: error.message });
    return res.status(error.statusCode || 500).json({
      ok: false,
      error: error.statusCode ? error.message : "Career Meeting request failed",
    });
  }

  async function resolveMeeting(meetingId, req) {
    const indexRef = db.collection("careerMeetingIndex").doc(meetingId);
    const indexSnap = await indexRef.get();
    if (!indexSnap.exists) {
      const error = new Error("Career Meeting was not found");
      error.statusCode = 404;
      throw error;
    }
    const index = indexSnap.data() || {};
    if (!req.portalUser.platformAdmin && clean(index.leaderWpUserId) !== clean(req.portalUser.repId)) {
      const error = new Error("You are not authorized to access this Career Meeting");
      error.statusCode = 403;
      throw error;
    }
    const repFirebaseUid = clean(index.repFirebaseUid);
    if (!repFirebaseUid) {
      const error = new Error("Career Meeting index is missing the rep Firebase UID");
      error.statusCode = 400;
      throw error;
    }
    const meetingRef = db.collection("users").doc(repFirebaseUid)
      .collection("careerMeetings").doc(meetingId);
    return { indexRef, index, repFirebaseUid, meetingRef };
  }

  app.get("/career-meeting/health", async (req, res) => res.status(200).json({
    ok: true,
    system: "careerMeeting",
    timestamp: new Date().toISOString(),
  }));

  app.get("/career-meeting/me", ...protect, async (req, res) => {
    try {
      const wpUserId = getWpUserId(req);
      if (!wpUserId && req.portalUser.platformAdmin) {
        return res.status(200).json({ ok: true, rep: {
          wpUserId: "", firebaseUid: req.portalUser.uid,
          fullName: req.portalUser.fullName || "Platform Administrator",
          email: req.portalUser.email, role: "platform_admin", active: true,
        }});
      }
      if (!wpUserId) return res.status(400).json({ ok: false, error: "Missing authenticated Rep ID" });
      const snap = await db.collection("reps").doc(wpUserId).get();
      if (!snap.exists) return res.status(404).json({ ok: false, error: "No matching rep was found" });
      return res.status(200).json({ ok: true, rep: buildRepPublic(snap.id, snap.data() || {}) });
    } catch (error) {
      return sendError(res, error, "CAREER_MEETING_ME_ERROR");
    }
  });

  app.get("/career-meeting/reps", ...protect, async (req, res) => {
    try {
      const wpUserId = getWpUserId(req);
      const isAdmin = req.portalUser.platformAdmin === true;
      if (!wpUserId && !isAdmin) return res.status(400).json({ ok: false, error: "Missing authenticated Rep ID" });

      const snap = await db.collection("reps").get();
      const meetingQuery = isAdmin
        ? db.collection("careerMeetingIndex")
        : db.collection("careerMeetingIndex").where("leaderWpUserId", "==", wpUserId);
      const activeMeetingSnap = await meetingQuery.get();
      const activeByRep = new Map();
      activeMeetingSnap.forEach(doc => {
        const meeting = doc.data() || {};
        if (!isAdmin && clean(meeting.leaderWpUserId) !== wpUserId) return;
        const repId = clean(meeting.repWpUserId);
        if (!repId) return;
        const existing = activeByRep.get(repId);
        const updated = meeting.updatedAt?.toMillis?.() || meeting.createdAt?.toMillis?.() || 0;
        if (!existing || updated > existing.updated) {
          activeByRep.set(repId, {
            meetingId: doc.id,
            currentStep: clean(meeting.currentStep) || SECTION_ORDER[0],
            completedSections: Array.isArray(meeting.completedSections) ? meeting.completedSections : [],
            updated,
          });
        }
      });
      const reps = [];
      snap.forEach(doc => {
        const data = doc.data() || {};
        if (clean(data.status).toLowerCase() !== "active" && data.active !== true) return;
        if (!isAdmin && clean(data.programDirectorRepId) !== wpUserId) return;
        const rep = buildRepPublic(doc.id, data);
        const activeMeeting = activeByRep.get(doc.id);
        reps.push({
          ...rep,
          activeMeeting: activeMeeting ? {
            meetingId: activeMeeting.meetingId,
            currentStep: activeMeeting.currentStep,
            completedSections: activeMeeting.completedSections,
          } : null,
        });
      });
      reps.sort((a, b) => a.fullName.localeCompare(b.fullName));
      return res.status(200).json({ ok: true, count: reps.length, reps });
    } catch (error) {
      return sendError(res, error, "CAREER_MEETING_REPS_ERROR");
    }
  });

  app.post("/career-meeting/create", ...protect, async (req, res) => {
    try {
      const leaderWpUserId = getWpUserId(req);
      const repWpUserId = clean(req.body?.repWpUserId);
      const isAdmin = req.portalUser.platformAdmin === true;
      if (!repWpUserId || (!leaderWpUserId && !isAdmin)) {
        return res.status(400).json({ ok: false, error: "An authorized leader and selected rep are required" });
      }
      const [leaderSnap, repSnap] = await Promise.all([
        leaderWpUserId ? db.collection("reps").doc(leaderWpUserId).get() : Promise.resolve(null),
        db.collection("reps").doc(repWpUserId).get(),
      ]);
      if (!isAdmin && !leaderSnap?.exists) return res.status(404).json({ ok: false, error: "Leader rep was not found" });
      if (!repSnap.exists) return res.status(404).json({ ok: false, error: "Selected rep was not found" });
      const leader = leaderSnap?.exists ? (leaderSnap.data() || {}) : req.portalUser;
      const rep = repSnap.data() || {};
      if (!isAdmin && clean(rep.programDirectorRepId) !== leaderWpUserId) {
        return res.status(403).json({ ok: false, error: "This rep is not assigned to your team" });
      }
      const repFirebaseUid = getFirebaseUid(rep);
      if (!repFirebaseUid) return res.status(400).json({ ok: false, error: "Selected rep is missing a Firebase UID" });

      const existingSnap = await db.collection("careerMeetingIndex")
        .where("repWpUserId", "==", repWpUserId)
        .get();
      let existing = null;
      existingSnap.forEach(doc => {
        const data = doc.data() || {};
        if (!isAdmin && clean(data.leaderWpUserId) !== leaderWpUserId) return;
        const updated = data.updatedAt?.toMillis?.() || data.createdAt?.toMillis?.() || 0;
        if (!existing || updated > existing.updated) existing = { id: doc.id, data, updated };
      });
      if (existing) {
        const existingRef = db.collection("users").doc(repFirebaseUid)
          .collection("careerMeetings").doc(existing.id);
        const existingMeeting = await existingRef.get();
        if (existingMeeting.exists) {
          return res.status(200).json({
            ok: true,
            resumed: true,
            meetingId: existing.id,
            repFirebaseUid,
            meeting: existingMeeting.data() || {},
            path: `users/${repFirebaseUid}/careerMeetings/${existing.id}`,
          });
        }
      }

      const meetingRef = db.collection("users").doc(repFirebaseUid)
        .collection("careerMeetings").doc();
      const meetingId = meetingRef.id;
      const base = {
        meetingId,
        repWpUserId,
        repFirebaseUid,
        repName: clean(rep.fullName || rep.name),
        repEmail: clean(rep.email),
        leaderWpUserId: leaderWpUserId || `platform_admin:${req.portalUser.uid}`,
        leaderFirebaseUid: req.portalUser.uid,
        leaderName: clean(leader.fullName || leader.name),
        leaderEmail: clean(leader.email),
        status: "in_progress",
        currentStep: SECTION_ORDER[0],
        completedSections: [],
        sections: SECTION_ORDER.reduce((result, key) => { result[key] = {}; return result; }, {}),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        completedAt: null,
      };
      const index = {
        meetingId,
        repWpUserId,
        repFirebaseUid,
        repName: base.repName,
        repEmail: base.repEmail,
        leaderWpUserId: base.leaderWpUserId,
        leaderFirebaseUid: base.leaderFirebaseUid,
        leaderName: base.leaderName,
        leaderEmail: base.leaderEmail,
        status: "in_progress",
        currentStep: SECTION_ORDER[0],
        completedSections: [],
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        completedAt: null,
      };
      await db.runTransaction(async tx => {
        tx.set(meetingRef, base);
        tx.set(db.collection("careerMeetingIndex").doc(meetingId), index);
      });
      return res.status(201).json({
        ok: true,
        resumed: false,
        meetingId,
        repFirebaseUid,
        path: `users/${repFirebaseUid}/careerMeetings/${meetingId}`,
      });
    } catch (error) {
      return sendError(res, error, "CAREER_MEETING_CREATE_ERROR");
    }
  });

  app.get("/career-meeting/:meetingId", ...protect, async (req, res) => {
    try {
      const resolved = await resolveMeeting(clean(req.params.meetingId), req);
      const snap = await resolved.meetingRef.get();
      if (!snap.exists) return res.status(404).json({ ok: false, error: "Career Meeting document was not found" });
      return res.status(200).json({ ok: true, meeting: snap.data() || {} });
    } catch (error) {
      return sendError(res, error, "CAREER_MEETING_GET_ERROR");
    }
  });

  app.post("/career-meeting/:meetingId/section", ...protect, async (req, res) => {
    try {
      const meetingId = clean(req.params.meetingId);
      const sectionName = clean(req.body?.sectionName);
      if (!SECTION_ORDER.includes(sectionName)) {
        return res.status(400).json({ ok: false, error: "Invalid Career Meeting section" });
      }
      const resolved = await resolveMeeting(meetingId, req);
      const data = sectionName === "foundation"
        ? calculateFoundation(req.body?.data || {})
        : (req.body?.data || {});
      const completedSections = Array.isArray(resolved.index.completedSections)
        ? [...resolved.index.completedSections]
        : [];
      if (!completedSections.includes(sectionName)) completedSections.push(sectionName);
      await db.runTransaction(async tx => {
        tx.update(resolved.meetingRef, {
          [`sections.${sectionName}`]: data,
          completedSections,
          currentStep: sectionName,
          updatedAt: FieldValue.serverTimestamp(),
        });
        tx.update(resolved.indexRef, {
          completedSections,
          currentStep: sectionName,
          updatedAt: FieldValue.serverTimestamp(),
        });
      });
      return res.status(200).json({ ok: true, meetingId, sectionName, currentStep: sectionName, completedSections, data });
    } catch (error) {
      return sendError(res, error, "CAREER_MEETING_SECTION_ERROR");
    }
  });

  app.post("/career-meeting/:meetingId/progress", ...protect, async (req, res) => {
    try {
      const meetingId = clean(req.params.meetingId);
      const currentStep = clean(req.body?.currentStep);
      if (!SECTION_ORDER.includes(currentStep)) {
        return res.status(400).json({ ok: false, error: "Invalid Career Meeting step" });
      }
      const resolved = await resolveMeeting(meetingId, req);
      await db.runTransaction(async tx => {
        tx.update(resolved.meetingRef, { currentStep, updatedAt: FieldValue.serverTimestamp() });
        tx.update(resolved.indexRef, { currentStep, updatedAt: FieldValue.serverTimestamp() });
      });
      return res.status(200).json({ ok: true, meetingId, currentStep });
    } catch (error) {
      return sendError(res, error, "CAREER_MEETING_PROGRESS_ERROR");
    }
  });

  app.post("/career-meeting/:meetingId/complete", ...protect, async (req, res) => {
    try {
      const meetingId = clean(req.params.meetingId);
      const resolved = await resolveMeeting(meetingId, req);
      const snap = await resolved.meetingRef.get();
      if (!snap.exists) return res.status(404).json({ ok: false, error: "Career Meeting document was not found" });
      const meeting = snap.data() || {};
      const completed = Array.isArray(meeting.completedSections) ? meeting.completedSections : [];
      const missing = SECTION_ORDER.filter(key => !completed.includes(key));
      if (missing.length) return res.status(409).json({ ok: false, error: `Complete every section first: ${missing.join(", ")}` });

      await db.runTransaction(async tx => {
        tx.update(resolved.meetingRef, {
          status: "completed",
          currentStep: "complete",
          completedSections: SECTION_ORDER,
          "notification.status": "sending",
          "notification.attemptedAt": FieldValue.serverTimestamp(),
          completedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        tx.update(resolved.indexRef, {
          status: "completed",
          currentStep: "complete",
          completedSections: SECTION_ORDER,
          completedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      });

      const userSnap = await db.collection("users").doc(resolved.repFirebaseUid).get();
      const repEmail = clean(userSnap.data()?.email);
      const emailMeeting = { ...meeting, status: "completed", completedAt: new Date() };
      const oldDelivery = meeting.notification?.deliveries || {};
      const delivery = {
        curator: { email: CURATOR_EMAIL, status: clean(oldDelivery.curator?.status) || "pending" },
        rep: { email: repEmail, status: clean(oldDelivery.rep?.status) || "pending" },
      };

      async function deliver(key, email, recipientType) {
        if (delivery[key].status === "sent") return;
        if (!email) {
          delivery[key] = { email: "", status: "failed", error: "The users document does not contain an email address." };
          return;
        }
        try {
          const result = await sendCareerMeetingEmail({
            to: email,
            recipientType,
            meeting: emailMeeting,
            STAFF_MAIL_USER,
            STAFF_MAIL_APP_PASSWORD,
          });
          delivery[key] = { email, status: "sent", messageId: clean(result?.messageId) };
        } catch (emailError) {
          logger.error("CAREER_MEETING_EMAIL_ERROR", { meetingId, recipientType, message: emailError.message });
          delivery[key] = { email, status: "failed", error: clean(emailError.message).slice(0, 300) };
        }
      }

      await deliver("curator", CURATOR_EMAIL, "curator");
      if (repEmail && repEmail.toLowerCase() === CURATOR_EMAIL.toLowerCase()) {
        delivery.rep = { ...delivery.curator, email: repEmail, sharedDelivery: true };
      } else {
        await deliver("rep", repEmail, "rep");
      }
      const sentCount = Object.values(delivery).filter(item => item.status === "sent").length;
      const notificationStatus = sentCount === 2 ? "sent" : sentCount === 1 ? "partial" : "failed";
      await resolved.meetingRef.update({
        notification: {
          status: notificationStatus,
          deliveries: delivery,
          attemptedAt: FieldValue.serverTimestamp(),
          sentAt: notificationStatus === "sent" ? FieldValue.serverTimestamp() : null,
        },
        updatedAt: FieldValue.serverTimestamp(),
      });
      await resolved.indexRef.update({ notificationStatus, updatedAt: FieldValue.serverTimestamp() });
      return res.status(200).json({ ok: true, meetingId, status: "completed", notificationStatus });
    } catch (error) {
      return sendError(res, error, "CAREER_MEETING_COMPLETE_ERROR");
    }
  });
};
