# Cloud Functions

The effective export list is assembled in `functions/entrypoint.js`. All Command callable functions require authentication unless specifically documented as public HTTP.

## People and Organizations

- `validateCommandPerson`, `createCommandPerson`, `updateCommandPerson`
- `validateCommandOrganization`, `createCommandOrganization`, `updateCommandOrganization`
- `archiveCommandPerson`, `restoreCommandPerson`
- `archiveCommandOrganization`, `restoreCommandOrganization`
- `bulkUpdateCommandPeople`, `bulkUpdateCommandOrganizations`

## Actions

- `createCommandAction`

`createCommandAction` is the production creation path for Actions from the Actions page, Person page, and Organization page. It accepts:

- `title`
- `description`
- `actionType`
- `priority` — `Low`, `Medium`, or `High`
- `dueAt`
- `relatedType` — `Person`, `Organization`, or `General`
- `assignedToRefPath` — required `users/{uid}` path
- `personRefPath` — required only for Person Actions; otherwise `''`
- `organizationRefPath` — required only for Organization Actions; otherwise `''`

The callable requires Firebase authentication and Command access, validates path shape and related documents, requires an active representative assignee, reads cached names from Firestore, calculates `dueDateKey` in `America/Edmonton`, and creates the complete Action in one write. It returns:

```json
{
  "ok": true,
  "created": true,
  "actionId": "documentId",
  "actionPath": "commandActions/documentId"
}
```

Person Actions save only `personRef` and `personName`; Organization Actions save only `organizationRef` and `organizationName`; General Actions omit both relationship pairs.

## Listing, search, and access

- `listCommandRecordsPage`
- `searchCommandRecords` (current Algolia-backed override)
- `configureCommandSearchIndexes`
- `repairCommandRecordAccess`
- scheduled `syncCommandUserTeamAccess`
- Firestore access-sync and Algolia-sync triggers

Supported listing record types are `people`, `organizations`, `actions`, `connections`, `emailThreads`, `libraryFiles`, and nested `emailMessages`. Text search within the paginated listing is supported for People and Organizations. Both support stage, assigned-representative, archived, name, created, updated, stage, and estimated-value listing controls.

## CSV

- `validateCommandCsvImport`
- `commitCommandCsvImport`

Both use 120-second timeouts and 512 MiB memory.

## Email

- `sendCommandEmail`
- `replyCommandEmail`
- `receiveCommandEmail` (HTTP SendGrid Inbound Parse)
- `receiveCommandEmailEvents` (HTTP SendGrid Event Webhook)
- `markCommandEmailThreadRead`
- `linkCommandEmailThreadToPerson`
- `linkCommandEmailThreadToOrganization`
- `unlinkCommandEmailThread`

## Command Library and Exchanges

- Library: `createCommandLibraryFile`, `archiveCommandLibraryFile`, `restoreCommandLibraryFile`
- Exchange lifecycle: `createCommandExchange`, `confirmCommandExchange`, `cancelCommandExchange`, scheduled `expireCommandExchanges`
- Items/access: `createCommandExchangeItem`, `getCommandExchangeItemAccess`
- Public HTTP: `getPublicCommandExchange`, `preparePublicCommandExchangeUpload`, `submitPublicCommandExchange`, `getPublicCommandExchangeItemAccess`

Signed file URLs expire after 900 seconds.

## Daily overview and Call Leads

- `getCommandDailyOverview` authenticates the requester, resolves Me plus active direct team representatives, enforces the selected representative server-side, converts a local calendar day to UTC, and aggregates authoritative `commandConnections` events by the performing actor. It accepts `selectedRepUid`, `localDate`, and `timeZone`.
- `listCommandCallQueue` applies queue mode, stages, team assignment, search, calling safeguards, action state, value threshold, and ordering before pagination. Supported modes are Priority Calls, New Leads, Follow-ups Due, Reconnect, Stage Campaign, and Custom Queue.
- `logCommandCallOutcome` retains idempotent `clientRequestId` protection and returns the saved call, Connection, follow-up, applied stage, queue-removal signal, and updated record summary only after the write succeeds.

## Connections triggers

- `commandActionCreated`
- `commandActionCompleted`
- `commandMeetingCreated`
- `commandNoteCreated`
- `commandCallCreated`

`commandActionCreated` creates a separate `commandConnections` activity record after an Action is created. It does not modify the Action document.

## Administrative test data

- `seedCommandPeopleTestData`
- `deleteCommandPeopleTestData`

These are restricted in code to the configured Command admin UID and manage a fixed 100-record batch.

## Existing application functions

`functions/index.js` also exports the Express `api`, scheduled rollups/statistics/payroll/promotion jobs, notification functions, and security alerts. Preserve these exports when changing Command modules.

## Current contact and ExMail callables

The People and Organizations surface also includes:

- `setCommandPersonOrganization`
- `backfillCommandContactIdentity`

The Email surface also includes:

- `listCommandEmailThreadsPage`
- `markCommandEmailThreadUnread`
- `updateCommandEmailSettings`

`linkCommandEmailThreadToPerson` is association-only. It writes the selected Person reference/name and link audit metadata to the thread and propagates only `personRef` to existing thread Connections. It does not add the sender address to the Person, write an identity claim, or change the thread's Organization.

`createCommandAction` requires an active representative assignee and additionally authorizes the assignee as either the authenticated actor or a representative whose `programDirectorRepId` or `directorRepId` matches the actor's `repId`.


## VIP Opportunity Revival

- `createCommandRevivalCampaign`, `updateCommandRevivalCampaign`
- `previewCommandRevivalImport`, `commitCommandRevivalImport`
- `analyzeCommandRevivalOpportunities`, `reviewCommandRevivalOpportunity`
- `activateCommandRevivalCampaign`, `getCommandRevivalCampaignSummary`

The import preview and analysis functions bind the `OPENAI_API_KEY` Firebase secret. Meetings continue to use `commandActions` and accept optional Revival campaign/opportunity reference paths. See [VIP_OPPORTUNITY_REVIVAL.md](VIP_OPPORTUNITY_REVIVAL.md).
