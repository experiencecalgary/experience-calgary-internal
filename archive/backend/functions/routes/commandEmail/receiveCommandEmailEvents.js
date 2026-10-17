"use strict";

const { onRequest } = require("firebase-functions/v2/https");
const {
  createReceiveCommandEmailEventsService,
} = require("../../lib/commandEmail/receiveCommandEmailEvents");

function createReceiveCommandEmailEventsWebhook(deps) {
  return onRequest(
    {
      region: "us-central1",
      cors: false,
      secrets: [deps.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY],
      timeoutSeconds: 120,
      memory: "512MiB",
    },
    createReceiveCommandEmailEventsService(deps)
  );
}

module.exports = {
  createReceiveCommandEmailEventsWebhook,
};
