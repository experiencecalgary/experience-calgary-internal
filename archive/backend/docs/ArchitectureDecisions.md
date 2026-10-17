# Experience Command — Architecture Decisions

## Core rule

Use FlutterFlow for straightforward Firestore CRUD. Use Cloud Functions for validation, security-sensitive workflows, external services, multi-document operations, search, imports, signed file access, and background automation.

## Source of truth

- FlutterFlow is the deployment source of truth for Firestore rules and Firestore indexes.
- Firebase Console is the deployment source of truth for Firebase Storage rules.
- Repository copies of `firestore.rules`, `firestore.indexes.json`, and `storage.rules` are informational only and may not match production.
- Do not deploy Firestore or Storage rules from this repository unless that ownership decision is explicitly changed.
- Before changing Storage rules in Firebase Console, copy the current live rules into the change record or deployment notes so public and authenticated paths are preserved.

## Cloud Function region

All Experience Command functions use `us-central1`.

## Direct FlutterFlow CRUD

FlutterFlow directly manages simple create/update operations for:

- Actions
- Meetings
- Notes
- Call logs
- Command settings, with admin-only Firestore rules

## Cloud Function responsibilities

Cloud Functions handle:

- People and organization validation, normalization, duplicate detection, and protected writes
- ExMail and SendGrid integration
- EC Exchange creation, confirmation, public token access, signed uploads/downloads, and expiry
- Cross-record search
- CSV validation and commit
- Team-access synchronization
- Background expiration and notification work

## EC Exchange purpose

EC Exchange securely replaces email attachments. It is not a document-management, approval, comment, task, project, or messaging system.

## Exchange lifecycle

- Request: draft → open → completed, or expired/cancelled
- Share: draft → active → expired/cancelled
- Completed request files remain stored.
- Link expiry is read from `commandSettings/exchange`.

## Exchange defaults

- `exchangeLinkExpiryHours`: 48
- `maxFilesPerExchange`: 10
- `maxFileSizeMb`: 20
- `maxTotalExchangeSizeMb`: 75

## File security

- Existing production Storage access must be preserved, including public business assets, user-owned files, recruiting uploads/videos, and the authenticated onboarding manual.
- EC Exchange must use dedicated `command/` paths that are not publicly readable or writable through the Firebase client SDK.
- Public Exchange access uses short-lived signed URLs issued only after token validation.
- Internal file access also uses short-lived signed URLs issued after authenticated authorization.
- The final live Storage rule update will be made manually in Firebase Console after reviewing the complete current production rules.

## Email presentation

Outgoing Command email uses one server-side HTML wrapper and an automatic user signature. FlutterFlow supplies content, not final HTML structure.

## API stability

Update existing function names in place. Do not create `V2`, `V3`, or similar duplicate exports unless a true compatibility boundary requires it.

## Version control and deployment safety

- All backend work is completed on feature branches.
- Changes are reviewed through pull requests.
- A backup branch or Git tag is created from production `main` before merge/deployment.
- Deploy only explicitly named new or changed functions whenever practical.
- Never deploy all functions merely because one Command function changed.
