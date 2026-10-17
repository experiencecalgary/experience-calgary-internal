# Experience Command Cloud Function API

## Existing

### People
- `validateCommandPerson`
- `createCommandPerson`
- `updateCommandPerson`

### Organizations
- `validateCommandOrganization`
- `createCommandOrganization`
- `updateCommandOrganization`

### ExMail
- `sendCommandEmail`
- `replyCommandEmail`
- `receiveCommandEmail`
- `receiveCommandEmailEvents`
- `markCommandEmailThreadRead`
- `linkCommandEmailThreadToPerson`

## Planned additions

### People and organizations
- `archiveCommandPerson`
- `restoreCommandPerson`
- `archiveCommandOrganization`
- `restoreCommandOrganization`

### ExMail
- `linkCommandEmailThreadToOrganization`
- `unlinkCommandEmailThread`

### EC Exchange — authenticated
- `createCommandExchange`
- `confirmCommandExchange`
- `cancelCommandExchange`
- `createCommandLibraryFile`
- `archiveCommandLibraryFile`
- `restoreCommandLibraryFile`
- `getCommandExchangeItemAccess`

### EC Exchange — public HTTP
- `getPublicCommandExchange`
- `preparePublicCommandExchangeUpload`
- `submitPublicCommandExchange`
- `getPublicCommandExchangeItemAccess`

### Search and import
- `searchCommandRecords`
- `validateCommandCsvImport`
- `commitCommandCsvImport`

### Background
- `syncCommandUserTeamAccess`
- `expireCommandExchanges`

## Standard callable response

```json
{
  "success": true,
  "message": "Operation completed.",
  "data": {}
}
```

Errors use Firebase `HttpsError` codes. Public HTTP endpoints return standard HTTP status codes and JSON bodies.
