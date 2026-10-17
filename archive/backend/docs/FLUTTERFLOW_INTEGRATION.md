# FlutterFlow Integration

## General callable pattern

Custom actions call `FirebaseFunctions.instanceFor(region: 'us-central1')`. Document references are passed as validated paths where required. Keep returned JSON intact in page state when later actions need it.

## Create Command Action

Use the `callCreateCommandAction` custom-action wrapper everywhere an Action can be created:

- Actions page
- Person detail page
- Organization detail page

Do not use FlutterFlow Create Document followed by Update Document for Action creation. The wrapper calls `createCommandAction`, which resolves all paths and creates the complete Action in one backend write.

Wrapper inputs:

| Argument | FlutterFlow type | Nullable | Notes |
|---|---|---:|---|
| `title` | String | No | Required |
| `description` | String | No | Send `''` when empty |
| `actionType` | String | No | Required |
| `priority` | String | No | `Low`, `Medium`, or `High` |
| `dueAt` | DateTime | No | Required |
| `relatedType` | String | No | `Person`, `Organization`, or `General` |
| `assignedToRefPath` | String | No | Required `users/{uid}` path |
| `personRefPath` | String | Yes | Used only for Person Actions |
| `organizationRefPath` | String | Yes | Used only for Organization Actions |

The wrapper must convert nullable relationship inputs to empty strings before calling Firebase. It must also blank the unused relationship path based on `relatedType` so stale component state cannot attach the wrong record.

Page-specific values:

```text
Actions page
  relatedType = selected Person, Organization, or General
  personRefPath = selected Person path or ''
  organizationRefPath = selected Organization path or ''
```

```text
Person page
  relatedType = Person
  personRefPath = current Person document path
  organizationRefPath = ''
```

```text
Organization page
  relatedType = Organization
  personRefPath = ''
  organizationRefPath = current Organization document path
```

```text
General Action
  relatedType = General
  personRefPath = ''
  organizationRefPath = ''
```

Keep `personRef`, `organizationRef`, and `assignedToRef` as Document Reference fields in the FlutterFlow Firestore schema. Only component state and callable arguments use path Strings.

The wrapper returns a non-nullable String:

```text
success|commandActions/documentId
```

or:

```text
error|Explanation
```

Name the action output `createActionResult` and branch on `createActionResult starts with "success|"`. Clear loading state in both success and error branches. Optional relationship state should default to `''`; never run a client path-to-reference conversion for these fields.

## Paginated People and Organizations lists

Call `listCommandRecordsPage` through the FlutterFlow wrapper with:

- `recordType: people` or `recordType: organizations`
- `pageSize`
- `pageToken` (empty for page 1)
- optional `searchQuery`, `stage`, `assignedToRefPath`, `sortBy`, and `sortDirection`

Store `recordRefs`, `totalRecords`, `totalPages`, `nextPageToken`, and `hasNextPage`.

Both record types support page search, stage and assigned-representative filters, and `name`, `created`, `updated`, `stage`, and `value` sort keys. After an import or successful bulk update, reset page tokens and current page, call page 1 again, store the response, set loading false, and rebuild the page.

## Organization bulk updates

Call `bulkUpdateCommandOrganizations` with `organizationRefPaths` (maximum 100), `operation`, and the operation-specific value. Supported operations are `assign` with `assignedToRefPath`, `change_stage` with `stage`, `archive`, and `update_estimated_value` with a non-negative `estimatedValue`. Send `null` or an empty string to clear the estimated value. A successful response includes `ok`, `updatedCount`, `unchangedCount`, and `organizationPaths`.

## CSV page state

Recommended states:

| State | Type | Default |
|---|---|---|
| `selectedCsvFile` | Uploaded File | empty |
| `csvValidationResult` | JSON | empty |
| `csvImportInProgress` | Boolean | false |

Flow:

1. Pick a local file.
2. Call validation and save the complete output to `csvValidationResult`.
3. Check `$.isValid Is True`.
4. Display `$.errorMessage` in a scrollable custom dialog when invalid.
5. Commit using `csvValidationResult` and the authenticated user's reference.
6. Check `$.committed Is True`—not `$.success`.
7. Display `$.message` or `$.errorMessage`.
8. Refresh page 1 on successful commit.

The backend may return `status: completed` or `status: already_completed`; both are successful when `committed == true`.

## Long validation errors

FlutterFlow's standard Alert Dialog is not suitable for large CSV issue lists. Use a Custom Dialog component with a fixed/max height and an Expanded scrollable middle section. Keep the title and Close button outside the scrollable content.

## Loading states

Set loading immediately before the relevant async call and explicitly clear it in every success/failure branch. Use a rebuild for the final state update that replaces list references.

## Current custom-widget contracts

The current FlutterFlow layer uses custom widgets for Person create/edit, Organization create/edit, CSV validation/import, ExMail Connect-to-Person, contact relationships, ExMail settings, and Action creation. Nullable Firestore references are passed as optional path strings where required to avoid component-load failures.

For the ExMail Connect-to-Person widget:

- pass the thread DocumentReference;
- display/pass `thread.senderEmail` as the external sender address;
- do not pass `senderAddress`, which is the internal receiving Command mailbox;
- after success, refresh the thread/list query;
- do not update the Person email or Organization relationship from FlutterFlow.

The Action widget's assignee query should show the authenticated user plus active representatives where `programDirectorRepId == authenticatedUser.repId` or `directorRepId == authenticatedUser.repId`. The callable enforces the same rule.

The CSV widget may submit one bulk assignee and optional validated per-row assignments. Only the current user or permitted team representatives may be selected.


## EC Flow

The canonical stages are `New`, `Opened`, `Engaged`, `Closing`, `Won`, and `Lost`. People and Organization dropdowns must use these exact values. The active Flow board displays only `Opened`, `Engaged`, and `Closing`.

Call `listCommandFlowPage` directly from each custom Flow widget with:

- `recordType`: `people` or `organizations`
- `attentionFilter`: `all`, `overdue`, or `no_action`
- `pageSize`: 1–50
- `pageTokens`: optional JSON object keyed by `Opened`, `Engaged`, and `Closing`

The response contains exact stage and attention totals plus independently paginated `Opened`, `Engaged`, and `Closing` columns. Each card includes its record path, assignee, optional estimated value, next open Action, overdue state, and no-Action state.

`No Action Scheduled` means the active lead has no open Action. Completed Actions do not count. `Overdue` means the earliest open Action due date has passed.

The `commandFlowActionMetadata` trigger maintains the next-Action fields whenever an Action is created, completed, reassigned to another record, reopened, rescheduled, or deleted. After first deployment, run the paginated `backfillCommandFlowActionMetadata` callable for both record types so existing Actions are represented before the Flow widgets go live.
