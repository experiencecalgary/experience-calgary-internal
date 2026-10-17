#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const readline = require('node:readline');

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'experience-app-ce493';
const REGION = process.env.FIREBASE_FUNCTION_REGION || 'us-central1';
const FUNCTION_NAME = 'repairCommandLeadFlowSummaries';
const MAX_PAGES = 10000;

function firebaseJson(args) {
  try {
    const output = execFileSync('firebase', [...args, '--project', PROJECT_ID, '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(output);
  } catch (error) {
    const details = error.stderr?.toString().trim() || error.message;
    throw new Error(`Firebase CLI command failed: ${details}`);
  }
}

function discoverWebApiKey() {
  if (process.env.FIREBASE_WEB_API_KEY) return process.env.FIREBASE_WEB_API_KEY;
  const listed = firebaseJson(['apps:list', 'WEB']);
  const apps = Array.isArray(listed.result) ? listed.result : [];
  const appId = apps[0]?.appId;
  if (!appId) throw new Error('No Firebase Web app was found. Set FIREBASE_WEB_API_KEY and retry.');
  const config = firebaseJson(['apps:sdkconfig', 'WEB', appId]);
  const apiKey = config.result?.sdkConfig?.apiKey || config.result?.apiKey;
  if (!apiKey) throw new Error('Could not read the Firebase Web API key. Set FIREBASE_WEB_API_KEY and retry.');
  return apiKey;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); }));
}

function askSecret(question) {
  if (!process.stdin.isTTY) throw new Error('Run this script in an interactive terminal.');
  return new Promise((resolve, reject) => {
    let value = '';
    process.stdout.write(question);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      process.stdout.write('\n');
    };
    const onData = (key) => {
      if (key === '\u0003') { finish(); reject(new Error('Cancelled.')); return; }
      if (key === '\r' || key === '\n') { finish(); resolve(value); return; }
      if (key === '\u007f' || key === '\b') { value = value.slice(0, -1); return; }
      value += key;
    };
    process.stdin.on('data', onData);
  });
}

async function readJson(response) {
  const body = await response.text();
  try { return body ? JSON.parse(body) : {}; }
  catch { throw new Error(`Unexpected non-JSON response (${response.status}).`); }
}

async function signIn(apiKey, email, password) {
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const body = await readJson(response);
  if (!response.ok || !body.idToken) throw new Error(body.error?.message || 'Firebase sign-in failed.');
  return body.idToken;
}

async function callRepair(idToken, afterId) {
  const endpoint = `https://${REGION}-${PROJECT_ID}.cloudfunctions.net/${FUNCTION_NAME}`;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ data: { afterId } }),
    });
    const body = await readJson(response);
    if (response.ok && !body.error) return body.result ?? body.data;
    const message = body.error?.message || `Repair call failed (${response.status}).`;
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 4) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 750 * (2 ** (attempt - 1))));
  }
  throw new Error('Repair call failed.');
}

async function main() {
  console.log(`Project: ${PROJECT_ID}`);
  console.log('This recalculates existing Lead next-action summaries. It does not create, delete, reassign, move, win/loss, or archive Leads.');
  const confirmation = await ask('Type REPAIR to continue: ');
  if (confirmation !== 'REPAIR') throw new Error('Cancelled: confirmation did not match.');

  const email = await ask('Platform-admin email: ');
  const password = await askSecret('Password (hidden): ');
  const apiKey = discoverWebApiKey();
  const idToken = await signIn(apiKey, email, password);
  let afterId = '';
  let total = 0;
  const incomplete = new Set();

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const result = await callRepair(idToken, afterId);
    if (!result?.ok || !Number.isInteger(result.processed)) throw new Error('Repair returned an invalid result.');
    total += result.processed;
    for (const path of result.incompleteLeadPaths || []) incomplete.add(path);
    console.log(`Page ${page}: ${result.processed} processed (${total} total), ${incomplete.size} incomplete.`);
    if (!result.hasMore) {
      console.log(`\nRepair complete: ${total} Leads processed; ${incomplete.size} incomplete.`);
      if (incomplete.size) console.log([...incomplete].join('\n'));
      return;
    }
    if (!result.afterId || result.afterId === afterId) throw new Error('Repair continuation did not advance; stopped safely.');
    afterId = result.afterId;
  }
  throw new Error(`Stopped after ${MAX_PAGES} pages to prevent an unintended endless run.`);
}

main().catch((error) => {
  console.error(`\nERROR: ${error.message}`);
  process.exitCode = 1;
});
