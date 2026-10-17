'use strict';

const { onCall } = require('firebase-functions/v2/https');
const { defineSecret, defineString } = require('firebase-functions/params');
const agreements = require('../../lib/command/commandAgreements');

const STAFF_MAIL_USER = defineSecret('STAFF_MAIL_USER');
const STAFF_MAIL_APP_PASSWORD = defineSecret('STAFF_MAIL_APP_PASSWORD');
const COMMAND_AGREEMENT_SIGNING_BASE_URL = defineString('COMMAND_AGREEMENT_SIGNING_BASE_URL', {
  default: '',
  description: 'HTTPS URL of the public FlutterFlow agreement signing page. The signing token is appended as ?token=...',
});

const standard = (handler) => onCall({ region:'us-central1', cors:true, timeoutSeconds:120, memory:'512MiB' }, handler);
const mail = (handler) => onCall({ region:'us-central1', cors:true, timeoutSeconds:120, memory:'512MiB', secrets:[STAFF_MAIL_USER, STAFF_MAIL_APP_PASSWORD] }, (request) => handler(request, {
  mailUser:STAFF_MAIL_USER,
  mailPassword:STAFF_MAIL_APP_PASSWORD,
  signingBaseUrl:COMMAND_AGREEMENT_SIGNING_BASE_URL.value(),
}));
const pdfMail = (handler) => onCall({ region:'us-central1', cors:true, timeoutSeconds:180, memory:'1GiB', secrets:[STAFF_MAIL_USER, STAFF_MAIL_APP_PASSWORD] }, (request) => handler(request, {
  mailUser:STAFF_MAIL_USER,
  mailPassword:STAFF_MAIL_APP_PASSWORD,
  signingBaseUrl:COMMAND_AGREEMENT_SIGNING_BASE_URL.value(),
}));

exports.saveCommandAgreementTemplate = standard(agreements.saveCommandAgreementTemplateService);
exports.listCommandAgreementTemplates = standard(agreements.listCommandAgreementTemplatesService);
exports.previewCommandAgreement = standard(agreements.previewCommandAgreementService);
exports.createAndSendCommandAgreement = mail(agreements.createAndSendCommandAgreementService);
exports.getPublicCommandAgreement = standard(agreements.getPublicCommandAgreementService);
exports.signCommandAgreement = pdfMail(agreements.signCommandAgreementService);
exports.cancelCommandAgreement = standard(agreements.cancelCommandAgreementService);
exports.resendCommandAgreement = mail(agreements.resendCommandAgreementService);
exports.getCommandAgreementPdfDownload = standard(agreements.getCommandAgreementPdfDownloadService);
