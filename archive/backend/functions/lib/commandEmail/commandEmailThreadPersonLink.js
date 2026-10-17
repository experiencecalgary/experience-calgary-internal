"use strict";

function buildThreadPersonLinkUpdate({
  personRef,
  personName,
  organizationRef = null,
  organizationName = "",
  actorRef,
  timestamp,
}) {
  return {
    personRef,
    personName,
    organizationRef,
    organizationName,
    organizationLinkSource: organizationRef ? "person" : null,
    linkSource: "manual",
    linkedAt: timestamp,
    linkedByRef: actorRef,
    autoLinkSuppressed: false,
    autoLinkSuppressedAt: null,
    autoLinkSuppressedByRef: null,
    updatedAt: timestamp,
  };
}

function buildConnectionPersonLinkUpdate({
  personRef,
  organizationRef = null,
}) {
  return { personRef, organizationRef };
}

module.exports = {
  buildThreadPersonLinkUpdate,
  buildConnectionPersonLinkUpdate,
};
