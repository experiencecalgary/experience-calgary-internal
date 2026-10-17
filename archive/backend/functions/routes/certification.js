"use strict";

const createCertificationService = require("../lib/certification");
const { createTeamPortalAuth } = require("../lib/teamPortalAuth");

function clean(value) {
  return value == null ? "" : String(value).trim();
}

function getRepId(req) {
  return clean(req.portalUser?.repId);
}

module.exports = function registerCertificationRoutes(app, {
  admin,
  db,
  logger,
}) {
  const service = createCertificationService({ admin, db, logger });
  const portalAuth = createTeamPortalAuth({ admin, db, logger });
  const protect = [portalAuth.authenticate, portalAuth.requirePermission("certification")];

  function sendError(res, err, logKey) {
    const status = Number(err.statusCode || 500);
    logger.error(logKey, {
      status,
      message: clean(err.message),
      stack: status >= 500 ? clean(err.stack).slice(0, 4000) : undefined,
    });
    return res.status(status).json({
      ok: false,
      error: status >= 500 ? "Certification request failed." : err.message,
    });
  }

  app.get("/certification/health", (req, res) => {
    return res.status(200).json({
      ok: true,
      system: "certification",
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/certification/dashboard", ...protect, async (req, res) => {
    try {
      const dashboard = await service.getDashboard(getRepId(req));
      return res.status(200).json({ ok: true, ...dashboard });
    } catch (err) {
      return sendError(res, err, "CERTIFICATION_DASHBOARD_ERROR");
    }
  });

  app.post("/certification/attempts/start", ...protect, async (req, res) => {
    try {
      const result = await service.startAttempt({
        repId: getRepId(req),
        certificationId: req.body?.certificationId,
        mode: req.body?.mode,
      });
      return res.status(201).json({ ok: true, ...result });
    } catch (err) {
      return sendError(res, err, "CERTIFICATION_START_ERROR");
    }
  });

  app.post("/certification/attempts/:attemptId/check", ...protect, async (req, res) => {
    try {
      const result = await service.checkPracticeAnswer({
        repId: getRepId(req),
        attemptId: req.params.attemptId,
        questionId: req.body?.questionId,
        selectedOption: req.body?.selectedOption,
      });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return sendError(res, err, "CERTIFICATION_CHECK_ERROR");
    }
  });

  app.post("/certification/attempts/:attemptId/submit", ...protect, async (req, res) => {
    try {
      const result = await service.submitAttempt({
        repId: getRepId(req),
        attemptId: req.params.attemptId,
        answers: req.body?.answers,
        finalReflection: req.body?.finalReflection,
        browserInfo: req.body?.browserInfo,
      });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return sendError(res, err, "CERTIFICATION_SUBMIT_ERROR");
    }
  });
};
