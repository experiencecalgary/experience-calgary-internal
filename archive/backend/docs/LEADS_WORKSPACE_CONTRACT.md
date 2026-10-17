# Leads workspace backend preparation

Based on main `037070905af1da29a73c9abd5dcda9cd291fd5a0`, after PR110 (Start Working)
and PR111 (My Day). No dashboard/Schedule behavior, widget files, production records,
global rules or index configuration are edited by this change.

## First paint and list navigation

`listCommandLeadsPage` / `searchCommandLeads` retain their names and full-record default.
New UI: `{scope:"mine", pageSize:20, summaryOnly:true, stage?, leadListId?, search?, pageToken?}`.
Scopes retain current semantics: Mine = owner OR assigned; Team = visible and neither mine;
All = platform admin only. Team uses viewer/team indexed queries with deduplication, retaining numeric and string team IDs.
Ownership, stage and list filters run in Firestore. Remaining filters/search are applied
only within those scoped candidates. Search remains case-insensitive substring search of
the existing Lead search fields; this PR does not introduce a new search engine or backfill.

Pages are bounded to five rounds of at most 50 documents per query (normally two shards,
20 documents each). Responses include returnedRecords, scannedRecords, hasMore, nextPageToken,
scanLimited and totalRecords:null. An empty page with hasMore is NOT the end; continue the
token after yielding to the UI. Do not show loaded counts as totals, automatically download
all pages for counts, or assume an exact match count. Normal stage/list views avoid broad scans.
Text searches can still require multiple pages. Page size caps at 50, default 20.

Tokens bind user and filters and retain timestamp nanoseconds and document-ID tie breaks.
Old cursor tokens must be discarded once after deployment. Tokens are not access credentials;
every page rechecks current access. Lists ordered by updatedAt are live, not frozen snapshots:
deduplicate by refPath, preserve loaded rows and scroll anchors, refresh deliberately. On edits,
update the changed row rather than resetting the list. This PR does not persist client scroll state.

Summary rows contain identity, stage, main-contact/business names, assignee and next-action
summary only; no per-row contact reads. `nextActionResolutionIncomplete:true` means do not
assert that next-action metadata is complete. Names in summaries use existing stored snapshots;
the selected overview reads current contact records.

## Selected lead: overview first

`getCommandLeadOverview({leadRefPath})` returns lead fields, accessible business details,
accessible contacts with explicit recordType/refPath, phone/email and canCall flags, updatedAt
values for editors, and the next permitted open action. Business fallback retains PR110's
do-not-call protections. `organizationUnavailable` means a linked business could not be exposed;
do not display this as a missing website or suggest replacing the relationship.

No history, notes collection, agreements, email inbox, or assets are fetched by overview.
Contacts and open actions load concurrently after Lead authorization. Action resolution reads
at most 201 records for this lead. If over 200, `nextActionComplete:false` explicitly prevents
claiming no next action; offer Work and leave the overview usable. This is a bounded fallback,
not a guarantee of instant loading at every scale. Loading failures are not missing fields.

`getCommandLeadHighlights({leadRefPath})` is a separate optional request after first paint:
up to 20 pinned notes, morePinnedNotesAvailable, latestConversation, conversationScanComplete.
It does not load assets or full histories. If conversationScanComplete is false, do not claim
there has never been a conversation; use the conversations section to continue.

## Tabs / section paging

`listCommandLeadSection({leadRefPath, section, pageSize:20, pageToken?, search?, status?})`.
Sections: activity, conversations, notes, actions, meetings, agreements, emails.
Status defaults to all; set open for outstanding actions. All queries start with leadRef.
Each record's visibility is enforced, independent of its assignee; no Mine/Team filter is
applied inside the selected Lead. ExMail uses its existing thread-read ACL (owner/viewer/team/admin).
No signing token, routing secret or raw record payload is returned.

Lists use chronological newest-first paging (emails by lastMessageAt; other sections by
createdAt). Records missing the ordering timestamp are not covered: existing writers set
these fields; legacy omissions require a separate evidence-backed repair, never guessed dates.
Dates and source/action/call/thread references support a readable grouped timeline in the widget.
Do not use event counts as conversation counts. A linked Person/Organization with multiple
opportunities does not cause unrelated history or ExMail to be guessed into the selected Lead.

The Notes section includes linked standalone notes, lead-details note events, completed-call
and meeting-outcome notes, excluding call-start duplicates. Current business/contact/lead
summary notes also come from overview. Older contact-only notes without a leadRef are not
silently assigned to an opportunity. Preserve explicit source labels when showing them elsewhere.

## Standalone notes

Create: `saveCommandLeadNote({leadRefPath, clientRequestId, title?, body, pinned?})`.
Keep the same clientRequestId on retries; different content under that ID is rejected.
Update/pin: `saveCommandLeadNote({leadRefPath, noteRefPath, expectedRevision, title?, body?, pinned?})`.
Response includes noteRefPath, revision, updatedAt. Revision conflicts require reload/review.
Body limit 10,000 characters; title limit 200. The body must not be empty.

Author, creation time and source references are preserved. Each edit saves the prior revision;
`getCommandLeadNoteHistory({leadRefPath,noteRefPath,pageToken?,pageSize?})` returns current content
and paginated previous revisions. Legacy note revision defaults to zero. Managed Lead notes
inherit current Lead visibility across assignment changes. Legacy note ACLs remain checked.
Author/current Lead owner/current Lead assignee/platform admin may edit, after current Lead
access is checked. Pin is an edit. Archived Leads are read-only. Inactive reps are rejected.

New notes live in the server-only existing commandMaintenance namespace, at
commandMaintenance/leadWorkspace/commandNotes/{id}; revisions use a private maintenance
subcollection too. Treat noteRefPath as opaque. This avoids opening client access to note
bodies/revision history. Legacy root commandNotes can still be viewed/edited through the API
when linked and permitted. New notes and their deterministic timeline entries commit together;
legacy commandNoteCreated remains unchanged. No note deletion,
unrequested migration, draft persistence, or direct client Firestore writes are added.
The widget owns unsaved drafts and must not discard them when navigating.

## Next action correctness

`commandLeadNextActionSync` reacts to Action creation/update/deletion and reassignment to a
different lead. In a transaction it reads current outstanding work and selects an in-progress
meeting first, then earliest dated open work (overdue before future; undated last). Ties use ID.
Action edit/cancel/archive callables use the same current-work reconciliation so delayed
callable writes cannot restore a stale summary after the trigger.
This is operational ordering, not an AI score or a replacement for PR111's My Day priorities.
It includes all assignees for the shared lead summary. The overview independently computes
the viewer's permitted next action so it does not wait for trigger delivery.
The trigger leaves updatedAt unchanged to avoid making every action reconciliation reorder
the Leads list. Existing summaries reconcile on the next action mutation; no backfill runs.
Over 200 actions sets nextActionResolutionIncomplete instead of inventing a next action.

## Existing editors, Call, ExMail and assets

Use PR110's updateCommandPerson/updateCommandOrganization/updateCommandLead endpoints and
expectedUpdatedAt conflict checks. The Person editor now tolerates pre-existing validation
errors only for untouched fields; invalid supplied fields and removing the final contact
method remain rejected. Preserve a legacy fullName during unrelated edits.

Business/Main contact/Opportunity/Other contacts are UI sections, not duplicate data stores.
Save only changed fields to the owning record. These are separate operations: show section-level
success/errors and never report all sections saved when one fails. There is no atomic multi-record
editor in this PR. Relationship and assignment changes retain existing endpoints and permissions.

Call uses PR110's selected contactRefPath and displayed phone, then dials the validated number
returned by startCommandLeadCall. Keep mark-ended/finish/cancellation/recovery behavior.
Compose opens the composer only; pass selected recipient context plus explicit leadRefPath to
sendCommandEmail. This change carries thread.leadRef into email-generated follow-up actions.
The next-action trigger then reconciles those actions. Sent-event retries preserve existing
follow-up actions, including completion and rep edits. No outbound messages are sent by this PR.

Assets continue using getCommandOrganizationBrand/saveCommandOrganizationBrand and
previewCommandWebsiteBrand/commitCommandWebsiteBrand. Load only when the Assets tab opens.

## Deployment / verification

Review the exact composite definitions in `docs/LEADS_WORKSPACE_INDEXES.json` and add only
missing indexes through the existing FlutterFlow-managed index workflow. This file is an
additive checklist, NOT a replacement for the project's full index configuration. Several
definitions already exist. Wait for readiness before switching the list functions. No rules change.
Do not deploy all functions or all indexes for this PR.

Affected function exports:

- listCommandLeadsPage, searchCommandLeads
- getCommandLeadOverview, listCommandLeadSection, getCommandLeadHighlights
- saveCommandLeadNote, getCommandLeadNoteHistory
- commandLeadNextActionSync
- updateCommandPerson, commandEmailSentEngagement
- updateCommandAction, cancelCommandAction, archiveCommandAction

Deploy only the exports listed above; no dashboard, Schedule or calling function rollout is needed. Verify the deployed rules retain server-only access to
commandMaintenance before rollout; the repository already does. Timeline access continues
through existing commandConnections permissions; the new API independently enforces Lead access.
Validate indexed queries, actual latency, note edits/reassignment and email follow-up linkage
in staging before adopting the new widget. Measure list usability, selected-lead readiness and
return-to-list time separately. Service tests use Firebase transport/storage stubs, not a live
emulator. Full dependency-backed tests and production latency remain unverified.

Focused validation: `node --test functions/test/commandLeadWorkspace.test.js
functions/test/commandOutreach.test.js` — 51 passing service/regression tests.
The 9 existing commandLeads tests also pass with the same Firebase stubs (60 total).
Changed JavaScript passes syntax checks; `git diff --check` is clean.
