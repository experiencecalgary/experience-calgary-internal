/* functions/routes/reps.js */

const crypto = require("node:crypto");
const { google } = require("googleapis");
const { validateRepHierarchy } = require("../lib/repHierarchy");
const { writeAdminAudit } = require("../lib/adminAudit");
const { sendRepPasswordResetEmail } = require("../lib/mailer");
const { ensureTeamRepMembership } = require("../lib/teamRepMembership");

const SPREADSHEET_ID = "1vfV5hCEMYDsOvrHeGbgrGQ3NXsg1orq3If8Tl0jkeyM";
const SHEET_NAME = "Reps";
const DEFAULT_ROLE_ID = "ROLE1";

function clean(v) {
  return v == null ? "" : String(v).trim();
}

function sheetBool(value) {
  return value ? "TRUE" : "FALSE";
}

function normalizeEmail(value) {
  return clean(value).toLowerCase();
}

function normalizePhone(value) {
  return clean(value).replace(/\D+/g, "");
}

function toFirestoreTimestamp(admin, value) {
  const raw = clean(value);
  if (!raw) return null;

  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;

  return admin.firestore.Timestamp.fromDate(d);
}

function buildMonthKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function getCurrentMonthWindow(now = new Date()) {
  const start = new Date(
    now.getFullYear(),
    now.getMonth(),
    1,
    0,
    0,
    0,
    0
  );

  const end = new Date(
    now.getFullYear(),
    now.getMonth() + 1,
    0,
    23,
    59,
    59,
    999
  );

  return {
    monthKey: buildMonthKey(start),
    start,
    end,
  };
}

function buildDevelopmentCampEnrollment(admin, hireDateTs) {
  const start = hireDateTs.toDate();
  const through = new Date(start.getTime() + 42 * 24 * 60 * 60 * 1000 - 1);

  return {
    developmentCampStatus: "active",
    developmentCampBonusStatus: "onBonus",
    developmentCampBonusReason: "Six-week Development Camp active",
    developmentCampStartDate: hireDateTs,
    developmentCampThrough: admin.firestore.Timestamp.fromDate(through),
    developmentCampEvaluatedAt: null,
    developmentCampCompletedAt: null,
    developmentCampQualified: null,
    developmentCampX: 0,
    developmentCampRevenue: 0,
    developmentCampSalesCount: 0,
    developmentCampRefundedOrdersCount: 0,
    developmentCampPayableOrdersCount: 0,
    developmentCampBonusAmount: 0,
    developmentCampBonusTier: null,
    developmentCampBonusPaid: false,
    developmentCampBonusSnapshotId: null,
  };
}

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const authClient = await auth.getClient();

  return google.sheets({
    version: "v4",
    auth: authClient,
  });
}

async function upsertRepRow({
  repId,
  firstName,
  lastName,
  fullName,
  email,
  phone,
  currentRoleId,
  hireDate,
  programDirectorRepId,
  directorRepId,
  firebaseUid,
}) {
  const sheets = await getSheetsClient();

  const rowValues = [
    clean(repId),                        // A repId
    clean(firstName),                    // B firstName
    clean(lastName),                     // C lastName
    clean(fullName),                     // D fullName
    clean(email),                        // E email
    clean(phone),                        // F phone
    sheetBool(true),                     // G active
    sheetBool(true),                     // H appAccess
    clean(currentRoleId),                // I currentRoleId
    clean(hireDate),                     // J roleStartDate
    clean(hireDate),                     // K hireDate
    clean(programDirectorRepId),         // L programDirectorRepId
    clean(directorRepId),                // M directorRepId
    clean(firebaseUid),                  // N firebaseUid
    "New rep onboarded",                 // O notes
    new Date().toISOString(),            // P updatedAt
  ];

  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A2:A`,
  });

  const rows = existing.data.values || [];
  const targetRepId = clean(repId);

  let existingRowNumber = null;

  for (let i = 0; i < rows.length; i++) {
    const existingRepId = clean(rows[i][0]);
    if (existingRepId === targetRepId) {
      existingRowNumber = i + 2;
      break;
    }
  }

  if (existingRowNumber) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A${existingRowNumber}:P${existingRowNumber}`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [rowValues],
      },
    });

    return { action: "updated", rowNumber: existingRowNumber };
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:P`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [rowValues],
    },
  });

  return { action: "appended" };
}

module.exports = function registerRepRoutes(app, {
  admin,
  db,
  logger,
  REP_ONBOARD_SECRET,
  STAFF_MAIL_USER,
  STAFF_MAIL_APP_PASSWORD,
}) {
  app.post("/admin/onboardRep", async (req, res) => {
    try {
      const timestamp = clean(req.headers["x-ec-timestamp"]);
      const requestId = clean(req.headers["x-ec-request-id"]);
      const signature = clean(req.headers["x-ec-signature"]);
      const timestampMs = Number(timestamp);
      const bodyText = req.rawBody?.length
        ? req.rawBody.toString("utf8")
        : JSON.stringify(req.body || {});
      const expected = crypto
        .createHmac("sha256", REP_ONBOARD_SECRET.value())
        .update(`${timestamp}.${requestId}.${bodyText}`)
        .digest("hex");
      const signatureValid = signature.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
      if (!timestamp || !requestId || !signature || !Number.isFinite(timestampMs) ||
          Math.abs(Date.now() - timestampMs) > 5 * 60 * 1000 || !signatureValid) {
        return res.status(401).json({ ok: false, error: "Invalid or expired onboarding signature" });
      }
      const replayRef = db.collection("adminIdempotency").doc(`rep_onboard_${requestId}`);
      try {
        await replayRef.create({
          operation: "rep_onboard",
          requestId,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1000),
        });
      } catch (replayError) {
        if (String(replayError.code) === "6" || String(replayError.code).includes("already-exists")) {
          return res.status(409).json({ ok: false, error: "Onboarding request already processed" });
        }
        throw replayError;
      }

      const repId = clean(req.body.repId);
      const wordpressUserId = clean(
        req.body.wordpressUserId || req.body.wpUserId || req.body.repId
      );
      const wpUserId = clean(
        req.body.wpUserId || req.body.wordpressUserId || req.body.repId
      );

      const firstName = clean(req.body.firstName);
      const lastName = clean(req.body.lastName);
      const fullName = clean(req.body.fullName || `${firstName} ${lastName}`.trim());
      const email = normalizeEmail(req.body.email);
      const phone = normalizePhone(req.body.phone);

      const hireDateRaw = clean(req.body.hireDate);
      const roleStartDateRaw = clean(req.body.roleStartDate || req.body.hireDate);

      const programDirectorRepId = clean(req.body.programDirectorRepId);
      const directorRepId = clean(req.body.directorRepId);

      // Role is now enforced by backend for all new rep onboarding.
      const currentRoleId = DEFAULT_ROLE_ID;

      if (!repId || !firstName || !lastName || !email || !hireDateRaw) {
        return res.status(400).json({
          ok: false,
          error: "Missing required fields",
        });
      }

      await validateRepHierarchy(db, {
        repId,
        currentRoleId,
        programDirectorRepId,
        directorRepId,
      });

      const hireDateTs = toFirestoreTimestamp(admin, hireDateRaw);
      const roleStartDateTs = toFirestoreTimestamp(admin, roleStartDateRaw);

      if (!hireDateTs || !roleStartDateTs) {
        return res.status(400).json({
          ok: false,
          error: "Invalid hireDate or roleStartDate",
        });
      }

      const roleSnap = await db.collection("roles").doc(currentRoleId).get();

      if (!roleSnap.exists) {
        return res.status(500).json({
          ok: false,
          error: `Role document ${currentRoleId} not found`,
        });
      }

      const roleData = roleSnap.data() || {};
      const currentRoleName = clean(
        roleData.displayName || roleData.roleName || currentRoleId
      );

      let authUser;

      try {
        authUser = await admin.auth().getUserByEmail(email);
      } catch (err) {
        if (err.code === "auth/user-not-found") {
          authUser = await admin.auth().createUser({
            email,
            displayName: fullName,
            disabled: false,
          });
        } else {
          throw err;
        }
      }

      const firebaseUid = authUser.uid;
      const now = admin.firestore.FieldValue.serverTimestamp();

      await admin.auth().setCustomUserClaims(firebaseUid, {
        role: "sales_rep",
      });

      const userRef = db.collection("users").doc(firebaseUid);
      const repRef = db.collection("reps").doc(repId);

      const [userSnap, repSnap, roleHistorySnap] = await Promise.all([
        userRef.get(),
        repRef.get(),
        repRef.collection("roleHistory").limit(1).get(),
      ]);

      const currentMonth = getCurrentMonthWindow(new Date());

      const isNewRep = !repSnap.exists;
      const existingRep = repSnap.data() || {};
      const effectiveCurrentRoleId = isNewRep
        ? currentRoleId
        : clean(existingRep.currentRoleId || currentRoleId);
      const effectiveCurrentRoleName = isNewRep
        ? currentRoleName
        : clean(existingRep.currentRoleName || currentRoleName);
      const developmentCampEnrollment = isNewRep
        ? buildDevelopmentCampEnrollment(admin, hireDateTs)
        : {};

      const bonusDefaults = {
        bonusStatusMonthKey: currentMonth.monthKey,
        bonusStatusEvaluatedAt: now,

        personalBonusStatus: "onBonus",
        personalBonusReason: "Six-week Development Camp active",

        ...developmentCampEnrollment,

        leadershipBonusStatus: "offBonus",
        leadershipBonusReason: "Initial onboarding default",

        directorBonusStatus: "offBonus",
        directorBonusReason: "Initial onboarding default",

        previousMonthPersonalX: 0,
        previousMonthPersonalRevenue: 0,
        previousMonthPersonalSalesCount: 0,
        previousMonthRefundedOrdersCount: 0,
        previousMonthPayableOrdersCount: 0,
        previousMonthRefundRate: 0,
        previousMonthUnapprovedAbsences: 0,

        previousMonthCodedPodX: 0,
        previousMonthCodedPodRevenue: 0,
        previousMonthPodX: 0,
        previousMonthPodRevenue: 0,
        previousMonthDevelopmentCampX: 0,

        previousMonthQualifiedPdPodX: 0,
        previousMonthQualifiedPdPodRevenue: 0,

        qualificationPeriod: {
          monthKey: currentMonth.monthKey,
          start: admin.firestore.Timestamp.fromDate(currentMonth.start),
          end: admin.firestore.Timestamp.fromDate(currentMonth.end),
        },
      };

      const userPayload = {
        uid: firebaseUid,
        email,
        firstName,
        lastName,
        fullName,
        phone,
        userType: "rep",
        source: "wordpress_onboarding",

        repId,
        wordpressUserId,
        wpUserId,

        active: true,
        appAccess: true,
        woocommerceAccess: req.body.woocommerceAccess === true,
        status: "active",

        ...(isNewRep ? {
          currentRoleId,
          currentRoleName,
          hireDate: hireDateTs,
          roleStartDate: roleStartDateTs,
        } : {}),

        programDirectorRepId,
        directorRepId,

        homeCityId: clean(req.body.homeCityId || "yyc"),
        employmentType: clean(req.body.employmentType || "contractor"),

        ...(isNewRep ? {
          isLeader: false,
          isAdmin: false,
          canApproveTimeOff: false,
          canManageSchedule: false,
          canReviewPayroll: false,
        } : {}),

        ...(isNewRep ? bonusDefaults : {}),

        updatedAt: now,
      };

      if (!userSnap.exists) {
        userPayload.createdAt = now;
      }

      const repPayload = {
        repId,
        wordpressUserId,
        wpUserId,
        firebaseUid,

        email,
        phone,
        firstName,
        lastName,
        fullName,

        active: true,
        appAccess: true,
        woocommerceAccess: req.body.woocommerceAccess === true,
        status: "active",

        ...(isNewRep ? {
          currentRoleId,
          currentRoleName,
          hireDate: hireDateTs,
          roleStartDate: roleStartDateTs,
        } : {}),

        programDirectorRepId,
        directorRepId,

        homeCityId: clean(req.body.homeCityId || "yyc"),
        employmentType: clean(req.body.employmentType || "contractor"),

        ...(isNewRep ? {
          isLeader: false,
          isAdmin: false,
          canApproveTimeOff: false,
          canManageSchedule: false,
          canReviewPayroll: false,
        } : {}),

        notes: "New rep onboarded",
        source: "wordpress_onboarding",

        ...(isNewRep ? bonusDefaults : {}),

        updatedAt: now,
      };

      if (!repSnap.exists) {
        repPayload.createdAt = now;
      }

      const batch = db.batch();

      batch.set(userRef, userPayload, { merge: true });
      batch.set(repRef, repPayload, { merge: true });

      /**
       * Initial roleHistory entry
       * Only create this if no role history exists yet,
       * so repeated onboarding/upsert calls do not duplicate it.
       */
      if (roleHistorySnap.empty) {
        const roleHistoryRef = repRef.collection("roleHistory").doc();

        batch.set(roleHistoryRef, {
          repId,
          roleId: currentRoleId,
          effectiveStart: roleStartDateTs,
          effectiveEnd: null,
          source: "wordpress_onboarding",
          reason: "Initial onboarding",
          createdBy: "system",
          createdAt: now,
          updatedAt: now,
        });
      }

      /**
       * Initial monthly qualification history doc
       * Safe to merge so onboarding reruns do not break.
       */
      const monthlyQualificationRef = repRef
        .collection("monthlyQualifications")
        .doc(currentMonth.monthKey);

      if (isNewRep) batch.set(
        monthlyQualificationRef,
        {
          repId,
          monthKey: currentMonth.monthKey,
          roleIdEvaluated: currentRoleId,

          personalBonusStatus: "onBonus",
          personalBonusReason: "Six-week Development Camp active",

          developmentCampStatus: "active",
          developmentCampBonusStatus: "onBonus",
          developmentCampBonusReason: "Six-week Development Camp active",
          developmentCampStartDate: developmentCampEnrollment.developmentCampStartDate,
          developmentCampThrough: developmentCampEnrollment.developmentCampThrough,

          leadershipBonusStatus: "offBonus",
          leadershipBonusReason: "Initial onboarding default",

          directorBonusStatus: "offBonus",
          directorBonusReason: "Initial onboarding default",

          personalX: 0,
          personalRevenue: 0,
          personalSalesCount: 0,
          refundedOrdersCount: 0,
          payableOrdersCount: 0,
          refundRate: 0,
          unapprovedAbsences: 0,

          codedPodX: 0,
          codedPodRevenue: 0,
          podX: 0,
          podRevenue: 0,
          developmentCampX: 0,

          qualifiedPdPodX: 0,
          qualifiedPdPodRevenue: 0,

          codedRepIds: [],
          codedPdIds: [],
          qualifiedPdIds: [],

          qualificationPeriod: {
            monthKey: currentMonth.monthKey,
            start: admin.firestore.Timestamp.fromDate(currentMonth.start),
            end: admin.firestore.Timestamp.fromDate(currentMonth.end),
          },

          calculatedAt: now,
          updatedAt: now,
        },
        { merge: true }
      );

      await batch.commit();

      let teamMembership;
      try {
        teamMembership = await ensureTeamRepMembership({
          db,
          admin,
          repId,
          firebaseUid,
          email,
          cityId: clean(req.body.homeCityId || "yyc"),
        });

        const membershipStatus = {
          onboardingStatus: "membership_complete",
          teamRepMembershipId: teamMembership.membershipId,
          membershipProvisioningStatus: "complete",
          membershipProvisioningError: null,
          membershipProvisionedAt:
            admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        await Promise.all([
          userRef.set(membershipStatus, { merge: true }),
          repRef.set(membershipStatus, { merge: true }),
        ]);
      } catch (membershipError) {
        const membershipFailure = {
          onboardingStatus: "membership_pending",
          teamRepMembershipId: `R${repId}`,
          membershipProvisioningStatus: "failed",
          membershipProvisioningError: String(
            membershipError?.message || membershipError
          ).slice(0, 1000),
          membershipProvisioningUpdatedAt:
            admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        await Promise.all([
          userRef.set(membershipFailure, { merge: true }),
          repRef.set(membershipFailure, { merge: true }),
        ]);
        throw membershipError;
      }

      const sheetResult = await upsertRepRow({
        repId,
        firstName,
        lastName,
        fullName,
        email,
        phone,
        currentRoleId: effectiveCurrentRoleId,
        hireDate: hireDateRaw,
        programDirectorRepId,
        directorRepId,
        firebaseUid,
      });

      const welcomeAlreadySent =
        !isNewRep &&
        clean(existingRep.welcomeEmailStatus).toLowerCase() === "sent";
      let emailSent = welcomeAlreadySent;
      let emailSkipped = welcomeAlreadySent;
      let emailError = null;

      if (!welcomeAlreadySent) {
        try {
          const passwordLink = await admin.auth().generatePasswordResetLink(email);

          const mailResult = await sendRepPasswordResetEmail({
            toEmail: email,
            repName: fullName || firstName || null,
            repId,
            currentRoleId: effectiveCurrentRoleId,
            currentRoleName: effectiveCurrentRoleName,
            complimentaryVipActive: true,
            passwordLink,
            mailUserSecret: STAFF_MAIL_USER || null,
            mailAppPasswordSecret: STAFF_MAIL_APP_PASSWORD || null,
          });

          emailSent = !!mailResult?.ok;
          if (!mailResult?.ok) {
            emailError = mailResult?.error || "Unknown mailer error";
          }
        } catch (mailErr) {
          emailSent = false;
          emailError = String(mailErr?.message || mailErr);

          logger.error("REP_ONBOARD_MAIL_FAILED", {
            repId,
            email,
            firebaseUid,
            error: emailError,
            stack: mailErr?.stack || null,
          });
        }
      }

      const finalOnboardingStatus = {
        onboardingStatus: emailSent ? "complete" : "email_pending",
        welcomeEmailStatus: emailSent ? "sent" : "failed",
        welcomeEmailError: emailError,
        welcomeEmailUpdatedAt:
          admin.firestore.FieldValue.serverTimestamp(),
        ...(emailSent && !emailSkipped ? {
          welcomeEmailSentAt:
            admin.firestore.FieldValue.serverTimestamp(),
        } : {}),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      await Promise.all([
        userRef.set(finalOnboardingStatus, { merge: true }),
        repRef.set(finalOnboardingStatus, { merge: true }),
      ]);

      await writeAdminAudit(db, admin, {
        action: "rep.onboard",
        actorUid: "wordpress",
        actorEmail: email,
        targetType: "rep",
        targetId: repId,
        reason: isNewRep ? "Initial onboarding" : "Idempotent onboarding recovery",
        requestId,
        before: isNewRep ? null : { status: existingRep.status || null },
        after: { status: "active", firebaseUid, currentRoleId: effectiveCurrentRoleId, programDirectorRepId, directorRepId, teamMembership },
      });

      logger.info("REP_ONBOARD_SUCCESS", {
        repId,
        email,
        firebaseUid,
        currentRoleId: effectiveCurrentRoleId,
        currentRoleName: effectiveCurrentRoleName,
        sheetAction: sheetResult.action,
        emailSent,
        emailSkipped,
        membershipId: teamMembership.membershipId,
        membershipCreated: teamMembership.created,
      });

      return res.status(200).json({
        ok: true,
        repId,
        wordpressUserId,
        wpUserId,
        firebaseUid,
        currentRoleId,
        currentRoleName,
        sheetAction: sheetResult.action,
        emailSent,
        emailSkipped,
        emailError,
        teamMembership,
      });
    } catch (err) {
      logger.error("REP_ONBOARD_FAILED", {
        error: String(err),
        stack: err?.stack || null,
      });

      return res.status(500).json({
        ok: false,
        error: err.message || "Rep onboarding failed",
      });
    }
  });
};
