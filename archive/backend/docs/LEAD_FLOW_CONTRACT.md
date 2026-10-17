# Lead Flow backend handoff

Originally prepared as PR #113 on top of PR #112. PR #113 was merged into the
PR #112 feature branch rather than `main`; this corrective change reapplies the
reviewed Lead Flow contract onto current `main` after PR #114.
No FlutterFlow widget is included. All UI colors must be explicitly set in the
replacement widget, including popup, dialog, placeholder and disabled states.

## Listing

`listCommandLeadFlowPage` accepts:

```json
{
  "scope": "mine",
  "leadType": "all",
  "assignedToUid": "",
  "leadListId": "",
  "search": "",
  "attentionFilter": "all",
  "pageSize": 20,
  "stage": "New",
  "snapshotId": "",
  "pageTokens": {}
}
```

- `scope`: mine/team; all is platform-admin-only. Mine matches owner OR assigned.
  Team excludes Mine and includes viewer/team access, matching #112. Admin team
  means all other representatives; use returned `scopeLabel` rather than silently
  implying a narrower organizational team.
- `leadType`: all/person/organization.
- `attentionFilter`: all/overdue/no_action/missing_outcomes/in_progress.
- Omit `stage` to load all four columns. Supply one canonical stage to load only
  that column (mobile or load-more). Stage affects hydration, not the full totals.
- The first request creates a 15-minute saved view. Reuse `snapshotId` to switch
  stages within it; use the column's token in `pageTokens[stage]` to load more.
- Reset snapshot/tokens together on any filter change, refresh, or successful
  mutation. Numeric legacy tokens fail explicitly and require a refresh.
- Search remains case-insensitive substring search across lead/contact/business
  names, applied before sorting and slicing the bounded candidate set.

`columns[stage]` retains total/records/hasMore/nextPageToken. `totals.active` and
per-stage totals are before attention filtering; `totals.matching` and each
column's total are after it. Overdue/noAction/missingOutcomes/inProgress count
LEADS, not actions. Display e.g. “Showing 84 overdue leads”.

Counts and ordering are **as of `countsAsOf`**, based on reconciled projections;
they are not a live counter. Display a last-refreshed label. Membership is fixed
for paging: newly matching records require refresh. Hydration revalidates lead
access, stage and filters. Removed/moved records do not shift the cursor. An
empty page may still have a token after access/stage changes. Honor `hasMore`.
`refreshRecommended` indicates observed change or a view older than one minute;
offer refresh and refresh on return from editing. Replacing the view should
preserve the UI's selected stage/filters and scroll anchor where possible.

Initial reads are capped at 2,001 candidate documents per permission shard and
2,000 unique candidates. Exceeding the cap returns `resource-exhausted` with a
rep/list narrowing instruction; no truncated count is presented. Rep/list/type
filters are pushed to Firestore. Search does not bypass this candidate cap.
Subsequent pages read saved membership, at most 100 candidate leads per requested
stage, and at most one referenced action per returned row, fetched in batches. They do not rerun the
candidate queries. This is a bounded saved-view design, not an unbounded global
pipeline or an aggregate-counter design. Actual deployed latency remains to be
measured. Snapshot storage uses the existing server-only maintenance namespace.

## Work state and destinations

The existing #112 reconciliation now also writes versioned `flowWork` timing
metadata. It counts all linked open work, including work assigned to another
rep, excludes archived/closed work, and reports unknown above 200 open records.
It never copies action titles or body text into the new projection. Time-based
classification happens on reads, so midnight/start/end boundaries need no write.

- `noAction`: no remaining open work at all, including meetings.
- `overdue`: at least one ordinary action due before now; a future meeting cannot
  hide it. `overdueActionCount` preserves that context even if a meeting is primary.
- Meetings are upcoming until their scheduled end, then missing outcome unless
  an outcome exists. Explicit/inferred in-progress meetings stay in progress.
- `hasFutureCommitment`: some open work starts/is due at or after now. This is
  separate from noAction. Undated and overdue-only work are not future commitments.
- In-progress/missing-outcome meetings sort first, then overdue actions, no work,
  planned/undated work, and unknown work. Earliest relevant time and ID break ties.
- `countsComplete: false` / `totals.unknown > 0` mean work summaries need repair
  or exceed the per-lead bound. Do not display incomplete attention totals as
  authoritative zeros. `workStateComplete: false` is “Work status unavailable”,
  never “No next action”. Active counts are still known for the saved view.

Each card includes nextStep {refPath,title,type,kind,state,at}, openWorkCount,
overdueActionCount, missingOutcomeCount, inProgress, hasFutureCommitment,
nextFutureAt, stageEnteredAt, daysInStage, updatedAt and primaryAction.
`primaryAction.destination` is lead/actions/schedule/create_action, accompanied
by exact record/lead paths. These are destination intents, not guessed route
names. Verify the receiving FlutterFlow widgets' parameters before wiring them.
Retained nextAction* fields support the old widget during transition.

The chosen Action is reread and its visibility verified before exposing its
title/path. If unavailable or changed, fall back to the Lead rather than showing
a stale task. `nextStepUnavailable`/`workStateStale` require refresh/context.
Do not treat unavailable work as permission to create duplicate work. Underlying
action writes reconcile asynchronously through #112's trigger, so a just-saved
change may briefly require refresh. No new access grants are introduced.

## Stage changes, closing and history

- Keep using updateCommandLead with stage, stageChangeReason (required when the
  stage actually changes; maximum 2,000 characters), and expectedUpdatedAt from
  the row. Existing lastUpdateTime protection remains in place.
- New leads, manual stage changes, connected/voicemail New→Opened calls and
  closing maintain stageEnteredAt. Historic unknown ages stay null; repair does
  not invent them. Existing meeting/agreement auto-stage behavior is unchanged.
- closeCommandLead accepts outcome won/lost from any active stage, lostReason
  for lost, optional notes, and expectedUpdatedAt. It rechecks access/status in
  its transaction. Same-outcome retries are no-ops; conflicting outcomes fail.
- Closing does not cancel meetings or open actions. Show that explicitly and
  allow the rep to review remaining work; response has remainingWorkUnchanged.
- Won/Lost history uses #112's listCommandLeadsPage status filter. Do not call
  legacy People/Organization reopening endpoints for Leads.

## Rollout

1. Merge/deploy #112 first. Add only missing definitions from
   `docs/LEAD_FLOW_INDEXES.json` through the existing index workflow. Do not
   replace global index configuration or delete existing indexes/rules. Wait
   for readiness. The list is an additive checklist for supported combinations.
2. Deploy `commandLeadNextActionSync`, `commandLeadFlowInitialize`, and
   `repairCommandLeadFlowSummaries` before enabling the new listing. Optional
   indexing exemptions for flowWork/maintenance snapshots can reduce index
   storage but are not required by the contract.
3. As a signed-in platform administrator, call repairCommandLeadFlowSummaries
   with `{}` and then each returned `{afterId}` until hasMore is false. Each
   call reconciles at most 20 leads in transactions. It is safe to retry;
   report incompleteLeadPaths for exceptional leads. No stage-age backfill.
   This PR does not execute the repair or modify production data itself.
4. Deploy the listing/mutations/cleanup below, then adopt the widget contract.
   Confirm maintenance paths remain server-only in deployed rules.

Exact affected exports (including shared-helper consumers):

```
listCommandLeadFlowPage
commandLeadNextActionSync
commandLeadFlowInitialize
repairCommandLeadFlowSummaries
cleanupCommandLeadFlowSnapshots
createCommandLead
updateCommandLead
closeCommandLead
finishCommandLeadCall
logCommandCallOutcome
updateCommandAction
cancelCommandAction
archiveCommandAction
```

Snapshot cleanup
deletes at most 100 expired saved views every 15 minutes; production throughput
may justify managed TTL later. Saved views never contain user-authored content.

## Verification

Focused service tests use the repository's in-memory Firestore adapter and
Firebase transport stubs. They cover real production selection, filter, repair
and transaction bodies, including the #110/#112 regression suites. They do not
emulate Firestore contention, deployed indexes, rules, trigger delivery timing,
or production latency. Perform a staging smoke test after indexes are ready.

## Pre-merge review follow-up

Card action reads are batched per page. A newly written next-action pointer that
is absent from the reconciled projection is reported as pending/unknown, not
no-action, until the trigger catches up. Changed source actions also mark the
row's work state incomplete instead of leaving a definitive overdue warning.
Inactive representatives cannot use the stage mutation endpoint.

81 focused service/regression tests pass with Firebase stubs, including bounded
snapshot cleanup and exhaustive query/index-checklist coverage. No GitHub check
runs/status results were registered at review time. This remains source/stub
verification; deployed indexes, live trigger timing and latency are not verified.
