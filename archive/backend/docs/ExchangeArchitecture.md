# EC Exchange Architecture

## Purpose

EC Exchange securely replaces email attachments.

## Collections

- `commandExchanges`
- `commandExchangeItems`
- `commandLibraryFiles`
- `commandSettings/exchange`

## Request workflow

1. Rep creates draft.
2. Rep confirms.
3. Exchange becomes open.
4. Customer stages files through signed upload URLs.
5. Customer submits.
6. Exchange becomes completed and stops accepting uploads.

## Share workflow

1. Rep creates draft.
2. Rep selects or uploads files.
3. Rep confirms.
4. Exchange becomes active.
5. Customer downloads individual files.
6. Link expires after the configured duration.

## Security

- Public links contain an Exchange ID plus random secret token.
- Only a token hash is stored.
- Public HTTP functions validate token, state, and expiry.
- Storage remains private.
- Functions issue short-lived signed URLs.

## File library

- Personal files belong to one owner.
- Shared files are available to authorized Command users.
- Exchanges reference existing library files rather than duplicating Storage objects whenever possible.
