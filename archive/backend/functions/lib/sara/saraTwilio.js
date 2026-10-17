'use strict';

const crypto = require('crypto');
const { defineSecret, defineString } = require('firebase-functions/params');
const { clean } = require('./saraCore');

const TWILIO_ACCOUNT_SID = defineSecret('TWILIO_ACCOUNT_SID');
const TWILIO_AUTH_TOKEN = defineSecret('TWILIO_AUTH_TOKEN');
const SARA_TWILIO_NUMBER = defineString('SARA_TWILIO_NUMBER', { default: '+15873172397' });
const SARA_TWILIO_STATUS_CALLBACK_URL = defineString('SARA_TWILIO_STATUS_CALLBACK_URL', { default: '' });
const twilioSecrets = [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN];
const configuredNumber = () => clean(SARA_TWILIO_NUMBER.value()) || '+15873172397';
function configuredStatusCallback() { const explicit=clean(SARA_TWILIO_STATUS_CALLBACK_URL.value()); if (explicit) return explicit; const project=clean(process.env.GCLOUD_PROJECT||process.env.GCP_PROJECT); return project?`https://us-central1-${project}.cloudfunctions.net/updateSaraSmsDelivery`:''; }

async function sendSms({ to, body, statusCallback }) {
  const sid = clean(TWILIO_ACCOUNT_SID.value()); const token = clean(TWILIO_AUTH_TOKEN.value());
  if (!sid || !token) throw new Error('Twilio secrets are not configured.');
  const form = new URLSearchParams({ To: to, From: configuredNumber(), Body: clean(body, 1500) });
  const callback=clean(statusCallback)||configuredStatusCallback(); if (callback) form.set('StatusCallback', callback);
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
    method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form,
  });
  const json = await response.json();
  if (!response.ok) throw new Error(`Twilio rejected the message: ${clean(json.message) || response.status}`);
  return json;
}
function validateSignature(req) {
  const token = clean(TWILIO_AUTH_TOKEN.value()); const provided = clean(req.get('x-twilio-signature'));
  if (!token || !provided) return false;
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  const fields = Object.keys(req.body || {}).sort().map(k => `${k}${req.body[k]}`).join('');
  const expected = crypto.createHmac('sha1', token).update(url + fields).digest('base64');
  const a = Buffer.from(provided); const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function configurationStatus() {
  return {
    accountSidConfigured: Boolean(clean(TWILIO_ACCOUNT_SID.value())),
    authTokenConfigured: Boolean(clean(TWILIO_AUTH_TOKEN.value())),
    senderNumberConfigured: Boolean(configuredNumber()),
    statusCallbackConfigured: Boolean(configuredStatusCallback()),
  };
}
module.exports = { twilioSecrets, configuredNumber, configuredStatusCallback, configurationStatus, sendSms, validateSignature };
