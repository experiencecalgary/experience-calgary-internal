# Command Email System

## Data model

- Thread: `commandEmailThreads/{threadId}`
- Message: `commandEmailThreads/{threadId}/emailMessages/{messageId}`

Threads carry ownership/viewer access, related Person/Organization links, unread state, and latest-message metadata. Messages store inbound/outbound content and delivery state.

## Outbound

`sendCommandEmail` creates a thread/message and sends through SendGrid. `replyCommandEmail` adds a message to an existing accessible thread.

The sender uses the `connect.experiencecalgary.ca` mail domain. Replies use tokenized reply addressing so SendGrid Inbound Parse can resolve the thread.

## Inbound and events

- `receiveCommandEmail`: SendGrid Inbound Parse HTTP endpoint.
- `receiveCommandEmailEvents`: SendGrid Event Webhook HTTP endpoint.

The event webhook updates delivery-related state such as delivered, bounced, deferred, dropped, or spam-report events as implemented by the handler. Do not treat replies as opens. Message status and thread activity fields serve different purposes.

## Read/link operations

- `markCommandEmailThreadRead` applies the shared unread policy.
- `linkCommandEmailThreadToPerson` links an existing accessible thread.
- `linkCommandEmailThreadToOrganization` links an Organization.
- `unlinkCommandEmailThread` clears both links.

## Visibility

My Email uses thread ownership. Team Email uses `viewerUids` and excludes the owner on the frontend when showing the team-only view. Opening a thread marks it read under the current shared-read policy.

## Operational requirements

Keep SendGrid domain authentication, Inbound Parse, Event Webhook verification, and required Firebase secrets configured. Use `emailMessages` consistently; the old generic `messages` name must not be reintroduced.

## Mailbox settings and signatures

`users.commandEmailAddress` is authoritative and must match `commandEmailAddresses/{uid}` and the corresponding `commandEmailAliases/{localPart}` record. Settings are stored on the User document:

- `commandEmailSenderName`
- `commandEmailSignatureHtml`
- `commandEmailSignatureText`
- `commandEmailIncludeSignatureNew`
- `commandEmailIncludeSignatureReplies`

`updateCommandEmailSettings` cannot change the address. Signature HTML is sanitized and enabled signatures are appended server-side.

## Address-field contract

For inbound threads, `senderEmail` is the external correspondent. `senderAddress` and `replyAddress` are internal Command mailbox addresses. FlutterFlow sender displays and the Connect-to-Person component must use `senderEmail`.

## Manual Person linking

Manual `linkCommandEmailThreadToPerson` associates the conversation with a selected Person and propagates the Person reference to existing thread activity Connections. It preserves any Organization already linked to the thread. It does not add the sender address to the Person, claim an email identity, or create/change a Person/Organization relationship. Automatic inbound identity matching remains separate.
