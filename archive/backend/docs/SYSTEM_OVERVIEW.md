# System Overview

## Products in this repository

The repository supports the existing Experience Calgary application plus Experience Command, the internal CRM at `command.experiencecalgary.ca`.

Experience Command currently includes:

- People and Organizations
- EC Flow stages
- Actions and activity Connections
- Email threads and messages
- Search and paginated record listing
- Bulk People updates and archive/restore
- Command Library files and Exchanges
- CSV validation and import
- Team-access synchronization

## Experience Command stages

The canonical sales stages are `New`, `Opened`, `Engaged`, `Closing`, `Won`, and `Lost`. EC Flow displays only the active pipeline stages `Opened`, `Engaged`, and `Closing`; `New`, `Won`, and `Lost` remain valid CRM stages but are excluded from the active Flow board.

## EC Flow backend

EC Flow uses a dedicated `listCommandFlowPage` callable and does not alter the general People or Organization list functions. People and Organizations have separate Flow pages but share the callable through `recordType`.

The `commandFlowActionMetadata` trigger denormalizes each record's earliest open Action and open-Action count. This lets the Flow callable return the three active columns, overdue totals, and no-Action totals without querying Actions separately for every visible card.

Existing bulk update callables remain the single update pathway for stage, assignment, archive, and optional estimated value changes. A Flow widget may send a one-record list; no Flow-specific write callable is required.

## Request flow

1. A signed-in FlutterFlow user calls a wrapper/custom action.
2. The wrapper calls a Gen 2 callable in `us-central1`.
3. The function authenticates the Firebase user and requires a `users/{uid}` record with `userType == "rep"`.
4. The service validates input, permissions, and related document paths.
5. Firestore records are written with ownership, viewer, and team-access metadata.
6. Trigger functions maintain access metadata, Algolia indexes, and Connections where applicable.

## Action creation

All new Actions use the shared `createCommandAction` callable. FlutterFlow passes assignee, Person, and Organization document paths as Strings; the backend resolves them into real DocumentReferences and creates the complete Action in one write.

- Person Actions require a Person path and omit Organization fields.
- Organization Actions require an Organization path and omit Person fields.
- General Actions omit both optional relationships.
- Every Action requires an active representative assignee.
- The same callable is reused from the Actions, Person, and Organization pages.

The access-sync trigger maintains ownership and visibility metadata after creation. A separate activity trigger creates the corresponding `commandConnections` record.

## Effective entry point

`functions/entrypoint.js` loads all legacy exports from `functions/index.js`, adds isolated Command exports, and intentionally overrides legacy search behavior with the current search/listing module.

## Contact, ExMail, and Action alignment

- Contact email ownership is maintained by `commandEmailIdentityIndex`.
- A Person may have zero or one current Organization; `commandPeople.organizationRef` is authoritative.
- Automatic inbound matching uses verified normalized email identity.
- Manual `linkCommandEmailThreadToPerson` is association-only: it links a conversation to a Person without changing contact email addresses or Person/Organization relationships.
- Action creation permits assignment only to the authenticated representative or an active representative whose `programDirectorRepId` or `directorRepId` matches the actor's `repId`. The callable enforces this independently of FlutterFlow.
