"use strict";

const { onRequest } = require("firebase-functions/v2/https");
const {
  createReceiveCommandEmailService,
} = require("../../lib/commandEmail/receiveCommandEmail");

function createReceiveCommandEmailWebhook(deps) {
  return onRequest(
    {
      region: "us-central1",
      cors: false,
      secrets: [deps.SENDGRID_INBOUND_TOKEN],
      timeoutSeconds: 120,
      memory: "512MiB",
    },
    createReceiveCommandEmailService(deps)
  );
}

module.exports = {
  createReceiveCommandEmailWebhook,
};
