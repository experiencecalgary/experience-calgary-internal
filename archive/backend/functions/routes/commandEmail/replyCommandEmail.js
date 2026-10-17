"use strict";

const { onCall } = require("firebase-functions/v2/https");
const {
  createReplyCommandEmailService,
} = require("../../lib/commandEmail/replyCommandEmail");

function createReplyCommandEmailCallable(deps) {
  return onCall(
    {
      region: "us-central1",
      cors: true,
      secrets: [deps.SENDGRID_API_KEY],
      timeoutSeconds: 120,
      memory: "512MiB",
    },
    createReplyCommandEmailService(deps)
  );
}

module.exports = {
  createReplyCommandEmailCallable,
};
