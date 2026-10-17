# Experience Command Firestore Schema

## Core collections

- `commandPeople`
- `commandOrganizations`
- `commandActions`
- `commandMeetings`
- `commandNotes`
- `commandCalls`
- `commandConnections`
- `commandEmailThreads`
- `commandEmailThreads/{threadId}/messages`
- `commandExchanges`
- `commandExchangeItems`
- `commandLibraryFiles`
- `commandSettings`

## Team access fields

Records that are visible to leadership should consistently include:

- `ownerUid`
- `ownerRef`
- `ownerName`
- `teamRepIds`
- `viewerUids` where UID-based access is required

## Audit fields

Protected records should use:

- `createdAt`
- `createdByRef`
- `updatedAt`
- `updatedByRef`
- archive/restore timestamps and actor references when applicable

## Exchange settings document

Path: `commandSettings/exchange`

Recommended fields:

- `exchangeLinkExpiryHours: 48`
- `maxFilesPerExchange: 10`
- `maxFileSizeMb: 20`
- `maxTotalExchangeSizeMb: 75`

## Important ownership note

Firestore rules and indexes are deployed from FlutterFlow. Repository copies are informational only.
