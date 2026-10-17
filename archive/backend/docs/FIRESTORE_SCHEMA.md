# Firestore Schema

This document lists the active Command collections and stable fields used across services. Optional fields vary by feature.

## Core records

### `commandPeople`

Identity/contact: `firstName`, `lastName`, `fullName`, `email`, `emailNormalized`, `phone`, `phoneNormalized`.

CRM: `organizationRef`, `organizationName`, `stage`, `estimatedValue`, `archived`.

Access/audit: `ownerUid`, `ownerRef`, `ownerName`, `assignedToUid`, `assignedToRef`, `assignedToName`, `viewerUids`, `teamRepIds`, `createdAt`, `createdByRef`, `updatedAt`, `updatedByRef`.

### `commandOrganizations`

Identity/contact: `organization` (primary name in current services), `name` (supported in some compatibility paths), `email`, `phone`, `phoneNormalized`, `website`, `industry`, `city`, `province`.

CRM: `stage`, `estimatedValue`, and `archived`.

Access/audit fields parallel People: owner, assignee, `viewerUids`, `teamRepIds`, created/updated timestamps, and actor references.

### `commandActions`

Core fields:

- `title` — required String, maximum 200 characters
- `description` — String, maximum 5,000 characters
- `actionType` — required String
- `status` — `open` on creation
- `priority` — `Low`, `Medium`, or `High`
- `dueAt` — Firestore Timestamp
- `dueDateKey` — Edmonton business-date key in `YYYY-MM-DD` format
- `relatedType` — `Person`, `Organization`, or `General`

Relationship fields are mutually exclusive on creation:

| `relatedType` | Fields stored |
|---|---|
| `Person` | `personRef` (DocumentReference to `commandPeople`) and `personName` |
| `Organization` | `organizationRef` (DocumentReference to `commandOrganizations`) and `organizationName` |
| `General` | Neither Person nor Organization relationship fields |

Do not store document paths in `personRef`, `organizationRef`, or `assignedToRef`; those final fields remain Firestore DocumentReferences. FlutterFlow passes path strings only as callable inputs.

Access/audit fields: `ownerRef`, `ownerUid`, `ownerName`, `assignedToRef`, `assignedToUid`, `assignedToName`, `viewerUids`, `teamRepIds`, `createdAt`, `createdByRef`, `updatedAt`, and `updatedByRef`. `completedAt` is used when an Action is completed.

### `commandConnections`

Activity fields: `type`, `summary`, `body`, `sourceRef`, related record references/names, ownership/access metadata, and `createdAt`.

Activity triggers currently create Connections for actions created/completed, meetings, notes, and calls.

## Email

### `commandEmailThreads`

Includes subject, related People/Organization links, owner/viewer access, unread state, latest-message metadata, timestamps, and archive state.

### `commandEmailThreads/{threadId}/emailMessages/{messageId}`

Includes direction, sender/recipient fields, text/HTML bodies, attachments, SendGrid/message identifiers, delivery status, and timestamps.

## Files and Exchanges

- `commandLibraryFiles`
- `commandExchanges`
- `commandExchangeItems`
- `commandSettings/exchange`

Default Exchange limits in code are 10 files, 20 MB per file, and 75 MB total unless bounded settings override them.

## Supporting collections

- `commandMeetings`
- `commandNotes`
- `commandCalls`
- `users`

The `users` document supplies `repId`, `programDirectorRepId`, `directorRepId`, identity fields, active status, and Command eligibility through `userType == "rep"`.

## Reference convention

Callable APIs normally pass reference paths as strings such as `users/{uid}` or `commandOrganizations/{id}`. The backend validates collection and path shape before resolving a Firestore DocumentReference.

## Contact identity and ExMail supporting collections

- `commandEmailIdentityIndex/{sha256(normalizedEmail)}` owns normalized Person and Organization email claims.
- `commandCsvImports/{importBatchId}` records idempotent CSV commit results.
- `commandEmailAddresses/{uid}` and `commandEmailAliases/{localPart}` must remain synchronized with `users.commandEmailAddress`.
- People and Organizations may store `emailNormalized`, `additionalEmails`, and `additionalEmailsNormalized`.
- A Person's current Organization is stored in `commandPeople.organizationRef`; the Person is the relationship source of truth.

Inbound thread address meanings:

- `senderEmail`: external correspondent's normalized/display email used for identity matching and Connect-to-Person UI.
- `senderAddress` and `replyAddress`: internal Command mailbox addresses.
- `toAddress`: retained correspondent-address field used by the existing thread model.
- `personRef` and `personName`: optional manual or automatic Person association.
- `organizationRef` and `organizationName`: optional Organization association, preserved when a Person is manually linked.


## VIP Opportunity Revival

- `commandRevivalCampaigns` stores campaign agreements, team access, pricing locks, status, and cached counts.
- `commandRevivalOpportunities` links one campaign to one existing/new Person and stores campaign-specific history, qualification, Revival Brief, delivery progress, Meeting reference, and outcome.

Campaign membership is represented by `campaignRef`; it does not overwrite the single existing `leadListId` on People. Meetings are stored as `commandActions` with `actionType == "meeting"` and optional `revivalCampaignRef` / `revivalOpportunityRef`.
