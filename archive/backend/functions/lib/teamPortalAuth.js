"use strict";

function clean(value) {
  return value == null ? "" : String(value).trim();
}

function roleNumber(value) {
  const match = clean(value).match(/^ROLE\s*([0-9]+)$/i);
  return match ? Number(match[1]) : 0;
}

function isPlatformAdmin(claims = {}) {
  return clean(claims.role).toLowerCase() === "platform_admin";
}

function isActiveRep(user = {}) {
  const status = clean(user.status).toLowerCase();
  return (
    clean(user.userType).toLowerCase() === "rep" &&
    user.active === true &&
    status !== "inactive" &&
    user.appAccess !== false &&
    Boolean(clean(user.repId))
  );
}

function canUseCareerMeeting(user = {}, claims = {}) {
  return isPlatformAdmin(claims) || (isActiveRep(user) && roleNumber(user.currentRoleId) >= 7);
}

function safeUser(uid, user = {}, claims = {}) {
  const platformAdmin = isPlatformAdmin(claims);
  const activeRep = isActiveRep(user);
  return {
    uid,
    repId: clean(user.repId),
    fullName: clean(user.fullName || user.name || claims.name),
    firstName: clean(user.firstName),
    lastName: clean(user.lastName),
    email: clean(user.email || claims.email),
    currentRoleId: clean(user.currentRoleId),
    currentRoleName: clean(user.currentRoleName || user.roleName),
    userType: clean(user.userType),
    active: user.active === true,
    appAccess: user.appAccess !== false,
    platformAdmin,
    activeRep,
    permissions: {
      portal: activeRep || platformAdmin,
      manual: activeRep || platformAdmin,
      certification: activeRep,
      leadershipBlueprint: activeRep,
      careerMeeting: canUseCareerMeeting(user, claims),
    },
  };
}

function createTeamPortalAuth({ admin, db, logger }) {
  async function authenticate(req, res, next) {
    try {
      const header = req.get("authorization") || "";
      const match = header.match(/^Bearer\s+(.+)$/i);
      if (!match) return res.status(401).json({ ok: false, error: "Missing Firebase bearer token" });

      const claims = await admin.auth().verifyIdToken(match[1]);
      const snap = await db.collection("users").doc(claims.uid).get();
      const user = snap.exists ? (snap.data() || {}) : {};
      const profile = safeUser(claims.uid, user, claims);

      if (!profile.permissions.portal) {
        return res.status(403).json({ ok: false, error: "Active EC team access is required" });
      }

      req.portalAuth = { uid: claims.uid, claims, token: match[1] };
      req.portalUser = profile;
      req.portalUserData = user;
      return next();
    } catch (error) {
      logger?.warn?.("TEAM_PORTAL_AUTH_REJECTED", { message: error.message });
      return res.status(401).json({ ok: false, error: "Your EC session is invalid or has expired" });
    }
  }

  function requirePermission(permission) {
    return (req, res, next) => {
      if (!req.portalUser?.permissions?.[permission]) {
        return res.status(403).json({ ok: false, error: "You do not have access to this EC tool" });
      }
      return next();
    };
  }

  return {
    authenticate,
    requirePermission,
    roleNumber,
    isPlatformAdmin,
    isActiveRep,
    canUseCareerMeeting,
  };
}

module.exports = {
  createTeamPortalAuth,
  roleNumber,
  isPlatformAdmin,
  isActiveRep,
  canUseCareerMeeting,
};
