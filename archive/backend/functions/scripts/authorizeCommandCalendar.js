'use strict';

const http = require('node:http');
const { URL } = require('node:url');
const { google } = require('googleapis');

const clientId = String(process.env.COMMAND_CALENDAR_OAUTH_CLIENT_ID || '').trim();
const clientSecret = String(process.env.COMMAND_CALENDAR_OAUTH_CLIENT_SECRET || '').trim();
const redirectUri = String(process.env.COMMAND_CALENDAR_OAUTH_REDIRECT_URI || 'http://localhost:53682/oauth2callback').trim();
if (!clientId || !clientSecret) {
  console.error('Set COMMAND_CALENDAR_OAUTH_CLIENT_ID and COMMAND_CALENDAR_OAUTH_CLIENT_SECRET before running this script.');
  process.exit(1);
}

const oauth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
const scopes = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/meetings.space.settings',
  'https://www.googleapis.com/auth/meetings.space.readonly',
];
const authUrl = oauth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: scopes });
const redirect = new URL(redirectUri);

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, redirectUri);
  if (requestUrl.pathname !== redirect.pathname) { response.writeHead(404).end('Not found'); return; }
  const code = requestUrl.searchParams.get('code');
  if (!code) { response.writeHead(400).end(`Authorization failed: ${requestUrl.searchParams.get('error') || 'missing code'}`); return; }
  try {
    const { tokens } = await oauth.getToken(code);
    response.writeHead(200, { 'content-type': 'text/plain' }).end('Authorization complete. Return to the terminal.');
    console.log('\nNew COMMAND_CALENDAR_OAUTH_REFRESH_TOKEN:\n');
    console.log(tokens.refresh_token || '(Google did not return a refresh token; revoke the old grant and rerun.)');
    server.close();
  } catch (error) {
    response.writeHead(500).end('Token exchange failed. Return to the terminal.');
    console.error(error);
    server.close(() => process.exitCode = 1);
  }
});

server.listen(Number(redirect.port) || 80, redirect.hostname, () => {
  console.log(`\nOpen this URL and authorize curator@experiencecalgary.ca:\n\n${authUrl}\n`);
  console.log(`Waiting for Google at ${redirectUri}`);
});
