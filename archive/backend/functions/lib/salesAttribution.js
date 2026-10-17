"use strict";

const ATTRIBUTION_VERSION = 1;
const { validateRepHierarchy } = require("./repHierarchy");

function clean(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function canonicalRepName(rep = {}) {
  return clean(
    rep.fullName ||
      [rep.firstName, rep.lastName].filter(Boolean).join(" ") ||
      rep.displayName
  );
}

function attributionFields(value = {}) {
  return {
    salesRepId: clean(value.salesRepId),
    salesRepName: clean(value.salesRepName),
    roleIdAtSale: clean(value.roleIdAtSale),
    programDirectorRepId: clean(value.programDirectorRepId),
    directorRepId: clean(value.directorRepId),
    attributionStatus: clean(value.attributionStatus),
    attributionSource: clean(value.attributionSource),
    attributionVersion: Number(value.attributionVersion || ATTRIBUTION_VERSION),
    attributionCapturedAt: value.attributionCapturedAt || null,
    attributionValidatedAt: value.attributionValidatedAt || null,
    submittedSalesRepId: clean(value.submittedSalesRepId),
    attributionIssue: clean(value.attributionIssue),
    attributionCorrected: value.attributionCorrected === true,
    lastAttributionCorrectionId: clean(value.lastAttributionCorrectionId),
    attributionFinalized: value.attributionFinalized === true,
    attributionFinalizedAt: value.attributionFinalizedAt || null,
    provisionalSubmittedSalesRepId: clean(value.provisionalSubmittedSalesRepId),
    provisionalAttributionSource: clean(value.provisionalAttributionSource),
    provisionalAttributionCapturedAt: value.provisionalAttributionCapturedAt || null,
  };
}

function hasCanonicalAttribution(existing = {}) {
  existing = existing || {};
  return ["rep_attributed", "self_serve", "needs_review", "admin_corrected"]
    .includes(clean(existing.attributionStatus));
}

function isRevalidatableReview(existing = {}, submittedSalesRepId) {
  return clean(existing.attributionStatus) === "needs_review" &&
    clean(existing.attributionIssue) === "missing_hierarchy" &&
    sameClaim(existing, submittedSalesRepId);
}

function legacyAttributionState(existing = {}) {
  existing = existing || {};
  if (hasCanonicalAttribution(existing)) return null;

  const fields = [
    "salesRepId",
    "salesRepName",
    "roleIdAtSale",
    "programDirectorRepId",
    "directorRepId",
  ];
  const populated = fields.filter((field) => clean(existing[field]));
  if (!populated.length) return null;

  return populated.length === fields.length ? "complete" : "partial";
}

function sameClaim(existing = {}, submittedSalesRepId) {
  existing = existing || {};
  const submitted = clean(submittedSalesRepId);
  // WooCommerce frequently omits metadata on later status/refund events.
  // Absence is not a new claim and must never disturb the accepted snapshot.
  if (!submitted) return true;
  return submitted === clean(existing.salesRepId) || submitted === clean(existing.submittedSalesRepId);
}

function preserveExistingAttribution(existing = {}, submittedSalesRepId) {
  existing = existing || {};
  const canonical = hasCanonicalAttribution(existing);
  const legacyState = legacyAttributionState(existing);
  if (!canonical && !legacyState) return null;

  const preserved = attributionFields(existing);
  if (legacyState) {
    preserved.attributionStatus = legacyState === "complete"
      ? "rep_attributed"
      : "needs_review";
    preserved.attributionSource = clean(existing.attributionSource) || "legacy";
    preserved.submittedSalesRepId = preserved.submittedSalesRepId || preserved.salesRepId;
    preserved.attributionIssue = legacyState === "partial"
      ? "partial_legacy_snapshot"
      : null;
  }
  const claimMatches = sameClaim(existing, submittedSalesRepId);
  const reviewIssue = !claimMatches
    ? "conflicting_attribution"
    : legacyState === "partial"
      ? "partial_legacy_snapshot"
      : null;
  return {
    ...preserved,
    // Canonicalize legacy metadata without changing the preserved rep snapshot.
    preserved: canonical,
    requiresReview: Boolean(reviewIssue),
    reviewIssue,
  };
}

async function validateRepForSale(db, submittedSalesRepId, transaction = null) {
  const repId = clean(submittedSalesRepId);
  if (!repId) return { ok: false, issue: "invalid_rep_id", rep: null };

  const ref = db.collection("reps").doc(repId);
  const snap = transaction ? await transaction.get(ref) : await ref.get();
  if (!snap.exists) return { ok: false, issue: "invalid_rep_id", rep: null };

  const rep = snap.data() || {};
  if (rep.active === false || clean(rep.status) === "inactive") {
    return { ok: false, issue: "inactive_rep", rep };
  }
  if (!clean(rep.currentRoleId)) return { ok: false, issue: "invalid_role", rep };
  try {
    const hierarchy = await validateRepHierarchy(db, {
      repId,
      currentRoleId: rep.currentRoleId,
      programDirectorRepId: rep.programDirectorRepId,
      directorRepId: rep.directorRepId,
    });
    rep.programDirectorRepId = hierarchy.programDirectorRepId;
    rep.directorRepId = hierarchy.directorRepId;
  } catch (error) {
    return { ok: false, issue: "missing_hierarchy", rep, validationError: error.message };
  }

  return { ok: true, issue: null, rep };
}

async function resolveSalesAttribution({
  db,
  admin,
  submittedSalesRepId,
  source,
  existingAttribution,
  transaction,
  isPaid = true,
}) {
  const submitted = clean(submittedSalesRepId);
  const existing = existingAttribution || {};
  // A paid metadata-free delivery may establish self-serve milliseconds before
  // a concurrent delivery carrying the checkout claim. Until fulfillment has
  // completed, allow that submitted claim to enter normal validation instead
  // of permanently winning the race. Once processed, self-serve is immutable.
  const replaceableConcurrentSelfServe =
    clean(existing.attributionStatus) === "self_serve" &&
    existing.processed !== true &&
    Boolean(submitted);
  const revalidatableReview = isRevalidatableReview(existing, submitted || existing.submittedSalesRepId);
  const preserved = replaceableConcurrentSelfServe || revalidatableReview
    ? null
    : preserveExistingAttribution(existing, submitted);
  if (preserved) {
    // Every canonical or legacy snapshot predates provisional attribution and is
    // therefore treated as finalized. This protects all live historical orders.
    return {
      ...preserved,
      attributionFinalized: true,
      attributionFinalizedAt:
        preserved.attributionFinalizedAt || preserved.attributionValidatedAt || null,
    };
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  const priorProvisionalId = clean(existing.provisionalSubmittedSalesRepId);
  const priorProvisionalSource = clean(existing.provisionalAttributionSource);

  if (!isPaid) {
    const provisionalId = priorProvisionalId || submitted;
    return {
      ...attributionFields({
        attributionVersion: ATTRIBUTION_VERSION,
        attributionFinalized: false,
        provisionalSubmittedSalesRepId: provisionalId,
        provisionalAttributionSource:
          priorProvisionalSource || clean(source) || (provisionalId ? "manual_checkout" : null),
        provisionalAttributionCapturedAt:
          existing.provisionalAttributionCapturedAt || (provisionalId ? now : null),
      }),
      preserved: false,
      requiresReview: false,
      reviewIssue: null,
    };
  }

  // Paid webhook metadata can be incomplete. Use the first claim captured during
  // checkout when the paid delivery omits it, then validate at payment time.
  const finalSubmitted = submitted || priorProvisionalId;
  const attributionSource = submitted
    ? clean(source) || priorProvisionalSource || "manual_checkout"
    : priorProvisionalSource || clean(source) || (finalSubmitted ? "manual_checkout" : "self_serve");

  if (!finalSubmitted) {
    return {
      ...attributionFields({
        attributionStatus: "self_serve",
        attributionSource: "self_serve",
        attributionVersion: ATTRIBUTION_VERSION,
        attributionCapturedAt: now,
        attributionValidatedAt: now,
        attributionFinalized: true,
        attributionFinalizedAt: now,
      }),
      preserved: false,
      requiresReview: false,
      reviewIssue: null,
    };
  }

  const validation = await validateRepForSale(db, finalSubmitted, transaction);
  if (!validation.ok) {
    const knownRep = validation.rep && validation.issue === "missing_hierarchy"
      ? validation.rep
      : null;
    return {
      ...attributionFields({
        salesRepId: knownRep ? finalSubmitted : null,
        salesRepName: knownRep ? canonicalRepName(knownRep) : null,
        roleIdAtSale: knownRep ? knownRep.currentRoleId : null,
        attributionStatus: "needs_review",
        attributionSource,
        attributionVersion: ATTRIBUTION_VERSION,
        attributionCapturedAt: now,
        attributionValidatedAt: now,
        submittedSalesRepId: finalSubmitted,
        attributionIssue: validation.issue,
        attributionFinalized: true,
        attributionFinalizedAt: now,
      }),
      preserved: false,
      requiresReview: true,
      reviewIssue: validation.issue,
    };
  }

  const rep = validation.rep;
  return {
    ...attributionFields({
      salesRepId: finalSubmitted,
      salesRepName: canonicalRepName(rep),
      roleIdAtSale: rep.currentRoleId,
      programDirectorRepId: rep.programDirectorRepId,
      directorRepId: rep.directorRepId,
      attributionStatus: "rep_attributed",
      attributionSource,
      attributionVersion: ATTRIBUTION_VERSION,
      attributionCapturedAt: now,
      attributionValidatedAt: now,
      submittedSalesRepId: finalSubmitted,
      attributionFinalized: true,
      attributionFinalizedAt: now,
    }),
    preserved: false,
    requiresReview: false,
    reviewIssue: null,
  };
}

module.exports = {
  ATTRIBUTION_VERSION,
  attributionFields,
  canonicalRepName,
  hasCanonicalAttribution,
  isRevalidatableReview,
  legacyAttributionState,
  preserveExistingAttribution,
  resolveSalesAttribution,
  validateRepForSale,
};
