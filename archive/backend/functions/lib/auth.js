// lib/auth.js
// Firebase Auth middleware for Express (ID token verification + role checks)

async function requireAuth(admin, req, res, next) {
  try {
    const header = req.get("authorization") || "";
    const match = header.match(/^Bearer (.+)$/i);
    if (!match) return res.status(401).json({ ok: false, error: "Missing Bearer token" });

    const token = match[1];
    const decoded = await admin.auth().verifyIdToken(token);

    // attach to request for downstream use
    req.auth = {
      uid: decoded.uid,
      email: decoded.email || null,
      claims: decoded,
      role: decoded.role || null,
      businessId: decoded.businessId || null,
    };

    return next();
  } catch (err) {
    return res.status(401).json({ ok: false, error: "Invalid auth token" });
  }
}

function requireRole(roles = []) {
  return (req, res, next) => {
    const role = req?.auth?.role || null;
    if (!role) return res.status(403).json({ ok: false, error: "Missing role claim" });
    if (!roles.includes(role)) return res.status(403).json({ ok: false, error: "Forbidden" });
    return next();
  };
}

module.exports = {
  requireAuth,
  requireRole,
};
