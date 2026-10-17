"use strict";

const { onCall } = require("firebase-functions/v2/https");
const {
  createLinkCommandEmailThreadToPersonService,
} = require("../../lib/commandEmail/linkCommandEmailThreadToPerson");

function createLinkCommandEmailThreadToPersonCallable(deps = {}) {
  return onCall(
    {
      region: "us-central1",
      cors: true,
      timeoutSeconds: 60,
      memory: "256MiB",
    },
    createLinkCommandEmailThreadToPersonService(deps)
  );
}

module.exports = {
  createLinkCommandEmailThreadToPersonCallable,
};
