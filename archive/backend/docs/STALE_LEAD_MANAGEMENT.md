# Stale Lead Management

This adds an admin pool using `commandLeads.status = stale`. No new Lead fields,
collection migration, automatic archive, or shared-contact ownership changes.
The sales stage, original list, contacts and history remain intact.

## Behaviour

- Daily at 03:00 America/Edmonton, **disabled by default**.
- An assigned, active, unarchived Lead qualifies only when createdAt, updatedAt
  and lastActivityAt (when present) are all older than 30 days.
- Missing createdAt/updatedAt is not guessed. Existing creation/import/migration
  paths populate these fields; malformed legacy records require separate review.
- Live open Actions (including Meetings), in-progress calls, pending agreements,
  or recent Connection history protect the Lead. Contact-only legacy open work
  also protects it conservatively. An overdue/undated/open task is still open.
- Recheck the current Lead and related work transactionally before moving it.
- Clear assignedToRef/Uid/Name; preserve original owner and record the former
  assignee/reason in a `lead_marked_stale` Connection.
- Stale and archived-from-stale Lead detail/mutation access is admin-only through
  the affected callable services. The FlutterFlow page/menu must also be admin-only.
- Normal lead lists retain active/Won/Lost views but exclude stale by default.
  Queue and dashboard queries request active Leads before loading candidates.
  Current Flow already queries active and revalidates saved views.
- A bounded daily pass checks at most 500 older candidates. A rolling cursor in
  the single `commandMaintenance/staleLeads` settings document progresses past
  protected candidates. Restart from the beginning when the pass exhausts them.
- Pause stops future pages/runs, not a transaction already in flight.

## Admin endpoints (us-central1)

All require platform admin, including read/preview/settings.

| Endpoint | Input | Output |
|---|---|---|
| getCommandStaleLeadSettings | none | enabled (default false), days=30, lastRunAt, lastScanned, lastMoved |
| setCommandStaleLeadSettings | enabled: boolean | same settings |
| previewCommandStaleLeads | pageSize 1–100, pageToken | records with eligibility/reason; scanned/eligible for this page; nextPageToken |
| listCommandStaleLeads | pageSize 1–100, pageToken, search | records, previous rep/reason, hasMore, nextPageToken |
| manageCommandStaleLeads | operation: assign or archive; leadRefPaths: 1–50; assignedToRefPath for assign | per-lead changed/reason; changed count |

Preview checks older candidates only; it does not claim to count all Leads or
all malformed legacy data. Empty or sparse pages may still have a continuation.
Bulk operations are individually transactional; return per-item failures, never
claim the whole batch succeeded. Retry skips Leads already processed.

Reassignment sets both owner and assignee to the new active rep and status=active.
Updating the existing updatedAt gives a fresh working period. It checks linked
contact access first: if the destination rep cannot access a Person/Organization,
admin must assign that contact through the existing contact workflow and retry.
This avoids silently transferring a shared contact or handing over an unusable
Lead. The current owner/assignee can see earlier call, meeting and note history;
private email and Action permissions remain scoped. Historical attribution is
not rewritten. Both the Lead access trigger and access repair reconcile current
data transactionally to prevent an older snapshot reversing an assignment.
CSV import skips matched contacts whose Lead is already in the stale pool.

Archive uses existing archive fields and stores statusBeforeArchive=stale.
Existing restore returns it to the stale pool; admin can then reassign it.

## FlutterFlow widget

Deliver separately: `CommandStaleLeadManagementWidget`.
- Add width/height parameters and optional onMenu Action.
- Create a platform-admin-only page and admin-only Command menu entry.
- Place widget at full available width/height; wire onMenu to the existing menu.
- Widget verifies access using the settings endpoint before loading records.
- Preview and stale-pool modes; paginated rows; details/recent history;
  individual and bulk assign/archive; pause/enable daily cleanup.
- Review preview pages before enabling. Enabling does not run immediate cleanup;
  the next scheduled run starts at 03:00 local Calgary time.
- History dialog explicitly shows the latest page, not a claimed full history.

## Deployment order

1. Merge PR. Add indexes from firestore.indexes.json; retain existing live indexes.
   STALE_LEADS_INDEXES.json lists the additive indexes in this PR. Wait until ready.
2. Deploy exactly these new/changed function exports:

```
previewCommandStaleLeads,listCommandStaleLeads,manageCommandStaleLeads,getCommandStaleLeadSettings,setCommandStaleLeadSettings,processCommandStaleLeads,listCommandLeadsPage,searchCommandLeads,listCommandCallQueue,getCommandDashboardSummary,assignCommandLead,getCommandLead,updateCommandLead,setCommandLeadContacts,convertCommandLeadType,closeCommandLead,archiveCommandLead,restoreCommandLead,commandLeadAccessSync,repairCommandRecordAccess,validateCommandCsvImport,commitCommandCsvImport,getCommandLeadOverview,listCommandLeadSection,saveCommandLeadNote,getCommandLeadNoteHistory,getCommandLeadHighlights,startCommandLeadCall,finishCommandLeadCall,getCommandOutreachContext,saveCommandOutreachProgress,markCommandLeadCallEnded,listCommandLeadFlowPage,sendCommandEmail,replyCommandEmail
```

Shared helper consumers also need redeployment; verify this list against deployed
exports during release. Firestore rules remain managed in FlutterFlow; this PR
does not replace the repository's informational rule file or live rules.
3. Add/build the widget in FlutterFlow, test with admin and rep accounts.
4. Review preview, then enable cleanup from the page. No live records are moved
   merely by deploying these functions.

## Validation

- 50 targeted review tests pass (stale lifecycle, workspace and CSV import).
- Full suite: 481 tests, 469 pass, 12 fail. The same 12 tests fail on the unmodified
  main snapshot under this environment (Node 24; project targets Node 22).
- Dart parsed without syntax errors. Flutter/FlutterFlow build and live Firebase
  execution are not available in this workspace and remain release checks.
