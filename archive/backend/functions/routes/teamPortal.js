"use strict";

const { createTeamPortalAuth } = require("../lib/teamPortalAuth");

module.exports = function registerTeamPortalRoutes(app, { admin, db, logger }) {
  const auth = createTeamPortalAuth({ admin, db, logger });

  app.get("/team-portal/health", (req, res) => {
    res.status(200).json({ ok: true, system: "teamPortal", timestamp: new Date().toISOString() });
  });

  app.get("/team-portal/session", auth.authenticate, (req, res) => {
    res.status(200).json({ ok: true, user: req.portalUser, permissions: req.portalUser.permissions });
  });
};
