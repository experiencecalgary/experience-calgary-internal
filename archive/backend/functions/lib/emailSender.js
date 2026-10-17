"use strict";

const nodemailer = require("nodemailer");
const { BRAND } = require("./emailTheme");

function readSecretValue(secretOrString) {
  if (!secretOrString) return "";
  if (typeof secretOrString === "string") return secretOrString;
  if (typeof secretOrString.value === "function") return secretOrString.value();
  return "";
}

async function sendEmailStudioTest({
  to,
  subject,
  html,
  STAFF_MAIL_USER,
  STAFF_MAIL_APP_PASSWORD,
}) {
  const user = readSecretValue(STAFF_MAIL_USER);
  const pass = readSecretValue(STAFF_MAIL_APP_PASSWORD);

  if (!user || !pass) {
    throw new Error("Mailer secrets not configured.");
  }

  if (!to) {
    throw new Error("Missing recipient email.");
  }

  if (!subject) {
    throw new Error("Missing email subject.");
  }

  if (!html) {
    throw new Error("Missing email HTML.");
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass },
  });

  return transporter.sendMail({
    from: `"Experience Calgary" <${user}>`,
    to,
    replyTo: BRAND.replyTo,
    subject,
    html,
  });
}

module.exports = {
  sendEmailStudioTest,
};