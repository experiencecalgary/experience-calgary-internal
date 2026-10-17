"use strict";

function normalizeIdentifier(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function canAssignCommandAction({
  actorUid,
  actorData = {},
  assigneeUid,
  assigneeData = {},
}) {
  const cleanActorUid = normalizeIdentifier(actorUid);
  const cleanAssigneeUid = normalizeIdentifier(assigneeUid);

  if (cleanActorUid && cleanActorUid === cleanAssigneeUid) {
    return true;
  }

  if (normalizeIdentifier(actorData.role).toLowerCase() === "platform_admin") {
    return assigneeData.active !== false &&
      normalizeIdentifier(assigneeData.userType).toLowerCase() === "rep";
  }

  const actorRepId = normalizeIdentifier(actorData.repId);
  if (!actorRepId) return false;

  return [
    assigneeData.programDirectorRepId,
    assigneeData.directorRepId,
  ].some((managerRepId) => normalizeIdentifier(managerRepId) === actorRepId);
}

module.exports = {
  normalizeIdentifier,
  canAssignCommandAction,
};
