"use strict";

const { onCall } = require("firebase-functions/v2/https");
const {
  createSendCommandEmailService,
} = require("../../lib/commandEmail/sendCommandEmail");

function createSendCommandEmailCallable(deps) {
  return onCall(
    {
      region: "us-central1",
      cors: true,
      secrets: [deps.SENDGRID_API_KEY],
      timeoutSeconds: 120,
      memory: "512MiB",
    },
    createSendCommandEmailService(deps)
  );
}

module.exports = {
  createSendCommandEmailCallable,
};
