/**
 * Experience App Backend — Modular API (Gen 2)
 * Exports:
 * - api
 * - rollupBusinessRolling31
 * - mirrorFfPushToInAppInbox
 * - sortedOffers
 * - chatMessageNotifications
 *
 * SALES TEAM EXPORTS:
 * - monthlyBonusQualification
 * - repCurrentStats
 * - leaderCurrentStats
 * - leaderboards
 * - repCareerStats
 * - leaderCareerStats
 * - attendanceResolver
 * - appConfigRollover
 * - payrollSnapshots
 * - payrollSnapshotsRetry
 * - monthlyBonusSnapshots
 * - monthlyBonusSnapshotsRetry
 * - promotionQualificationScan
 * - promotionActivation
 * - developmentCampQualification
 *
 * SECURITY EXPORTS:
 * - googleSignupAlert
 * - googleSignupAlertEmailer
 */

const functionsV1 = require("firebase-functions/v1");
const { setGlobalOptions } = require("firebase-functions/v2");
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");
const { defineSecret } = require("firebase-functions/params");

const admin = require("firebase-admin");
admin.initializeApp();
const db = admin.firestore();

const express = require("express");
const cors = require("cors");

/* =====================================================
   GLOBAL OPTIONS
===================================================== */
setGlobalOptions({
  region: "us-central1",
  memory: "512MiB",
  timeoutSeconds: 120,
});

/* =====================================================
   SECRETS
===================================================== */
const WOO_WEBHOOK_SECRET = defineSecret("WOO_WEBHOOK_SECRET");
const CATALOG_SYNC_SECRET = defineSecret("CATALOG_SYNC_SECRET");
const DEV_REDEEM_KEY = defineSecret("DEV_REDEEM_KEY");
const BUSINESS_ADMINS_SYNC_SECRET = defineSecret(
  "BUSINESS_ADMINS_SYNC_SECRET"
);
const STAFF_MAIL_USER = defineSecret("STAFF_MAIL_USER");
const STAFF_MAIL_APP_PASSWORD = defineSecret(
  "STAFF_MAIL_APP_PASSWORD"
);
const REFERRAL_INVITE_SECRET = defineSecret(
  "REFERRAL_INVITE_SECRET"
);
const REP_ONBOARD_SECRET = defineSecret(
  "REP_ONBOARD_SECRET"
);

const PD_SCHEDULE_SECRET = defineSecret(
  "PD_SCHEDULE_SECRET"
);

const CAREER_MEETING_SECRET = defineSecret(
  "CAREER_MEETING_SECRET"
);

const CERTIFICATION_SYNC_SECRET = defineSecret(
  "CERTIFICATION_SYNC_SECRET"
);

const SENDGRID_API_KEY = defineSecret(
  "SENDGRID_API_KEY"
);

const SENDGRID_INBOUND_TOKEN = defineSecret(
  "SENDGRID_INBOUND_TOKEN"
);

const SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY = defineSecret(
  "SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY"
);

/* =====================================================
   PRODUCT MAP
===================================================== */
const PRODUCT_MAP = {
  1408: { cityId: "yyc", tier: "signature" },
  2934: { cityId: "yyc", tier: "vip" },
  3806: { cityId: "yyc", tier: "founding500" },
};

const PRODUCT_ID_SIGNATURE = 1408;
const PRODUCT_ID_VIP = 2934;
const ACCESS_PASS_PRODUCT_ID = 6671;
const ACCESS_ADMIN_UIDS = ["E26s7oE6aXNRrWaDpEO5hxz25jE3"];

/* =====================================================
   ROUTES
===================================================== */
const registerWooCommerceRoutes = require("./routes/woocommerce");
const registerAccessPortalRoutes = require("./routes/accessPortal");
const registerAdminRoutes = require("./routes/admin");
const registerBusinessAdminRoutes = require("./routes/businessAdmins");
const registerReferralRoutes = require("./routes/referral");
const { registerAppActionRoutes } = require("./routes/appAction");
const registerRepRoutes = require("./routes/reps");
const registerRepLifecycleRoutes = require("./routes/repLifecycle");
const registerAdminCenterRoutes = require("./routes/adminCenter");

const registerPdScheduleRoutes =
  require("./routes/pdSchedule");

const registerCareerMeetingRoutes =
  require("./routes/careerMeeting");

const registerLeadershipBlueprintRoutes =
  require("./routes/leadershipBlueprint");

const registerCertificationRoutes =
  require("./routes/certification");

const registerCertificationSyncRoutes =
  require("./routes/certificationSync");

const registerTeamPortalRoutes =
  require("./routes/teamPortal");

const registerEmailStudioRoutes =
  require("./routes/emails");

const qrRoutes = require("./routes/qr");
const redeemRoutes = require("./routes/redeem");

/* =====================================================
   LIBS
===================================================== */
const {
  verifyWooSignature,
  getMetaValue,
} = require("./lib/woo");

const {
  ingestOrderEvent,
  acquireProcessingLock,
  finalizeProcessedSuccess,
  releaseProcessingWithError,
} = require("./lib/ingest");

const {
  determineMembershipFromOrder,
  createMembershipForOrder,
} = require("./lib/memberships");

const {
  getOrCreateAuthUserByEmail,
  upsertUserDoc,
} = require("./lib/users");

const {
  sendCustomerWelcomeEmail,
  sendNewMemberNotificationEmail,
} = require("./lib/mailer");

const { provisionMembershipEntitlements } = require("./lib/provision");
const {
  isAccessPassOrder,
  accessQuantity,
  processAccessPassPurchase,
  recordAccessPassRefund,
} = require("./lib/accessPasses");
const {
  sendAccessOwnerWelcomeEmail,
} = require("./lib/accessMailer");;
const {
  createAttributionReview,
} = require("./lib/salesAttributionReview");

const createMirrorFfPushToInAppInbox =
  require("./lib/pushMirror");

const createSortedOffersCallable =
  require("./lib/sortedOffers");

const createChatMessageNotifications =
  require("./lib/chatNotifications");

const createGoogleSignupAlert =
  require("./lib/googleSignupAlert");

const {
  createGoogleSignupAlertEmailer,
} = require("./lib/googleSignupAlert");

const {
  recomputeBusinessRollingWindow,
} = require("./lib/rollups");

/* =====================================================
   SALES TEAM STATS MODULES
===================================================== */
const {
  evaluateMonthlyBonusQualifications,
} = require("./lib/monthlyBonusQualification");

const {
  evaluateDevelopmentCamps,
} = require("./lib/developmentCampQualification");

const {
  recomputeRepCurrentStats,
} = require("./lib/repCurrentStats");

const {
  recomputeLeaderCurrentStats,
} = require("./lib/leaderCurrentStats");

const {
  recomputeLeaderboards,
} = require("./lib/leaderboards");

const {
  recomputeRepCareerStats,
} = require("./lib/repCareerStats");

const {
  recomputeLeaderCareerStats,
} = require("./lib/leaderCareerStats");

const {
  resolveAttendanceStatuses,
} = require("./lib/attendanceResolver");

const {
  rolloverPayPeriodConfig,
} = require("./lib/payPeriodRollover");

const {
  createPayrollSnapshot,
} = require("./lib/payrollSnapshots");

const {
  createMonthlyBonusSnapshot,
} = require("./lib/monthlyBonusSnapshots");

const {
  scanPromotionQualifications,
  activateApprovedPromotions,
} = require("./lib/promotions");

/* =====================================================
   EXPRESS APP
===================================================== */
const app = express();
app.use(cors({ origin: true }));

app.use(
  express.json({
    limit: "2mb",
    verify: (req, res, buf) => {
      if (buf && buf.length) req.rawBody = buf;
    },
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "2mb",
  })
);

app.use((req, res, next) => {
  logger.info("REQ", {
    method: req.method,
    path: req.path,
  });
  next();
});

app.get("/ping", (req, res) =>
  res.status(200).json({
    ok: true,
    pong: true,
  })
);

/* =====================================================
   ROUTE MOUNTS
===================================================== */
registerWooCommerceRoutes(app, {
  admin,
  db,
  logger,

  WOO_WEBHOOK_SECRET,
  REFERRAL_INVITE_SECRET,

  PRODUCT_MAP,
  PRODUCT_ID_VIP,
  PRODUCT_ID_SIGNATURE,

  verifyWooSignature,
  getMetaValue,

  ingestOrderEvent,
  acquireProcessingLock,
  finalizeProcessedSuccess,
  releaseProcessingWithError,

  determineMembershipFromOrder,
  getOrCreateAuthUserByEmail,
  upsertUserDoc,
  createMembershipForOrder,

  STAFF_MAIL_USER,
  STAFF_MAIL_APP_PASSWORD,
  sendCustomerWelcomeEmail,
  sendNewMemberNotificationEmail,

  ACCESS_PASS_PRODUCT_ID,
  isAccessPassOrder,
  accessQuantity,
  processAccessPassPurchase,
  recordAccessPassRefund,
  sendAccessOwnerWelcomeEmail,
  createAttributionReview,
});

registerAccessPortalRoutes(app, {
  admin,
  db,
  logger,
  getOrCreateAuthUserByEmail,
  upsertUserDoc,
  createMembershipForOrder,
  provisionMembershipEntitlements,
  sendCustomerWelcomeEmail,
  STAFF_MAIL_USER,
  STAFF_MAIL_APP_PASSWORD,
  ACCESS_ADMIN_UIDS,
});

registerAdminRoutes(app, {
  admin,
  db,
  logger,
  CATALOG_SYNC_SECRET,
});

registerBusinessAdminRoutes(app, {
  admin,
  db,
  logger,
  BUSINESS_ADMINS_SYNC_SECRET,
  STAFF_MAIL_USER,
  STAFF_MAIL_APP_PASSWORD,
});

registerReferralRoutes(app, {
  admin,
  db,
  logger,
  REFERRAL_INVITE_SECRET,
  STAFF_MAIL_USER,
  STAFF_MAIL_APP_PASSWORD,
});

registerAppActionRoutes(app, {
  admin,
  db,
  logger,
  STAFF_MAIL_USER,
  STAFF_MAIL_APP_PASSWORD,
  REFERRAL_INVITE_SECRET,
  activateApprovedPromotions,
});

registerRepRoutes(app, {
  admin,
  db,
  logger,
  REP_ONBOARD_SECRET,
  STAFF_MAIL_USER,
  STAFF_MAIL_APP_PASSWORD,
});

registerRepLifecycleRoutes(app, {
  admin,
  db,
  logger,
  STAFF_MAIL_USER,
  STAFF_MAIL_APP_PASSWORD,
});

registerAdminCenterRoutes(app, {
  admin,
  db,
  logger,
});

registerPdScheduleRoutes(app, {
  admin,
  db,
  logger,
  PD_SCHEDULE_SECRET,
});

registerCareerMeetingRoutes(app, {
  admin,
  db,
  logger,
  CAREER_MEETING_SECRET,
  STAFF_MAIL_USER,
  STAFF_MAIL_APP_PASSWORD,
});

registerLeadershipBlueprintRoutes(app, {
  admin,
  db,
  logger,
  STAFF_MAIL_USER,
  STAFF_MAIL_APP_PASSWORD,
});

registerCertificationRoutes(app, {
  admin,
  db,
  logger,
});

registerCertificationSyncRoutes(app, {
  admin,
  db,
  logger,
  CERTIFICATION_SYNC_SECRET,
});

registerTeamPortalRoutes(app, {
  admin,
  db,
  logger,
});

registerEmailStudioRoutes(app, {
  admin,
  db,
  logger,
  STAFF_MAIL_USER,
  STAFF_MAIL_APP_PASSWORD,
});

require("./routes/me")({
  app,
  db,
  admin,
});

app.use("/qr", qrRoutes({ admin, db }));
app.use("/redeem", redeemRoutes({ admin, db }));

app.use((req, res) => {
  logger.warn("NOT_FOUND", {
    method: req.method,
    path: req.path,
  });

  res.status(404).json({
    ok: false,
    error: "Not Found",
  });
});

/* =====================================================
   EXISTING SCHEDULED
===================================================== */
exports.rollupBusinessRolling31 = onSchedule(
  {
    schedule: "every 60 minutes",
    timeZone: "America/Edmonton",
  },
  async () => {
    await recomputeBusinessRollingWindow(db, admin, {
      windowDays: 31,
    });
  }
);

/* =====================================================
   SALES TEAM SCHEDULED
===================================================== */

/**
 * Every 15 minutes
 */
exports.repCurrentStats = onSchedule(
  {
    schedule: "every 15 minutes",
    timeZone: "America/Edmonton",
  },
  async () => {
    await recomputeRepCurrentStats(
      db,
      admin,
      logger
    );
  }
);

exports.leaderCurrentStats = onSchedule(
  {
    schedule: "every 15 minutes",
    timeZone: "America/Edmonton",
  },
  async () => {
    await recomputeLeaderCurrentStats(
      db,
      admin,
      logger
    );
  }
);

exports.leaderboards = onSchedule(
  {
    schedule: "every 15 minutes",
    timeZone: "America/Edmonton",
  },
  async () => {
    await recomputeLeaderboards(
      db,
      admin,
      logger
    );
  }
);

/**
 * Daily overnight
 */
exports.repCareerStats = onSchedule(
  {
    schedule: "10 3 * * *",
    timeZone: "America/Edmonton",
  },
  async () => {
    await recomputeRepCareerStats(
      db,
      admin,
      logger
    );
  }
);

exports.leaderCareerStats = onSchedule(
  {
    schedule: "20 3 * * *",
    timeZone: "America/Edmonton",
  },
  async () => {
    await recomputeLeaderCareerStats(
      db,
      admin,
      logger
    );
  }
);

/**
 * Daily attendance resolution for yesterday.
 * Runs before monthly bonus qualification on the 1st.
 */
exports.attendanceResolver = onSchedule(
  {
    schedule: "30 3 * * *",
    timeZone: "America/Edmonton",
  },
  async () => {
    await resolveAttendanceStatuses(
      db,
      admin,
      logger
    );
  }
);

/**
 * Daily promotion qualification scan.
 * Finds newly qualified reps, writes promotion docs,
 * and emails curator@experiencecalgary.ca.
 */
exports.promotionQualificationScan = onSchedule(
  {
    schedule: "0 4 * * *",
    timeZone: "America/Edmonton",
    secrets: [STAFF_MAIL_USER, STAFF_MAIL_APP_PASSWORD],
  },
  async () => {
    await scanPromotionQualifications(
      db,
      admin,
      logger,
      {
        STAFF_MAIL_USER,
        STAFF_MAIL_APP_PASSWORD,
        notificationEmails: ["curator@experiencecalgary.ca"],
      }
    );
  }
);

/**
 * Daily one-time evaluation of each rep's exact 42-day Development Camp.
 * Separate from all calendar-month bonus qualification and payout functions.
 */
exports.developmentCampQualification = onSchedule(
  {
    schedule: "15 4 * * *",
    timeZone: "America/Edmonton",
  },
  async () => {
    await evaluateDevelopmentCamps(db, admin, logger);
  }
);

/**
 * 1st of every month AFTER attendanceResolver and monthlyBonusQualification.
 * Activates promotions already approved in Firestore by setting:
 * status = approved_pending_activation
 */
exports.promotionActivation = onSchedule(
  {
    schedule: "55 3 1 * *",
    timeZone: "America/Edmonton",
  },
  async () => {
    await activateApprovedPromotions(
      db,
      admin,
      logger
    );
  }
);

/**
 * 1st of every month AFTER attendanceResolver
 * Evaluates previous full calendar month
 * and stamps bonus status fields onto users + reps
 */
exports.monthlyBonusQualification = onSchedule(
  {
    schedule: "45 3 1 * *",
    timeZone: "America/Edmonton",
  },
  async () => {
    await evaluateMonthlyBonusQualifications(
      db,
      admin,
      logger
    );
  }
);

/**
 * Hourly
 * Recomputes current/next semi-monthly pay periods
 * based on the actual current date.
 */
exports.appConfigRollover = onSchedule(
  {
    schedule: "every 60 minutes",
    timeZone: "America/Edmonton",
  },
  async () => {
    await rolloverPayPeriodConfig(
      db,
      admin,
      logger
    );
  }
);

/**
 * Commission / override snapshot
 * Primary run on the 1st and 16th.
 * Retry/checker run 30 minutes later.
 */
exports.payrollSnapshots = onSchedule(
  {
    schedule: "20 23 1,16 * *",
    timeZone: "America/Edmonton",
  },
  async () => {
    await createPayrollSnapshot(
      db,
      admin,
      logger
    );
  }
);

exports.payrollSnapshotsRetry = onSchedule(
  {
    schedule: "50 23 1,16 * *",
    timeZone: "America/Edmonton",
  },
  async () => {
    await createPayrollSnapshot(
      db,
      admin,
      logger
    );
  }
);

/**
 * Monthly bonus snapshot
 * Primary run on the 10th.
 * Retry/checker run 30 minutes later.
 */
exports.monthlyBonusSnapshots = onSchedule(
  {
    schedule: "20 23 10 * *",
    timeZone: "America/Edmonton",
  },
  async () => {
    await createMonthlyBonusSnapshot(
      db,
      admin,
      logger
    );
  }
);

exports.monthlyBonusSnapshotsRetry = onSchedule(
  {
    schedule: "50 23 10 * *",
    timeZone: "America/Edmonton",
  },
  async () => {
    await createMonthlyBonusSnapshot(
      db,
      admin,
      logger
    );
  }
);

/* =====================================================
   EXISTING EXPORTS
===================================================== */
exports.mirrorFfPushToInAppInbox =
  createMirrorFfPushToInAppInbox({
    db,
    admin,
    logger,
  });

exports.sortedOffers =
  createSortedOffersCallable({
    db,
    admin,
    logger,
  });

exports.chatMessageNotifications =
  createChatMessageNotifications({
    db,
    admin,
    logger,
  });


/* =====================================================
   EXPERIENCE COMMAND EXPORTS
===================================================== */

const commandSearchAndListing =
  require("./routes/command/commandSearchAndListing");

const commandAlgoliaTriggers =
  require("./routes/command/commandAlgoliaTriggers");

exports.listCommandRecordsPage =
  commandSearchAndListing.listCommandRecordsPage;

exports.createCommandLeadList =
  require("./routes/command/commandLeadLists").createCommandLeadList;
exports.listCommandLeadLists =
  require("./routes/command/commandLeadLists").listCommandLeadLists;
exports.updateCommandLeadList =
  require("./routes/command/commandLeadLists").updateCommandLeadList;
exports.archiveCommandLeadList =
  require("./routes/command/commandLeadLists").archiveCommandLeadList;
exports.assignCommandLeadList =
  require("./routes/command/commandLeadLists").assignCommandLeadList;

exports.commandEmailMessageAlgoliaSync =
  commandAlgoliaTriggers.commandEmailMessageAlgoliaSync;

exports.validateCommandPerson =
  require("./routes/command/validateCommandPerson")
    .validateCommandPerson;

exports.createCommandPerson =
  require("./routes/command/createCommandPerson")
    .createCommandPerson;

exports.updateCommandPerson =
  require("./routes/command/updateCommandPerson")
    .updateCommandPerson;

exports.validateCommandOrganization =
  require("./routes/command/validateCommandOrganization")
    .validateCommandOrganization;

exports.createCommandOrganization =
  require("./routes/command/createCommandOrganization")
    .createCommandOrganization;

exports.updateCommandOrganization =
  require("./routes/command/updateCommandOrganization")
    .updateCommandOrganization;

exports.sendCommandEmail =
  require("./routes/commandEmail/sendCommandEmail")
    .createSendCommandEmailCallable({
      SENDGRID_API_KEY,
      logger,
    });

exports.replyCommandEmail =
  require("./routes/commandEmail/replyCommandEmail")
    .createReplyCommandEmailCallable({
      SENDGRID_API_KEY,
      logger,
    });

exports.getCommandEmailAttachmentDownload =
  require("./routes/commandEmail/getCommandEmailAttachmentDownload")
    .createGetCommandEmailAttachmentDownloadCallable();

exports.updateCommandEmailSettings =
  require("./routes/commandEmail/updateCommandEmailSettings")
    .createUpdateCommandEmailSettingsCallable({
      logger,
    });

exports.receiveCommandEmail =
  require("./routes/commandEmail/receiveCommandEmail")
    .createReceiveCommandEmailWebhook({
      SENDGRID_INBOUND_TOKEN,
      logger,
    });

exports.markCommandEmailThreadRead =
  require("./routes/commandEmail/markCommandEmailThreadRead")
    .createMarkCommandEmailThreadReadCallable({
      logger,
    });

exports.markCommandEmailThreadUnread =
  require("./routes/commandEmail/markCommandEmailThreadUnread")
    .createMarkCommandEmailThreadUnreadCallable({
      logger,
    });

exports.linkCommandEmailThreadToPerson =
  require("./routes/commandEmail/linkCommandEmailThreadToPerson")
    .createLinkCommandEmailThreadToPersonCallable({
      logger,
    });

exports.receiveCommandEmailEvents =
  require("./routes/commandEmail/receiveCommandEmailEvents")
    .createReceiveCommandEmailEventsWebhook({
      SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY,
      logger,
    });



/* =====================================================
   SECURITY EXPORTS
===================================================== */

/**
 * 1st gen Auth trigger.
 * Detects Google-created Firebase Auth users and creates
 * a passive security_alerts document if the users/{uid}
 * document does not contain membershipType or role.
 *
 * No secrets. No email. No delete. No user modification.
 */
exports.googleSignupAlert = functionsV1
  .auth
  .user()
  .onCreate(
    createGoogleSignupAlert({
      admin,
      db,
      logger,
    })
  );

/**
 * 2nd gen Firestore trigger.
 * Sends admin email when a security_alerts document is created.
 */
exports.googleSignupAlertEmailer = onDocumentCreated(
  {
    document: "security_alerts/{alertId}",
    region: "us-central1",
    secrets: [
      STAFF_MAIL_USER,
      STAFF_MAIL_APP_PASSWORD,
    ],
  },
  createGoogleSignupAlertEmailer({
    admin,
    db,
    logger,
    STAFF_MAIL_USER,
    STAFF_MAIL_APP_PASSWORD,
    alertEmails: ["admin@hybridadvertising.ca"],
  })
);

exports.api = onRequest(
  {
    secrets: [
      WOO_WEBHOOK_SECRET,
      CATALOG_SYNC_SECRET,
      DEV_REDEEM_KEY,
      BUSINESS_ADMINS_SYNC_SECRET,
      STAFF_MAIL_USER,
      STAFF_MAIL_APP_PASSWORD,
      REFERRAL_INVITE_SECRET,
      REP_ONBOARD_SECRET,
      PD_SCHEDULE_SECRET,
      CAREER_MEETING_SECRET,
      CERTIFICATION_SYNC_SECRET,
    ],
  },
  app
);


/* =====================================================
   COMMAND NOTIFICATIONS
===================================================== */
const commandNotificationsBackend =
  require("./routes/command/commandNotifications");

exports.listCommandNotificationsPage =
  commandNotificationsBackend.listCommandNotificationsPage;
exports.markCommandNotificationRead =
  commandNotificationsBackend.markCommandNotificationRead;
exports.markAllCommandNotificationsRead =
  commandNotificationsBackend.markAllCommandNotificationsRead;
exports.registerCommandNotificationDevice =
  commandNotificationsBackend.registerCommandNotificationDevice;
exports.unregisterCommandNotificationDevice =
  commandNotificationsBackend.unregisterCommandNotificationDevice;
exports.updateCommandNotificationPreferences =
  commandNotificationsBackend.updateCommandNotificationPreferences;
exports.commandNotificationPushDelivery =
  commandNotificationsBackend.commandNotificationPushDelivery;
exports.maintainCommandNotifications =
  commandNotificationsBackend.maintainCommandNotifications;


/* =====================================================
   COMMAND EMAIL RELATIONSHIP MAINTENANCE
===================================================== */
const commandEmailRelationshipMaintenance =
  require("./lib/commandEmail/commandEmailRelationshipMaintenance");

exports.commandPersonEmailRelationshipSync =
  commandEmailRelationshipMaintenance.commandPersonEmailRelationshipSync;
exports.backfillCommandEmailRelationships =
  commandEmailRelationshipMaintenance.backfillCommandEmailRelationships;
exports.backfillCommandEmailRelationshipsScheduled =
  commandEmailRelationshipMaintenance.backfillCommandEmailRelationshipsScheduled;
exports.unlinkCommandEmailThreadFromPerson =
  commandEmailRelationshipMaintenance.unlinkCommandEmailThreadFromPerson;
