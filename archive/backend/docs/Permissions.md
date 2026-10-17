# Experience Command Permissions

## Access model

- Authentication is required for internal Experience Command operations.
- Users must have an active `users/{uid}` document with `userType == "rep"`.
- Record visibility is determined by ownership plus team access fields.
- Administrative settings updates are restricted by FlutterFlow-managed Firestore rules.

## Public EC Exchange

Public users never receive direct Firestore or Storage access.

Public Exchange HTTP functions must:

1. Validate the Exchange ID.
2. Hash and compare the secret token.
3. Confirm the Exchange is in an allowed state.
4. Confirm it has not expired.
5. Issue a short-lived signed Storage URL.

## Storage

- `businesses/**` remains publicly readable and not client-writable.
- `command/**` is denied through Firebase Storage rules.
- Cloud Functions and signed URLs provide all EC Exchange file access.
