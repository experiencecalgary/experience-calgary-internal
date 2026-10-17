# Experience Command Data Lifecycle

## Archive instead of delete

People, organizations, and library files use archive/restore workflows where possible. This preserves history and references.

## Actions, meetings, notes, and calls

These records are created and updated directly by FlutterFlow. Firestore rules remain the primary client-side enforcement layer.

## Email

Email threads and messages are retained as the communication record. Provider events update delivery and engagement metadata.

## Exchange

- Draft exchanges can be cancelled.
- Unused open/active links expire automatically.
- Completed request exchanges remain stored.
- Expiry disables public access; it does not delete files.
- File deletion is not automatic in Version 1.

## CSV imports

Imports follow validate → review → commit. Invalid rows are never committed. Duplicate handling must be explicit and reported in the commit summary.
