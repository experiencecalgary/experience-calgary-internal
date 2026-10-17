# Start Working backend contract

Backend preparation for the FlutterFlow rebuild. Existing call/queue names remain exported;
no FlutterFlow widget, Firestore rules, or live records are changed by this PR.

## Queue

`listCommandCallQueue` keeps existing filters and response record fields. Supported modes:

- `priority_calls`: Recommended (existing additive scoring retained).
- `custom_queue`: Build a Queue using `leadListId`, `stages`, `source`, `search`, scope, and sort.
- `selected`: `selectedLeadRefPaths` (1–500); explicit selection order, same-day retries allowed.
- `today_retry`: completed calls **started by the signed-in rep**, finished within the current
  America/Edmonton calendar day; one row per accessible active lead. Default latest result is
  no_answer/voicemail; `retryAll: true` includes other completed outcomes. Cancelled attempts
  never qualify. Returns `todayAttemptCount`, `todayLastCallOutcome`, `todayLastCallAt`.
- Existing new_leads, follow_ups_due, reconnect, stage_campaign remain accepted.

`excludeCalledToday` remains available for the default/custom queue. Selected and today_retry
ignore this switch intentionally. `includeMissingNextStep: false` excludes leads with no open
action. The legacy `includeNoFutureAction` switch keeps its original behavior; do not label it
as “missing a next step” in the new widget. Stage Campaign still requires exactly one stage.

Queue creation queries ownership/assignment or permitted team scope, with list/stage filters.
It fetches actions only for those leads. A scope over 2,000 candidates returns an explicit
resource-exhausted response asking for a list/stage filter; it never silently truncates the
ranking. The initial ranking still reads scoped candidates and their linked contacts; subsequent
pages hydrate only their fixed membership slice. This is not an instant-load benchmark claim.

The response contains `queueId`, `queueExpiresAt`, `nextPageToken` (opaque), and the initial
`total`. Queue IDs and tokens are bound to the actor and normalized filters. Membership/order
is fixed for eight hours, but permissions/status/contactability are checked on each page.
A page may be empty with hasMore=true when entries become unavailable; follow its next token.
Do not interpret total as a live eligible count. No token means a fresh queue unless supplying
`resumeQueueId`; old numeric tokens need one refresh after deployment.

`saveCommandOutreachProgress`:

- `{queueId, readOnly:true}` returns revision, filterOptions, progress and currentLeadRefPath.
- Save `{queueId, expectedRevision, leadRefPath, state, currentLeadRefPath}`;
  state is worked/skipped/pending. Stale revisions fail with aborted.
- Restore filterOptions and call listCommandCallQueue with resumeQueueId to resume at the
  current position, passing worked/skipped entries. Skip is session progress, not a CRM outcome.
- A scheduled job removes expired server-only queue documents. No client collection access needed.

Reconnect now uses `lastMeaningfulConnectionAt`, maintained by meaningful performance events
and connected-call completion. Existing first-only milestones are not treated as “last contact.”
Historical records are not rewritten by this PR; first-only legacy leads need a trusted history
backfill or a new meaningful event to qualify for Reconnect.

## Call card and editing

`getCommandOutreachContext({leadRefPath})` supplies contact names/roles/phone/email/status,
organization website/address/industry/notes, lead notes/opportunity details, the latest 30
visible history entries, up to 100 visible open actions, and this rep's recoverable pending call.
Use the linked organization.website for the Open Website link. No fabricated Person reference
is used for a business-number call. Access checks apply to each returned record.

Reuse existing validated editors:

- `updateCommandPerson({personId, firstName?, lastName?, phone?, email?, position?, notes?, expectedUpdatedAt?})`
- `updateCommandOrganization({organizationId, organization?, website?, phone?, email?, address?, city?, province?, postalCode?, industry?, notes?, expectedUpdatedAt?})`
- `updateCommandLead({leadRefPath, displayName?, stage?, source?, notes?, opportunityDetails?, expectedUpdatedAt?})`

Supply the context's updatedAt as expectedUpdatedAt; aborted means reload and let the rep review
changes. Person/Organization identity checks, normalization, duplicate detection, assignment
permissions and relationship propagation stay in the existing services. Transaction version
checks also guard against concurrent overwrites. A genuinely changed phone clears wrong_number
unless do-not-call remains set. Changing the person dialed never changes the primary contact.

## Call lifecycle

`startCommandLeadCall({leadRefPath, clientRequestId, contactRefPath?, phone?})`

The new widget must pass the selected contactRefPath and displayed phone. The backend validates
membership, visibility, number and call restrictions, stores the actual contact/number snapshot,
and returns callRefPath/contactRefPath/dialedPhone. Dial the returned number. New IDs for an
unfinished rep/lead call resume it instead of creating duplicates. A start retry reuses its ID.
Legacy callers omitting contactRefPath still get automatic selection, but should be upgraded
to dial the returned number rather than a stale card value.

`markCommandLeadCallEnded({callRefPath})` freezes the rep-marked end before notes are entered.
Duration remains elapsed time, **not verified talk time**. Clients omitting this call retain the
legacy elapsed-until-save duration with an explicit durationSource.

`finishCommandLeadCall` accepts:

```json
{
  "callRefPath": "commandCalls/…",
  "outcome": "connected",
  "disposition": "callback_requested",
  "notes": "Requested a callback tomorrow afternoon",
  "completeActionRefPath": "commandActions/…",
  "nextStep": {"mode":"create", "title":"Requested callback", "dueAt":"ISO-8601 future time"},
  "queueId": "optional queue ID"
}
```

Outcomes: connected, voicemail, no_answer, wrong_number, not_interested, not_placed.
Notes required for connected/not_interested, optional for routine unsuccessful attempts.
Connected dispositions: interested, callback_requested, not_interested, do_not_call (or omitted).
No default outcome should be preselected in the widget.

Optional completeActionRefPath must be an accessible open non-meeting action for this lead.
Optional nextStep is create or reschedule; reschedule also requires actionRefPath and updates
that existing open action. A next step created from a call is assigned to the calling rep.
The call result, action completion/reschedule/creation, lead next-action fields and optional
queue progress are committed together. Retrying a completed call returns its saved result.
A call cannot complete and reschedule the same action. Not-placed cancels without counting an
attempt and cannot complete outreach work. Wrong-number flags only the still-matching number;
it cannot overwrite a number corrected during the call. Do-not-call restricts the lead without
marking it lost. Existing New -> Opened behavior for connected/voicemail is retained.

Meetings and agreements keep their dedicated lifecycle APIs (createCommandMeeting,
rescheduleCommandMeeting, createAndSendCommandAgreement, closeCommandLead, etc.). Do not create
fake meeting actions through nextStep. Calendar/email/agreement sends are not part of the
Firestore call-finish transaction; the widget must show their independent success/failure.

## Email

`sendCommandEmail` accepts optional leadRefPath. It verifies lead visibility and that resolved
person/organization belongs to that lead before creating the thread/message/event. Reply and
inbound activity retain the thread leadRef. Legacy sends retain unique-reference inference.
The new ExMail composer must pass the selected lead explicitly; no outbound emails were sent
while developing this change.

## Rollout and validation

Deploy the added Firestore indexes and wait for readiness before functions. Then deploy functions
and replace the widget/composer with these contracts. No rule change is included. Existing widgets
continue using their existing endpoint names, but do not expose the new controls by themselves.
Legacy unfinished calls without an active-call slot are not migrated automatically.

Service regression tests use an in-memory Firestore adapter and Firebase transport stubs:
`node --test functions/test/commandOutreach.test.js`. They exercise actual production service
bodies including transaction rollback, permission checks, retries and pagination. They are not
Firebase emulator/live integration tests. Dependency installation was blocked in the authoring
environment, so the full dependency-backed suite was not run. Validate indexed queries and
Calendar/ExMail interactions in staging before deployment.

## PR 110 pre-merge review

The review corrected three edge cases: replaying a committed start after the number is flagged
wrong; finishing a recovered call after its temporary queue has been removed; and explicitly
linking a Person Lead email when relationship resolution supplies the contact's existing employer.
The employer exception requires the real connected Person relationship and access to both records;
it neither changes the Lead's Organization nor permits unrelated Organizations.

Validation after these fixes: 28 service regression tests and 16 existing focused tests pass with
Firebase transport/storage stubs. Syntax checks pass. GitHub has no registered automated checks
for this PR. Full dependency-backed and live integration testing remain unverified; deploy the
indexes before the functions and run the staging checks described above.
