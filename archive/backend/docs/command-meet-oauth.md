# Command Center Google Meet authorization

The Command Center uses the existing `curator@experiencecalgary.ca` Calendar integration. Automatic transcription, smart notes, attendance, and artifact retrieval require the same OAuth grant to include Google Meet scopes.

## One-time setup

1. Enable the **Google Meet REST API** in the Firebase project's Google Cloud project.
2. In the existing OAuth web client, add `http://localhost:53682/oauth2callback` as an authorized redirect URI.
3. From `functions/`, set the client ID and secret in the terminal environment, then run `npm run authorize:command-calendar`.
4. Sign in as `curator@experiencecalgary.ca`, approve the Calendar and Meet permissions, and copy the new refresh token printed in the terminal.
5. Replace the Firebase secret with `firebase functions:secrets:set COMMAND_CALENDAR_OAUTH_REFRESH_TOKEN`.
6. Deploy the Meeting functions.

The authorization script never writes the refresh token to the repository. In Codespaces, make port `53682` temporarily public or use an equivalent forwarded callback URL registered in the OAuth client.

Google Workspace must also permit transcription and Gemini meeting notes for this account. If either feature is unavailable for the Workspace edition or meeting, Meeting creation still succeeds and Command Center records a configuration warning for review.
