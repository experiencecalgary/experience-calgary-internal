"use strict";

const { onCall } = require("firebase-functions/v2/https");
const {
  createGetCommandEmailAttachmentDownloadService,
} = require("../../lib/commandEmail/getCommandEmailAttachmentDownload");

function createGetCommandEmailAttachmentDownloadCallable() {
  return onCall(
    {
      region: "us-central1",
      cors: true,
      timeoutSeconds: 60,
      memory: "256MiB",
    },
    createGetCommandEmailAttachmentDownloadService()
  );
}

module.exports = { createGetCommandEmailAttachmentDownloadCallable };
