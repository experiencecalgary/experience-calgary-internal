# Experience Command Search and Pagination

## Architecture

Experience Command uses Firestore for normal lists, filters, sorting, totals, and cursor pagination. Algolia provides global search across People, Organizations, Actions, Connections, ExMail threads, ExMail messages, and Library files.

FlutterFlow calls the Command callable functions for validated business writes. Firestore remains the source of truth, and Firestore triggers update Algolia automatically.

## Algolia indexes

- `command_people`
- `command_organizations`
- `command_actions`
- `command_connections`
- `command_email_threads`
- `command_email_messages`
- `command_library_files`

Firestore remains the source of truth.

## Required Firebase secrets

- `ALGOLIA_APP_ID`
- `ALGOLIA_ADMIN_API_KEY`

Only Algolia-backed functions bind these secrets.

## Global search

Callable: `searchCommandRecords`

Input:

```json
{
  "query": "westjet",
  "types": ["people", "organizations", "actions"],
  "limitPerType": 5
}
```

`types` is optional. Search text must contain 2 to 100 characters. Results are grouped by record type and include each result's Firestore path.

Recommended FlutterFlow behavior is a shared header search with a 2-character minimum and a 400–500 ms debounce.

## Automatic synchronization

The following Firestore locations synchronize automatically:

- `commandPeople/{recordId}`
- `commandOrganizations/{recordId}`
- `commandActions/{recordId}`
- `commandConnections/{recordId}`
- `commandEmailThreads/{recordId}`
- `commandEmailThreads/{threadId}/commandEmailMessages/{messageId}`
- `commandLibraryFiles/{recordId}`

Create and update events replace the Algolia object. Firestore deletion removes it. Email messages inherit access fields from their parent thread when indexed.

No backfill callable is included because the current test records will be deleted before production use.

## Configure indexes

Callable: `configureCommandSearchIndexes`

Call it once after deployment while authenticated with Experience Command access. It configures searchable attributes, filterable attributes, and ranking. Omitting `types` configures every supported index.

## Paginated lists

Callable: `listCommandRecordsPage`

Supported types:

- `people`
- `organizations`
- `actions`
- `connections`
- `emailThreads`
- `emailMessages`
- `libraryFiles`

People example:

```json
{
  "recordType": "people",
  "pageSize": 25,
  "pageToken": "",
  "searchQuery": "westjet",
  "stage": "Proposal",
  "assignedToRefPath": "users/FIREBASE_UID",
  "archived": false,
  "sortBy": "updated",
  "sortDirection": "desc"
}
```

The previous `filters` and `sortField` inputs remain supported for backward compatibility. Friendly People sorts are `name`, `updated`, `created`, `stage`, and `value`.

Blank `searchQuery` uses Firestore browsing and cursor tokens. A nonblank People search uses Algolia and returns an opaque token such as `algolia:people:1`; FlutterFlow must pass either token back unchanged. Algolia search is relevance-ranked with the configured `updatedAt` custom ranking. Friendly sort selection applies to blank-search Firestore browsing; it does not create Algolia replica indexes.

Email messages also require `parentId` containing the parent thread document ID.

The response returns `records`, `recordRefs`, `totalRecords`, `totalPages`, `hasNextPage`, and `nextPageToken`. Pass `nextPageToken` back unchanged to load the following page.

## Lightweight access rules

- People, Organizations, Actions, and Connections use `teamRepIds`.
- Email Threads use `viewerUids`.
- Library Files currently list records owned by the authenticated UID.
- Email Messages validate access through their parent thread.
- Algolia search applies matching owner, viewer, and team filters.

## FlutterFlow state

Recommended People page state:

```text
currentPage = 1
peoplePerPage = 25
nextPageToken = ""
pageTokens = [""]
pagePeopleRefs = []
selectedPersonRefs = []
totalPeople = 0
totalPages = 1
pageLoading = false
```

Reset pagination and selection when search, filters, sorting, assigned representative, or page size changes. Preserve selection when moving between pages in the same result set.

## Deployment order

1. Deploy the callable functions and Algolia triggers.
2. Call `configureCommandSearchIndexes` once.
3. Delete the old test CRM records.
4. Create fresh records through normal Experience Command flows.
5. Confirm indexes and records appear in Algolia.
6. Confirm global search returns grouped results.

Firestore composite indexes, Firestore rules, and Storage rules are managed manually through the FlutterFlow/Firebase deployment process and are intentionally not maintained in this repository's JSON files. When Firestore provides a required-index link for a UI filter-and-sort combination, create it in the deployed Firebase project and record the active combination in deployment notes.

## People data guarantees

- Phone numbers are optional when an email is present.
- When supplied, a phone is stored in both `phone` and `phoneNormalized` as exactly 10 digits with no punctuation or spaces.
- Person updates require record-level owner, viewer, or team access.
- `assignedToRefPath` may be supplied to update a Person; an empty value clears the assignment.
- Estimated value remains outside People create/update and is added later by the sales-flow logic.
- Supported stages are `New`, `Contacted`, `Discovery`, `Proposal`, `Closing`, `Won`, and `Lost`.
