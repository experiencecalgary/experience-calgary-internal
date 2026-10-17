"use strict";

const { HttpsError } = require("firebase-functions/v2/https");
const { recordEmails } = require("../command/commandEmailIdentity");

const USERS_COLLECTION = "users";
const PEOPLE_COLLECTION = "commandPeople";
const ORGANIZATIONS_COLLECTION = "commandOrganizations";
const THREADS_COLLECTION = "commandEmailThreads";
const CONNECTIONS_COLLECTION = "commandConnections";

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function unique(values) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function displayName(data = {}) {
  return (
    clean(data.fullName) ||
    clean(data.displayName) ||
    [clean(data.firstName), clean(data.lastName)].filter(Boolean).join(" ") ||
    clean(data.name) ||
    clean(data.email)
  );
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(value));
}

function normalizeEmail(value) {
  return clean(value).toLowerCase();
}

function validateDocumentPath(path, collection, fieldName) {
  const value = clean(path);
  if (!value) return null;

  const parts = value.split("/").filter(Boolean);
  if (parts.length !== 2 || parts[0] !== collection) {
    throw new HttpsError(
      "invalid-argument",
      `${fieldName} must be a ${collection}/{documentId} path.`
    );
  }

  return value;
}

async function requireEmailActor(db, request) {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "You must be signed in.");
  }

  const userRef = db.collection(USERS_COLLECTION).doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    throw new HttpsError(
      "permission-denied",
      "A matching user profile was not found."
    );
  }

  const userData = userSnap.data() || {};
  if (userData.userType !== "rep" || userData.active === false) {
    throw new HttpsError(
      "permission-denied",
      "Only active Experience Calgary representatives can use Experience Command email."
    );
  }

  const repId = clean(userData.repId);
  if (!repId) {
    throw new HttpsError(
      "failed-precondition",
      "Your representative profile is missing a repId."
    );
  }

  return {
    uid,
    userRef,
    userData,
    name: displayName(userData),
    repId,
    teamRepIds: unique([
      repId,
      userData.programDirectorRepId,
      userData.directorRepId,
    ]),
  };
}

async function resolveViewerUids(db, actor) {
  const viewerUids = new Set([actor.uid]);

  for (const repId of actor.teamRepIds) {
    const snap = await db
      .collection(USERS_COLLECTION)
      .where("repId", "==", repId)
      .limit(2)
      .get();

    for (const doc of snap.docs) {
      const data = doc.data() || {};
      if (data.userType === "rep" && data.active !== false) {
        viewerUids.add(doc.id);
      }
    }
  }

  return [...viewerUids];
}

async function canAccessOwnedRecord(db, actor, data = {}) {
  if (data.archived === true) return false;
  if (clean(actor.userData?.role).toLowerCase() === "platform_admin") return true;
  if (data.ownerRef?.path === actor.userRef.path) return true;

  const recordTeamRepIds = Array.isArray(data.teamRepIds)
    ? unique(data.teamRepIds)
    : [];

  if (recordTeamRepIds.includes(actor.repId)) return true;

  const ownerRef = data.ownerRef;
  if (!ownerRef || typeof ownerRef.get !== "function") return false;

  const ownerSnap = await ownerRef.get();
  if (!ownerSnap.exists) return false;

  const owner = ownerSnap.data() || {};
  const ownerTeamRepIds = unique([
    owner.repId,
    owner.programDirectorRepId,
    owner.directorRepId,
  ]);

  return ownerTeamRepIds.includes(actor.repId);
}

async function resolveRelatedRecord(db, actor, path, collection, label) {
  const validPath = validateDocumentPath(path, collection, `${label}RefPath`);
  if (!validPath) return null;

  const ref = db.doc(validPath);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", `The selected ${label} does not exist.`);
  }

  const data = snap.data() || {};
  if (!(await canAccessOwnedRecord(db, actor, data))) {
    throw new HttpsError(
      "permission-denied",
      `You do not have access to the selected ${label}.`
    );
  }

  return { ref, data, name: displayName(data) };
}

async function resolveEmailRelationship(db, actor, raw = {}) {
  const person = await resolveRelatedRecord(
    db,
    actor,
    raw.personRefPath,
    PEOPLE_COLLECTION,
    "contact"
  );
  const organization = await resolveRelatedRecord(
    db,
    actor,
    raw.organizationRefPath,
    ORGANIZATIONS_COLLECTION,
    "organization"
  );

  if (!person && !organization) {
    throw new HttpsError(
      "invalid-argument",
      "Select a contact or organization before sending email."
    );
  }

  if (
    person &&
    organization &&
    person.data.organizationRef?.path &&
    person.data.organizationRef.path !== organization.ref.path
  ) {
    throw new HttpsError(
      "invalid-argument",
      "The selected contact does not belong to the selected organization."
    );
  }

  // When a Person is selected, send only to one of that Person's verified
  // addresses. Organization addresses are available only for Organization-only
  // email so a recipient cannot be silently changed to a different record.
  const recipientRecord = person?.data || organization?.data || {};
  const allowedAddresses = recordEmails(recipientRecord);
  const toAddress = normalizeEmail(raw.toAddress || allowedAddresses[0]);
  if (!isEmail(toAddress) || !allowedAddresses.includes(toAddress)) {
    throw new HttpsError(
      "invalid-argument",
      "The recipient address must be a primary or additional email on the selected CRM record."
    );
  }

  let linkedOrganizationData = organization?.data || null;
  const linkedOrganizationRef =
    organization?.ref || person?.data.organizationRef || null;

  if (
    !linkedOrganizationData &&
    linkedOrganizationRef &&
    typeof linkedOrganizationRef.get === "function"
  ) {
    const linkedOrganizationSnap = await linkedOrganizationRef.get();
    if (linkedOrganizationSnap.exists) {
      linkedOrganizationData = linkedOrganizationSnap.data() || {};
    }
  }

  const relationshipSources = [
    person?.data,
    linkedOrganizationData,
  ].filter(Boolean);
  const relationshipViewerUids = unique(
    relationshipSources.flatMap((data) => [
      ...(Array.isArray(data.viewerUids) ? data.viewerUids : []),
      data.ownerUid,
      data.assignedToUid,
    ])
  );
  const relationshipTeamRepIds = unique(
    relationshipSources.flatMap((data) =>
      Array.isArray(data.teamRepIds) ? data.teamRepIds : []
    )
  );

  return {
    personRef: person?.ref || null,
    personName: person?.name || "",
    organizationRef: linkedOrganizationRef,
    organizationName:
      organization?.name || clean(person?.data.organizationName),
    toAddress,
    viewerUids: relationshipViewerUids,
    teamRepIds: relationshipTeamRepIds,
  };
}

function assertThreadReadAccess(actor, thread = {}) {
  if (clean(actor.userData?.role).toLowerCase() === "platform_admin") return;
  assertThreadAccess(actor, thread);
}

function assertThreadAccess(actor, thread = {}) {
  const viewerUids = Array.isArray(thread.viewerUids)
    ? thread.viewerUids
    : [];
  const teamRepIds = Array.isArray(thread.teamRepIds)
    ? thread.teamRepIds
    : [];

  if (
    thread.ownerUid !== actor.uid &&
    !viewerUids.includes(actor.uid) &&
    !teamRepIds.includes(actor.repId)
  ) {
    throw new HttpsError(
      "permission-denied",
      "You do not have access to this email thread."
    );
  }
}

module.exports = {
  USERS_COLLECTION,
  PEOPLE_COLLECTION,
  ORGANIZATIONS_COLLECTION,
  THREADS_COLLECTION,
  CONNECTIONS_COLLECTION,
  clean,
  unique,
  displayName,
  isEmail,
  normalizeEmail,
  requireEmailActor,
  resolveViewerUids,
  resolveEmailRelationship,
  canAccessOwnedRecord,
  assertThreadReadAccess,
  assertThreadAccess,
};
