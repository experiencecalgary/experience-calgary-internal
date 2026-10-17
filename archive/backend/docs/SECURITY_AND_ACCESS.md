# Security and Access

## Command authentication

Protected Command services:

1. Require Firebase Authentication.
2. Load `users/{uid}`.
3. Require `userType == "rep"`.

Individual services then enforce ownership, viewer access, hierarchy access, or admin-only restrictions.

## Access fields

- `ownerUid` / `ownerRef`: primary owner.
- `assignedToUid` / `assignedToRef`: current assignee.
- `viewerUids`: explicit UID visibility.
- `teamRepIds`: hierarchy visibility using rep identifiers.

Access-sync triggers maintain metadata on People, Organizations, Actions, and Connections. A scheduled synchronization repairs hierarchy changes. The callable repair utility processes up to 1,000 records per collection per call.

## Action creation boundary

`createCommandAction` is the protected creation boundary for `commandActions`. It:

- requires an authenticated Command representative;
- validates exact `users/{uid}`, `commandPeople/{id}`, and `commandOrganizations/{id}` path shapes;
- confirms referenced documents exist;
- requires the selected assignee to be an active user with `userType == "rep"`;
- reads Person, Organization, owner, and assignee names from Firestore instead of trusting client-supplied cached names;
- enforces the relationship required by `relatedType`; and
- calculates initial ownership and visibility metadata before creating the Action.

The frontend may pass nullable Person or Organization path arguments to its wrapper, but the wrapper sends `''` for unused paths. Final Firestore relationship fields remain DocumentReferences.

`commandActionAccessSync` owns only access recalculation. It does not choose or rewrite Action business data or Person/Organization attachments.

## Public surfaces

Public Exchange HTTP endpoints use a random token stored as a SHA-256 hash. Comparison is timing-safe. Upload/download actions use short-lived signed Storage URLs. Public endpoints validate Exchange status, expiry, file count, and size limits.

SendGrid inbound and event endpoints use their configured verification mechanisms and secrets.

## Rules-file ownership

- Firestore rules and indexes are normally managed/deployed by FlutterFlow.
- Storage rules are managed manually.
- Backend changes must not silently overwrite any of these files.
- This repository documentation does not assert that checked-in rules equal the current intended production rules. Verify explicitly before a rules-only deployment.

## Secrets

Relevant secrets include SendGrid credentials/webhook verification and Algolia credentials, plus existing application integration and mail secrets. Never commit secret values. Deploy functions with Firebase Secret Manager bindings already declared in source.

## Contact linking and Action assignment enforcement

Manual ExMail Person linking requires access to both the thread and selected Person. It cannot claim an email address, mutate the selected Person, or change the thread's Organization. Identity ownership remains exclusively behind contact create/update/import/relationship and automatic inbound matching rules.

Action assignment is enforced server-side. The authenticated actor may select:

1. their own `users/{uid}` document; or
2. an active representative whose `programDirectorRepId` or `directorRepId` equals the actor's `repId`.

Rep identifiers are normalized as strings for comparison so numeric and string Firestore values behave consistently. Missing actor `repId` fails closed for assignment to another user.
