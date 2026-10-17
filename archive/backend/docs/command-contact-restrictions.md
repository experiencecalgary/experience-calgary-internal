# Optional contacts in sales workflows

This backend change permits Sales and Partnership booking before a Person is known. Sales still requires an active Lead; Partnership still requires its Organization. Supplied People must belong to the Lead and pass existing access checks. Revival-linked meetings still require their specific Person.

`createCommandMeeting` accepts optional boolean `sendExternalInvitation`:
- omitted: retain previous invitation behavior when the selected Person has a valid email; otherwise create an internal-only event;
- false: no external attendee;
- true: require a connected Person with a valid email.

Internal calendar creation and virtual Meet links remain enabled. `externalInvitationEnabled` preserves the choice during rescheduling. No arbitrary external email input is added.

Partner presentation context returns `person: null` when absent. Sessions and events store null Person references/empty names; Lead, Organization, meeting type, in-progress checks and context-change detection remain in place.

The Lead call queue falls back to accessible, non-archived Organization contact data when no linked Person can be called. It exposes `contactRefPath` and `contactRecordType`; `personRefPath` is empty for Organization contacts. Organization fallback cannot bypass a linked Person/Lead do-not-call flag. Existing Person contact fields remain compatible for Person rows.

Agreement preview permits missing signer name/email/phone, but sending and signing retain their existing validation. This does not add draft persistence or bypass template/Lead relationship checks.

## FlutterFlow follow-up required

- Remove unconditional Person guards in Lead and standalone meeting forms; support booking without an external invitation.
- Handle nullable presentation `person` data.
- In call queue/outreach, use `contactRecordType` and `contactRefPath` for Organization fallback, not a fabricated Person path.
- Permit incomplete agreement preview while retaining send-time validation.

This PR does not change widgets, rules, indexes, migration, or the website asset importer. Merge/deploy alone will not remove the current widget-level warnings. Exercise live Calendar creation/rescheduling and presentation start/page/complete in staging after deployment.

Validation: Node 22.23.2, installed functions dependencies; focused contact/meeting/presentation/call-queue/agreement tests. No live Calendar or Firebase writes performed during testing.

## PR review — 8 September 2026

Full suite compared under Node 22.23.2 using the same installed dependencies:
- Main b81971acedf48138467bfc1ae1573fead7bd75f0: 338 tests, 327 passed, 11 failed.
- Revised PR: 346 tests, 335 passed, the same 11 failed. All eight new regression tests passed.
- Existing failures concern Admin Center actions, inbox filters, weekly sales/date handling, rep hierarchy fixtures, and concurrent sales attribution. No new failing test names were introduced.

Review found and corrected rescheduling dropping saved internal attendees when an external attendee was present. External and internal recipients now resolve independently; an explicit external opt-out is respected even if a stale email is stored. Regression tests cover both behaviors.

GitHub reported the initial PR head conflict-free; no remote CI checks were registered. Full-suite failures remain baseline issues and this review is not live Firebase/Calendar verification. Frontend rollout remains required as described above.
