# Architecture

| Layer | Responsibility |
|---|---|
| FlutterFlow | Web/app UI, page state, client queries, and custom-action wrappers |
| Firebase Auth | User identity |
| Cloud Functions | Validation, authorization, integrations, workflows, and protected writes |
| Firestore | Application and CRM records |
| Firebase Storage | Files, recruiting media, email attachments, Library, and Exchange objects |
| SendGrid | Command outbound email, inbound parsing, and delivery events |
| Algolia | Command search and People search pagination |
| GitHub | Backend source, documentation, review, and deployment history |

## Function assembly

```text
functions/package.json
  -> functions/entrypoint.js
     -> functions/index.js (existing application)
     -> routes/command/* (Experience Command)
     -> routes/commandEmail/* (Command email)
```

Most functions use Gen 2 and `us-central1`. Scheduled jobs that depend on business dates use `America/Edmonton`.

## Protected Action creation

Actions are created through one shared backend path:

```text
FlutterFlow form
  -> callCreateCommandAction wrapper
  -> createCommandAction callable
  -> complete commandActions document
  -> commandActionCreated creates a separate Connection
```

The client supplies reference paths as Strings. The callable validates and resolves them into Firestore DocumentReferences, reads authoritative related names, validates the assignee, and creates the complete Action in one write. This replaces the former Create Document followed by Update Document pattern and avoids client path-to-reference conversion failures.

The same callable supports Actions-page, Person-page, and Organization-page creation. `relatedType` controls which optional relationship is saved; General Actions save neither Person nor Organization relationship fields.

## Access metadata

Command records use combinations of:

- `ownerUid` and `ownerRef`
- `assignedToUid` and `assignedToRef`
- `viewerUids`
- `teamRepIds`

`createCommandAction` calculates initial Action access metadata before creation. `commandActionAccessSync` continues to recalculate access metadata when ownership or assignment changes. It does not choose or overwrite `relatedType`, `personRef`, `personName`, `organizationRef`, or `organizationName`.

Team-visible listing normally uses the current user's `repId` against `teamRepIds`, with UID-based fallback where supported.

## Manual ExMail association boundary

Automatic inbound identity resolution and manual conversation association are separate operations. Inbound processing may match an existing normalized contact identity. A user-triggered `linkCommandEmailThreadToPerson` call only writes the Person association and link audit metadata to the thread, plus the Person reference on existing thread activity Connections. It preserves Organization fields and never mutates a Person's primary/additional email fields or `commandEmailIdentityIndex`.

## Action assignment boundary

FlutterFlow filters the assignee picker for usability, while `createCommandAction` independently enforces the same authorization rule. The actor may assign to themself or to an active representative whose `programDirectorRepId` or `directorRepId` equals the actor's `repId`.
