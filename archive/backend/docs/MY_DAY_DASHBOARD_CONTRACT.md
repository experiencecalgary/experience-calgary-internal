# My Day dashboard backend contract

This contract makes the backend authoritative for the compact My Day workspace. FlutterFlow
must not page through all Leads, Actions, and Meetings to reconstruct these groups or rank the
next move.

## Callable

`getCommandDashboardSummary({ scope: "mine" | "team" })`

The response preserves the legacy `attention`, `today`, and `flow` fields while adding the
new contract at `dashboard` and as top-level aliases during migration:

- `nextMove`
- `todayMeetings`
- `missingOutcomes`
- `overdueActions`
- `followUpsToday`
- `atRiskLeads`
- `unreadExMail`

Every bucket has:

```json
{
  "totalCount": 14,
  "showingCount": 3,
  "remainingCount": 11,
  "hasMore": true,
  "previewItems": [],
  "destination": {}
}
```

Preview lists are intentionally limited to three. `totalCount` is the complete scoped count,
not the preview size. Each record carries the exact Action, Meeting, Lead, or ExMail thread path
needed for direct navigation.

## Definitions

- **Today's Meetings:** open Meetings scheduled today in America/Edmonton whose scheduled end
  has not passed, plus every in-progress Meeting. An active Meeting remains visible when it runs
  beyond its scheduled end.
- **Missing outcomes:** open scheduled Meetings whose end time has passed and which have no
  Meeting outcome.
- **Overdue Actions:** open non-Meeting Actions whose due time has passed.
- **Follow-ups today:** open non-Meeting Actions due later today. Overdue Actions are excluded so
  the two dashboard buckets never duplicate work.
- **Leads at Risk:** active Engaged or Closing Leads with no future open Action. Existing
  overdue Actions remain visible as context, but a Lead with another valid future Action is not
  duplicated into this queue. The calculation uses linked Action records rather than stale Lead
  summary fields.
- **Unread ExMail:** visible threads whose `unreadBy` includes the signed-in rep. There is no
  unsupported "important" inference.
- **Your Next Move:** in-progress Meeting, Meeting starting within 30 minutes, missing Meeting
  outcome, overdue Action, Action due today, Lead at Risk, then the Start Working Recommended
  queue. This prevents dashboard cleanup inventory from overriding an active commitment.

## Destinations

Destination metadata describes intent without hardcoding FlutterFlow route names:

- Schedule / `today`
- Schedule / `missing_outcomes`
- Actions / open Action / `overdue`
- Actions / open Action / `today`
- Leads / active / `at_risk` / Engaged and Closing
- ExMail / unread
- Outreach / `priority_calls`

Individual preview rows should open their exact record. Header and "view all" actions should pass
the destination filter to the corresponding workspace.

The complete Leads-at-Risk queue is available without downloading all Leads:

```json
{
  "scope": "mine",
  "bucket": "at_risk_leads",
  "pageSize": 25,
  "pageToken": "optional offset token"
}
```

Read `bucketPage.records`, `bucketPage.totalCount`, `bucketPage.hasMore`, and
`bucketPage.nextPageToken`. Each record includes its exact `leadRefPath`.

## Frontend migration

After the destination widgets expose their initial filter parameters:

1. Load only `getCommandDashboardSummary`.
2. Render `dashboard.nextMove` directly.
3. Render at most the three returned preview rows per section.
4. Display `Showing X of Y`, `N remaining`, or `All caught up` from bucket metadata.
5. Remove the dashboard's calls to `listCommandActionsPage` and `listCommandLeadsPage`, its
   20-page loops, title-based follow-up detection, and local recommendation score.

No Firestore index or rule changes are required by this PR. Deploy only
`getCommandDashboardSummary` and `listCommandActionsPage` after merge.
