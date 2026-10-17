# Command Lead performance events

This layer turns the Command Center's existing lifecycle history into one consistent sales-event vocabulary in `commandConnections`. It does not create a competing activity collection and it does not ask representatives to enter duplicate data.

## Linking policy

An explicit `leadRef` is always used when supplied. For existing workflows that currently carry only Person and Organization references, the system links the event only when those references resolve to exactly one non-archived Lead. Ambiguous activity remains marked `performanceLinkStatus: unlinked`; it is never guessed.

## Normalized event fields

Every linked performance Connection includes:

- `leadRef`, `leadName`
- `eventType`, `eventAt`, `outcome`
- `repRef`, `repUid`, `repId`, `repName`
- Person and Organization references and names
- `leadSource`, `leadListId`, `leadListName`
- `previousStage`, `nextStage`
- `startedAt`, `finishedAt`, `durationSeconds`
- `completedOnTime`, `completionTiming`
- `lostReason`
- `performanceVersion`, `performanceLinkStatus`

## Automatic interpretation

- Existing Call outcomes become `call_finished`; a matching `call_started` event is derived from the captured duration.
- Existing inbound and outbound email Connections become `email_received` and `email_sent`.
- Every newly created non-Meeting Action produces one deterministic `action_created` event, including follow-ups created inside another workflow.
- Action completion compares `completedAt` with `dueAt` to calculate `on_time` or `late`.
- Meeting scheduling, starting, finishing, no-show and rescheduling use the existing Meeting Action and Connection history.
- Agreement documents generate sent, signed and declined events from real status transitions.
- Lead lifecycle Connections become created, imported, assigned, stage changed, Won and Lost events.
- The first genuine attempt and first meaningful connection are stored once per Lead with deterministic event identifiers.
- Each linked event refreshes the Lead's `lastActivityAt`, `lastActivityType`, and `lastActivityOutcome` summaries.

## New operations

- `startCommandMeeting` records the actual Meeting start time and returns its Meet link or location type.
- `finishCommandMeeting` is the clear UI-facing alias for the existing Meeting outcome operation.
- `startCommandLeadCall` and `finishCommandLeadCall` provide an exact, idempotent Call timer while continuing to use `commandCalls`.
- `declineCommandAgreement` allows a signer to explicitly decline a pending Agreement using the signing token.

## Event vocabulary

`lead_created`, `lead_imported`, `lead_assigned`, `first_attempt`, `call_started`, `call_finished`, `email_sent`, `email_received`, `first_meaningful_connection`, `action_created`, `action_completed`, `meeting_booked`, `meeting_started`, `meeting_finished`, `meeting_no_show`, `meeting_rescheduled`, `agreement_sent`, `agreement_signed`, `agreement_declined`, `stage_changed`, `lead_won`, and `lead_lost`.
