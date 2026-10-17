# Experience Command ExMail settings

## Source of truth

The authenticated user's `users/{uid}.commandEmailAddress` is the authoritative
mailbox address. It must match both `commandEmailAddresses/{uid}.address` and the
corresponding `commandEmailAliases/{localPart}.address`. ExMail fails closed when
those records conflict.

The settings callable never accepts an email-address input.

## Callable

`updateCommandEmailSettings`

Input:

```json
{
  "senderName": "Matt McBride",
  "signatureHtml": "<p>...</p>",
  "signatureText": "Matt McBride",
  "includeSignatureNew": true,
  "includeSignatureReplies": true
}
```

Saved user fields:

- `commandEmailSenderName`
- `commandEmailSignatureHtml`
- `commandEmailSignatureText`
- `commandEmailIncludeSignatureNew`
- `commandEmailIncludeSignatureReplies`
- `commandEmailSettingsUpdatedAt`
- `commandEmailSettingsUpdatedBy`

FlutterFlow displays `commandEmailAddress` read-only and must not append signatures
to submitted message bodies. The backend appends the signature exactly once.

## Reply ownership

A reply uses the thread owner's mailbox, sender name, and signature. The authenticated
user who performs the reply remains recorded in the message's `createdBy*` fields.

## Message snapshots

Outbound messages store `signatureApplied`, `signatureHtml`, and `signatureText`.
Thread and Connection previews continue to use the authored body without the signature.
