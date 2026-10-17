# Experience Command Search Architecture

## Function

`searchCommandRecords`

## Supported record types

- people
- organizations
- actions
- meetings
- email threads
- exchanges
- library files

## Rules

- Search runs server-side.
- Results are filtered by the authenticated user's ownership and team access.
- Results are capped and paginated.
- The initial implementation should favor predictable, indexed queries over complex full-text behavior.
- A dedicated search service may be introduced later only if Firestore-based search becomes insufficient.
