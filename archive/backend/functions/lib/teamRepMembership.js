"use strict";

const { provisionMembershipEntitlements } = require("./provision");

const REP_MEMBERSHIP_PRODUCT_ID = 2934;
const REP_MEMBERSHIP_TIER = "vip";
const REP_MEMBERSHIP_TIER_NUMBER = 2;
const REP_VIP_CREDITS = 5;

function clean(value) {
  return String(value ?? "").trim();
}

function buildRepMembershipId(repId) {
  const normalized = clean(repId);
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error("A valid numeric WordPress repId is required");
  }
  return `R${normalized}`;
}

function safeError(error) {
  return clean(error?.message || error || "Unknown membership provisioning error")
    .slice(0, 1000);
}

/**
 * Creates a complimentary team-rep VIP membership without entering any
 * WooCommerce, order-ingest, attribution, accounting, or commission flow.
 */
async function ensureTeamRepMembership({
  db,
  admin,
  repId,
  firebaseUid,
  email,
  cityId = "yyc",
  provisionEntitlements = provisionMembershipEntitlements,
}) {
  if (!db) throw new Error("Missing db");
  if (!admin) throw new Error("Missing admin");
  if (typeof provisionEntitlements !== "function") {
    throw new Error("Missing membership entitlement provisioner");
  }

  const normalizedRepId = clean(repId);
  const uid = clean(firebaseUid);
  const normalizedEmail = clean(email).toLowerCase();
  const normalizedCityId = clean(cityId) || "yyc";
  const membershipId = buildRepMembershipId(normalizedRepId);

  if (!uid) throw new Error("A Firebase UID is required");

  const membershipRef = db.collection("memberships").doc(membershipId);
  const existingRepMembershipSnap = await membershipRef.get();

  if (existingRepMembershipSnap.exists) {
    const existing = existingRepMembershipSnap.data() || {};
    if (clean(existing.uid) !== uid || clean(existing.repId) !== normalizedRepId) {
      throw new Error(`Membership ${membershipId} belongs to a different rep or user`);
    }
    if (clean(existing.wooOrderId) || clean(existing.sourceWooOrderId)) {
      throw new Error(`Rep membership ${membershipId} cannot contain a WooCommerce order ID`);
    }
    if (existing.provisioningStatus === "complete" &&
        existing.offersProvisionedAt &&
        existing.vipCreditsProvisionedAt) {
      return {
        membershipId,
        status: "complete",
        created: false,
        resumed: false,
        alreadyComplete: true,
        reusedExistingVip: false,
        entitlementsProvisioned: true,
      };
    }
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  let created = false;

  // The shared provisioner writes absolute catalogue totals when it finishes.
  // On recovery, preserve balances that may already reflect redemptions.
  const existingRepMembership = existingRepMembershipSnap.exists
    ? existingRepMembershipSnap.data() || {}
    : {};
  const preservedRemainingBalances = existingRepMembershipSnap.exists
    ? {
        ...(Number.isFinite(existingRepMembership.offersRemainingCount)
          ? { offersRemainingCount: existingRepMembership.offersRemainingCount }
          : {}),
        ...(Number.isFinite(existingRepMembership.savingsRemainingDollars)
          ? { savingsRemainingDollars: existingRepMembership.savingsRemainingDollars }
          : {}),
      }
    : {};

  if (!existingRepMembershipSnap.exists) {
    await db.runTransaction(async (tx) => {
      const current = await tx.get(membershipRef);
      if (current.exists) {
        const data = current.data() || {};
        if (clean(data.uid) !== uid || clean(data.repId) !== normalizedRepId) {
          throw new Error(`Membership ${membershipId} belongs to a different rep or user`);
        }
        return;
      }

      created = true;
      tx.create(membershipRef, {
        membershipId,
        uid,
        repId: normalizedRepId,
        tier: REP_MEMBERSHIP_TIER,
        tierNumber: REP_MEMBERSHIP_TIER_NUMBER,
        productId: REP_MEMBERSHIP_PRODUCT_ID,
        cityId: normalizedCityId,
        cityAccess: [normalizedCityId],
        billingEmail: normalizedEmail || null,
        active: true,
        status: "active",
        source: "rep_onboarding",
        grantType: "team_rep_vip",
        complimentary: true,
        paymentRequired: false,
        wooOrderId: null,
        sourceWooOrderId: null,
        vipGiftsTotal: REP_VIP_CREDITS,
        vipGiftsRemaining: REP_VIP_CREDITS,
        provisioningStatus: "pending",
        provisioningError: null,
        provisioningLastAttemptAt: now,
        createdAt: now,
        updatedAt: now,
      });

      tx.update(db.collection("users").doc(uid), {
        teamRepMembershipId: membershipId,
        teamRepMembershipTier: REP_MEMBERSHIP_TIER,
        teamRepMembershipStatus: "active",
        "summary.activeMembershipCount":
          admin.firestore.FieldValue.increment(1),
        "summary.hasActiveVipMembership": true,
        "summary.vipGiftsRemainingTotal":
          admin.firestore.FieldValue.increment(REP_VIP_CREDITS),
        "summary.lastSummaryEventType": "rep_membership_created",
        "summary.lastSummaryUpdatedAt": now,
        updatedAt: now,
      });
    });
  } else {
    await membershipRef.set({
      provisioningStatus: "pending",
      provisioningError: null,
      provisioningLastAttemptAt: now,
      updatedAt: now,
    }, { merge: true });
  }

  try {
    await provisionEntitlements(db, admin, { membershipId });
    await membershipRef.set({
      ...preservedRemainingBalances,
      provisioningStatus: "complete",
      provisioningError: null,
      provisionedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    return {
      membershipId,
      status: "complete",
      created,
      resumed: !created,
      alreadyComplete: false,
      reusedExistingVip: false,
      entitlementsProvisioned: true,
    };
  } catch (error) {
    await membershipRef.set({
      provisioningStatus: "failed",
      provisioningError: safeError(error),
      provisioningLastAttemptAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    throw error;
  }
}

module.exports = {
  buildRepMembershipId,
  ensureTeamRepMembership,
};
