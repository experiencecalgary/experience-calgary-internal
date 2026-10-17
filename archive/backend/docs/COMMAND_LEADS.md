# Experience Command Leads

`commandLeads` is the sales-opportunity layer for Experience Command. People and Organizations remain the master records for real individuals and companies. This foundation is additive: it does not migrate, delete, or rewrite existing records.

## Relationship model

- `leadType == person` requires `subjectPersonRef`. `subjectOrganizationRef` is optional context.
- `leadType == organization` requires `subjectOrganizationRef`. People can be attached through `connectedPersonRefs`.
- Either Lead type may contain additional connected People.
- `primaryContactRef`, when present, must also be represented in `connectedPersonRefs`.
- Type conversion is performed through `convertCommandLeadType`; it preserves the Lead document and writes a `lead_type_converted` Connection containing the previous and new subjects.

## Stable fields

Identity and relationships:

- `displayName`, `displayNameNormalized`, `leadType`
- `subjectPersonRef`, `subjectPersonName`
- `subjectOrganizationRef`, `subjectOrganizationName`
- `primaryContactRef`, `primaryContactName`
- `connectedPersonRefs`, `connectedPersonNames`

Pipeline:

- `stage`: `New`, `Opened`, `Engaged`, `Closing`, `Won`, or `Lost`
- `status`: `active`, `won`, `lost`, or `archived`
- `archived`
- `leadListId`, `leadListName`, `source`

Working summaries reserved for lifecycle integration:

- `nextActionRef`, `nextActionTitle`, `nextActionType`, `nextActionAt`
- `lastActivityAt`, `lastActivityType`

Outcome:

- `wonAt`, `lostAt`, `lostReason`, `closedAt`, `closedByRef`
- `archivedAt`, `archivedByRef`, `statusBeforeArchive`

Access and audit fields follow existing Command conventions: owner, assignee, `viewerUids`, `teamRepIds`, created/updated timestamps, and actor references.

## Callables

- `createCommandLead`
- `updateCommandLead`
- `getCommandLead`
- `listCommandLeadsPage`
- `searchCommandLeads`
- `assignCommandLead`
- `setCommandLeadContacts`
- `convertCommandLeadType`
- `closeCommandLead`
- `archiveCommandLead`
- `restoreCommandLead`

Every callable requires authenticated Command access. Platform administrators have global visibility. Regular representatives are scoped through owner, assignee, viewer, and team metadata.

## Activity history

Lead creation, assignment, stage movement, contact changes, type conversion, closing, archive, and restore operations write structured records to `commandConnections`. These records include `leadRef` while retaining applicable Person and Organization context.

## Deliberately deferred

- Existing Person/Organization pipeline migration
- Action, Call, Meeting, Agreement, and ExMail `leadRef` integration
- FlutterFlow UI changes
- Firestore Rules and index deployment
- AI evaluation and recommendation logic

