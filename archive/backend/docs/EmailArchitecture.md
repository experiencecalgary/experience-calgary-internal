# Experience Command Email Architecture

## Transport

SendGrid handles outbound delivery, inbound parsing, and delivery-event webhooks.

## Presentation

Outgoing mail uses one server-side HTML wrapper with:

- clean responsive layout
- Experience Calgary branding
- optional EC Exchange callout
- automatic user signature
- standard footer

FlutterFlow supplies message content. It does not generate the final HTML document.

## Records

- `commandEmailThreads`
- `commandEmailThreads/{threadId}/messages`
- `commandConnections`

## Access

Threads include owner and team visibility fields. Linking and unlinking contacts is performed through authorized Cloud Functions.

## Reliability

Inbound and event webhook handlers must remain idempotent. Existing ExMail behavior must not be replaced during unrelated Command work.
