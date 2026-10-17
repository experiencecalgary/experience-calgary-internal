# Experience Command contact identity and relationships

## Purpose

Experience Command uses one normalized email identity per Person and one per
Organization. A Person and Organization may share an address only when the
Person's `organizationRef` points to that Organization.

The authoritative identity documents are stored in
`commandEmailIdentityIndex`. Document IDs are SHA-256 hashes of normalized
email addresses; raw addresses are not used as Firestore document IDs.

## Contact fields

People and Organizations support:

- `email`: primary display address
- `emailNormalized`: normalized primary address
- `additionalEmails`: up to ten normalized additional addresses
- `additionalEmailsNormalized`: normalized search and matching values

Every active address is claimed transactionally with the CRM record.

## Relationship rules

- `commandPeople.organizationRef` is the source of truth.
- One Person can have zero or one Organization.
- One Organization can have many People.
- An Organization's `primaryContactRef` must reference an active Person whose
  `organizationRef` points back to that Organization.
- Use `setCommandPersonOrganization`; do not write relationship references
  directly from FlutterFlow.
- A shared Person/Organization email blocks disconnection until the address is
  removed from one record.

## Migration callable

Function: `backfillCommandContactIdentity`

Access: authenticated `platform_admin` representative only.

Input:

```json
{
  "recordType": "people",
  "dryRun": true,
  "limit": 25,
  "startAfterId": ""
}
```

Run separately for `people` and `organizations`. The function returns
`nextCursor`; pass it as `startAfterId` until `done` is true. The maximum
page size is 50.

The callable defaults to `dryRun: true`. Dry runs inspect the legacy
collections and the identity index without writing. Conflicts are returned per
record and are never silently reassigned.

## Production sequence

1. Deploy the code while keeping the migration in dry-run mode.
2. Dry-run every People page and save all conflict results.
3. Dry-run every Organization page and save all conflict results.
4. Correct duplicate or unrelated shared addresses in Firestore/Command.
5. Repeat both dry runs until `conflictCount` is zero.
6. Repeat the pagination with `dryRun: false` for People.
7. Repeat the pagination with `dryRun: false` for Organizations.
8. Re-run both dry runs as a final audit.
9. Rebuild People and Organization Algolia records so `emails` is populated.
10. Test inbound matching, manual linking, and outbound sending to an additional
    address before enabling the new FlutterFlow controls.

## CSV imports

CSV templates remain separate and capped at 250 rows. CSVs contain primary
email only. Additional emails are managed on contact records after import.

Imports use deterministic record IDs, an import ledger, and a Firestore
transaction that creates both CRM records and email identity claims. Retrying
the same validated import is idempotent.

People CSV organization text creates a relationship only when it exactly and
uniquely matches an existing Organization. Otherwise the text is preserved as
`importedOrganizationName` and `organizationRef` remains null.

## Deployment safety

Do not delete `commandEmailIdentityIndex` after migration. Do not deploy only
the create/update functions without also deploying their shared dependency
callers, ExMail functions, Algolia triggers, CSV functions, and the migration
callable from the same commit.

## Manual ExMail association is not identity ownership

Automatic inbound matching may use `commandEmailIdentityIndex` to identify an existing Person. Manual `linkCommandEmailThreadToPerson` is intentionally different: it associates a thread with a Person for CRM history only. It does not add the sender address to `additionalEmails`, create an identity claim, or require/change a Person/Organization relationship.

To make a sender address an owned contact address, edit the Person explicitly through the validated Person update flow. That operation then applies the normal identity-conflict and related-Organization rules.
