"use strict";

const { onCall } = require("firebase-functions/v2/https");
const {
  createMarkCommandEmailThreadReadService,
} = require("../../lib/commandEmail/markCommandEmailThreadRead");

function createMarkCommandEmailThreadReadCallable(deps = {}) {
  return onCall(
    {
      region: "us-central1",
      cors: true,
      timeoutSeconds: 30,
      memory: "256MiB",
    },
    createMarkCommandEmailThreadReadService(deps)
  );
}

module.exports = {
  createMarkCommandEmailThreadReadCallable,
};
