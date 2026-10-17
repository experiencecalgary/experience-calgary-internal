"use strict";

const { onCall } = require("firebase-functions/v2/https");
const {
  createUpdateCommandEmailSettingsService,
} = require("../../lib/commandEmail/updateCommandEmailSettings");

function createUpdateCommandEmailSettingsCallable(deps = {}) {
  return onCall(
    {
      region: "us-central1",
      cors: true,
      timeoutSeconds: 60,
      memory: "256MiB",
    },
    createUpdateCommandEmailSettingsService(deps)
  );
}

module.exports = { createUpdateCommandEmailSettingsCallable };
