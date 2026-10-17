# CSV Imports

## Supported imports

- People
- Organizations
- Maximum: 250 actual data records per import
- Official template layout: headers on row 1, instructions on row 2, records from row 3 onward

FlutterFlow removes the instruction row and sends normalized headers/rows to validation.

## People rules

Required:

- first name
- last name
- at least one of email or phone

Validation also checks template headers, lengths/formats, ten-digit normalized phones, duplicate email/phone conditions, supported stage/value data, and duplicates within the file/current database as implemented by the current service.

## Organization rules

The Organization name and at least one of email or phone are required. The exact template columns are `name`, `email`, `phone`, `address`, `city`, `province`, `postalCode`, and `estimatedValue`. Estimated value accepts zero, a positive number, or blank (stored as zero). Validation also checks exact headers, field lengths, email/phone formats, duplicates within the file, and existing Organization name/email/phone duplicates.

## Two-step flow

### Validate

`validateCommandCsvImport` receives `recordType`, `headers`, and `rows`. The FlutterFlow wrapper retains these values plus `importBatchId` in its returned JSON for the commit step.

Frontend validation condition:

```text
csvValidationResult -> $.isValid -> Is True
```

### Commit

`commitCommandCsvImport` receives the saved validation result fields and `assignedToRefPath`. For the simplified current UI, pass the authenticated user's reference so imported records start assigned to the importer.

Frontend commit condition:

```text
commitCSVOutput -> $.committed -> Is True
```

Do not check only whether the output is set and do not check `$.success`.

Successful new commit:

```json
{ "status": "completed", "committed": true }
```

Safe repeat of the same batch:

```json
{ "status": "already_completed", "committed": true }
```

The batch identifier provides idempotency protection. After success, reset pagination and load People/Organizations page 1. On failure, show `$.errorMessage` and retain the validation JSON when a retry is appropriate.

## File display

Large validation reports require a scrollable Custom Dialog. A standard Alert Dialog can clip long error lists.

## Assignment behavior

A validated import may use a bulk `assignedToRefPath` and optional per-row assignments. Every chosen assignee is checked server-side. The authenticated representative may assign to themself or to a representative whose `programDirectorRepId` or `directorRepId` matches the actor's `repId`.

CSV import remains relationship-light: People connect to an Organization only through an exact unique Organization-name match. Organization imports do not silently create People or Person relationships.
