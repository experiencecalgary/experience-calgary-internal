"use strict";

const { onCall } = require("firebase-functions/v2/https");
const {
  createMarkCommandEmailThreadUnreadService,
} = require("../../lib/commandEmail/markCommandEmailThreadUnread");

function createMarkCommandEmailThreadUnreadCallable(deps = {}) {
  return onCall(
    {
      region: "us-central1",
      cors: true,
      timeoutSeconds: 30,
      memory: "256MiB",
    },
    createMarkCommandEmailThreadUnreadService(deps)
  );
}

module.exports = {
  createMarkCommandEmailThreadUnreadCallable,
};
