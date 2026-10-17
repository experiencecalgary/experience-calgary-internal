"use strict";

const PROGRAM_DIRECTOR_ROLE = "ROLE7";
const DIRECTOR_ROLES = new Set(["ROLE8", "ROLE9", "ROLE10", "ROLE11"]);

function clean(value) { return String(value ?? "").trim(); }
function isProgramDirectorRole(roleId) { return clean(roleId) === PROGRAM_DIRECTOR_ROLE; }
function isDirectorRole(roleId) { return DIRECTOR_ROLES.has(clean(roleId)); }

function canonicalHierarchyForRole({ repId, roleId, programDirectorRepId, directorRepId }) {
  const subjectId = clean(repId);
  const normalizedRole = clean(roleId);
  if (!subjectId || !normalizedRole) throw new Error("Rep ID and current role are required");
  if (isDirectorRole(normalizedRole)) {
    return { programDirectorRepId: subjectId, directorRepId: subjectId };
  }
  if (isProgramDirectorRole(normalizedRole)) {
    return { programDirectorRepId: subjectId, directorRepId: clean(directorRepId) };
  }
  return {
    programDirectorRepId: clean(programDirectorRepId),
    directorRepId: clean(directorRepId),
  };
}

async function validateRepHierarchy(db, input = {}) {
  const subjectId = clean(input.repId);
  const roleId = clean(input.roleId || input.currentRoleId);
  const hierarchy = canonicalHierarchyForRole({ ...input, repId: subjectId, roleId });
  const pdId = hierarchy.programDirectorRepId;
  const directorId = hierarchy.directorRepId;
  if (!pdId || !directorId) throw new Error("Program Director and Regional Director are required");

  if (!isProgramDirectorRole(roleId) && !isDirectorRole(roleId) && [pdId, directorId].includes(subjectId)) {
    throw new Error("A non-leader rep cannot lead themselves");
  }
  if (isProgramDirectorRole(roleId) && directorId === subjectId) {
    throw new Error("A Program Director must report to an active Regional Director");
  }

  const [pdSnap, directorSnap] = await Promise.all([
    db.collection("reps").doc(pdId).get(),
    db.collection("reps").doc(directorId).get(),
  ]);
  if (!pdSnap.exists || pdSnap.data()?.active === false || clean(pdSnap.data()?.status) === "inactive") {
    throw new Error("Program Director is not active");
  }
  if (!directorSnap.exists || directorSnap.data()?.active === false || clean(directorSnap.data()?.status) === "inactive") {
    throw new Error("Regional Director is not active");
  }

  const pd = pdSnap.data() || {};
  const director = directorSnap.data() || {};
  if (!isProgramDirectorRole(pd.currentRoleId) && !isDirectorRole(pd.currentRoleId)) {
    throw new Error("Selected Program Director is not eligible");
  }
  if (!isDirectorRole(director.currentRoleId)) {
    throw new Error("Selected Regional Director is not eligible");
  }
  return { ...hierarchy, programDirector: pd, director };
}

module.exports = {
  PROGRAM_DIRECTOR_ROLE,
  DIRECTOR_ROLES,
  canonicalHierarchyForRole,
  isProgramDirectorRole,
  isDirectorRole,
  validateRepHierarchy,
};
