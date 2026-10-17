# FlutterFlow wrapper audit: Command contacts, relationships, and CSV

This audit reflects the backend contract in the contact identity hardening release.

## Existing wrapper status

| Wrapper | Status | Required change |
| --- | --- | --- |
| `callValidateCommandPerson` | Compatible | Add `additionalEmails` when the new contact editor exposes them. |
| `callCreateCommandPerson` | Compatible but outdated | Stop requiring/sending `ownerRef`; backend owns it. Accept additional emails and return `personPath`. |
| `callUpdateCommandPerson` | Compatible | Backend accepts legacy `organizationRef` and `assignedToRef`; migrate to canonical path keys and add additional emails. |
| `callValidateCommandOrganization` | Compatible but outdated | Owner is not client-controlled. Add additional emails when exposed. |
| `callCreateCommandOrganization` | Compatible but outdated | Stop sending owner and `allowDuplicate`; return `organizationPath`. Connect People in a second call. |
| `callUpdateCommandOrganization` | Compatible | Owner and `allowDuplicate` are ignored. Primary contact must already belong to the Organization. |
| `callLinkCommandEmailThreadToPerson` | Compatible | Treat success as a thread association only; `senderEmailAdded` remains `false` for response compatibility. |
| `callValidateCommandCsvImport` | Compatible | Preserve the full validation map exactly as it currently does. |
| `callCommitCommandCsvImport` | Must change | Allow both `ready` and `ready_with_duplicates`. Make assignee optional; backend defaults to current rep. |
| Bulk People/Organizations | Compatible | No identity-specific changes required. |

## Canonical callable payloads

### Create Person

```dart
{
  'firstName': firstName.trim(),
  'lastName': lastName.trim(),
  'email': email.trim(),
  'additionalEmails': additionalEmails,
  'phone': phone.trim(),
  'stage': stage.trim(),
  'organizationRefPath': organizationRef?.path ?? '',
  'organizationName': organizationName.trim(),
  'assignedToRefPath': assignedToRef?.path ?? '',
}
```

Do not send `ownerRefPath`. The backend returns `personPath`.

### Update Person

Use `organizationRefPath` and `assignedToRefPath`. Sending an empty assignment
repairs to the owner; it never creates an unassigned record.

### Create Organization

Do not send owner or primary contact. Create the Organization first, then call
`setCommandPersonOrganization` when connecting an initial Person.

The backend returns `organizationPath`.

### Set Person relationship

```dart
{
  'personRefPath': personRef.path,
  'organizationRefPath': organizationRef?.path ?? '',
  'makePrimaryContact': makePrimaryContact,
}
```

An empty Organization path disconnects the Person. The callable returns
`connected`, `organizationPath`, and `primaryContact`.

### Link ExMail thread

The existing payload is valid:

```dart
{
  'threadId': threadRef.id,
  'personId': personRef.id,
}
```

The response also returns `senderEmail` and `senderEmailAdded`; `senderEmailAdded` is always `false` because manual linking does not modify contact identity.

## Required CSV commit correction

Replace:

```dart
if (status != 'ready') {
```

with:

```dart
if (status != 'ready' && status != 'ready_with_duplicates') {
```

Change the assignee argument to nullable if the new widget supports “Assign to
me” without choosing a record:

```dart
DocumentReference? assignedToRef
```

Only add the payload key when supplied:

```dart
if (assignedToRef != null)
  'assignedToRefPath': assignedToRef.path,
```

## Frontend relationship rule

Never directly update `commandPeople.organizationRef` or an Organization's
primary-contact fields from FlutterFlow. Use the callable so email ownership,
the Person relationship, and primary-contact cleanup remain atomic.

## Manual ExMail linking contract

`callLinkCommandEmailThreadToPerson` remains compatible with the callable arguments `threadId` and `personId`. A successful response confirms the conversation association only. `senderEmailAdded` is retained as `false` for backward-compatible response parsing; clients must not interpret linking as an email-address or Person/Organization relationship update.

The Connect-to-Person widget must use `commandEmailThreads.senderEmail` for the external correspondent. `senderAddress` is the internal Command mailbox and must not be presented as the sender being connected.
