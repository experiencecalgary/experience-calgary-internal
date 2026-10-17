# VIP Opportunity Revival Backend

## Purpose

VIP Opportunity Revival is a campaign layer over Experience Command. It reuses Organizations, People, Actions/Meetings, Google Calendar, Connections, access metadata, and the existing CSV import ledger pattern.

It does not use Command Lists for campaign membership. Current People and Organization records have one `leadListId`; assigning a Revival List could replace an existing List. Membership is represented by `commandRevivalOpportunities.campaignRef`.

## Collections

### `commandRevivalCampaigns`

One document per client campaign. It stores the Organization and primary contact references, campaign team, pricing agreement, activation state, access metadata, and cached operational counts.

Statuses:

- `draft`
- `intake_review`
- `ready_to_activate`
- `active`
- `paused`
- `completed`
- `cancelled`

### `commandRevivalOpportunities`

One document per submitted previous opportunity. It links the campaign and existing/new Person and stores campaign-specific history, qualification, AI Revival Brief, delivery progress, Meeting reference, and outcome.

Firestore creates both collections automatically on the first successful document write.

## Callables

- `createCommandRevivalCampaign`
- `updateCommandRevivalCampaign`
- `previewCommandRevivalImport`
- `commitCommandRevivalImport`
- `analyzeCommandRevivalOpportunities`
- `reviewCommandRevivalOpportunity`
- `activateCommandRevivalCampaign`
- `getCommandRevivalCampaignSummary`

Every callable requires Firebase authentication and active Command access. Firestore clients may read the collections but cannot write them directly.

## Import

The Revival importer is intentionally separate from the exact-template People and Organizations CSV importer.

1. FlutterFlow parses CSV/XLSX/pasted rows into headers and row objects.
2. `previewCommandRevivalImport` applies deterministic mappings and uses OpenAI only for ambiguous headers.
3. A representative confirms or corrects the mapping and sends `confirmedMappings` for a final preview.
4. `commitCommandRevivalImport` connects exact existing People or creates new People through the production Person service.
5. Deterministic opportunity IDs and a `commandCsvImports/revival_{hash}` ledger make commit retries idempotent, including recovery after partial writes. The preview hash binds the exact normalized and source rows to the commit.

After activation, imports are accepted only as one-at-a-time replacements. The original opportunity must have two recorded delivery attempts, be marked unreachable/replacement-eligible, and not already have a replacement. Each campaign is limited to three replacements.

Limits:

- 50 submitted rows per execution batch; campaigns up to 100 may use multiple imports
- 20 KB source-data JSON per row
- 5 opportunities per AI analysis call

## OpenAI

The two AI uses are structured column mapping and Revival Brief extraction.

The route declares:

- Secret: `OPENAI_API_KEY`
- Parameter: `COMMAND_REVIVAL_OPENAI_MODEL`
- Default model: `gpt-5.6-luna`

Only the two AI-enabled callables bind the secret. Calls use the Responses API, strict JSON Schema Structured Outputs, and `store: false`.

The Revival Brief request excludes Person name, email, phone, and delivery address. AI cannot approve an opportunity, activate a campaign, calculate pricing, create a Meeting, or record a billable outcome. Failed AI analysis leaves the opportunity usable for manual review.

Configure the production secret after merge:

```bash
firebase functions:secrets:set OPENAI_API_KEY
```

## Activation pricing

Approved opportunity count determines the activation tier:

| Approved | Tier | Fee |
|---:|---|---:|
| 5–15 | `5_15` | $500 |
| 16–25 | `16_25` | $750 |
| 26–50 | `26_50` | $1,000 |
| 51–100 | `51_100` | $1,500 |
| 101+ | `custom` | Requires custom approval |

Fewer than five requires a leader/platform-admin override. Activation locks pricing.

Pricing models:

- `appointment_only`
- `shared_success`

Shared Success requires a fixed conversion event, fixed conversion bounty, and attribution period. A Program Director or platform administrator approves Shared Success activation and verifies conversions within that attribution window.

## Meetings

Meetings remain `commandActions` with `actionType == "meeting"`.

`createCommandMeeting` accepts optional:

- `revivalCampaignRefPath`
- `revivalOpportunityRefPath`

Both must be supplied together. The backend validates the active campaign, opportunity, and Person relationship. Booking and outcome writes synchronize the Revival Opportunity.

`recordCommandMeetingOutcome` accepts optional `qualifiedMeeting: true|false` for a linked held Meeting. Cancellation and rescheduling continue using their dedicated existing operations.

## Access and writes

Both Revival collections store standard Command metadata:

- `ownerUid` / `ownerRef`
- `assignedToUid` / `assignedToRef`
- `viewerUids`
- `teamRepIds`

Client writes remain denied. Important activity records store the acting representative's UID, reference, and display name rather than falling back to a generic system label.

## Deployment

After merge:

```bash
firebase functions:secrets:set OPENAI_API_KEY
firebase deploy --only functions,firestore:rules,firestore:indexes
```

Run `npm test` from `functions/` before deployment.
