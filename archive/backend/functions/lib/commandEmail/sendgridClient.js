"use strict";

const sgMail = require("@sendgrid/mail");

function readSecret(secret) {
  if (!secret) return "";
  if (typeof secret === "string") return secret.trim();
  if (typeof secret.value === "function") return String(secret.value() || "").trim();
  return "";
}

async function sendWithSendGrid({ apiKeySecret, message }) {
  const apiKey = readSecret(apiKeySecret);
  if (!apiKey) {
    throw new Error("SENDGRID_API_KEY is not available to this function.");
  }

  sgMail.setApiKey(apiKey);
  const [response] = await sgMail.send(message);
  return {
    statusCode: Number(response?.statusCode || 0),
    messageId:
      response?.headers?.["x-message-id"] ||
      response?.headers?.["X-Message-Id"] ||
      "",
  };
}

module.exports = {
  sendWithSendGrid,
};
