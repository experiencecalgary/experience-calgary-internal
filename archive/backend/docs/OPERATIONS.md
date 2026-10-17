# Operations

## Quick checks

- Confirm the frontend calls `us-central1`.
- Confirm `functions/entrypoint.js` is still the package entry point.
- Check Cloud Functions logs for the exact callable/HTTP name.
- Verify the authenticated user has a `users/{uid}` document and `userType == "rep"`.
- For team visibility, verify `repId`, `viewerUids`, and `teamRepIds`.
- For Action creation, use `callCreateCommandAction`; do not combine client Create Document and Update Document actions.
- Keep Action relationship selections as path Strings in component state, while final Firestore fields remain DocumentReferences.
- For stale lists, reset page tokens and reload page 1 rather than only refreshing a client query.
- For CSV commits, inspect `committed`, not output presence or `success`.
- For email, distinguish inbound parse, delivery events, unread state, and opens.

## Common failures

| Symptom | Check |
|---|---|
| Permission denied | Auth, user document, `userType`, record viewer/team metadata |
| Action wrapper returns assigned-user error | `assignedToRefPath` must be a valid active `users/{uid}` representative |
| Person/Organization Action is rejected | `relatedType` must match the nonempty relationship path |
| General Action carries a stale selection | Wrapper must blank both relationship paths when `relatedType == General` |
| Action name saves but reference is missing | Remove client Create/Update flow and path-to-reference conversion; use `createCommandAction` |
| New imports do not appear | Reset page state/tokens, call first page, rebuild |
| CSV success branch never runs | Condition must be `$.committed Is True` |
| Long CSV errors clip | Use the scrollable custom dialog |
| Search fails | Algolia secrets/index configuration and minimum two-character query |
| Email reply not attached | Reply token/inbound endpoint and thread existence |
| Delivery status stale | SendGrid Event Webhook configuration/signature |
| Team access stale | Access-sync triggers or scheduled repair |

## Action trigger responsibilities

- `createCommandAction` creates the complete Action, including relationship and initial access fields.
- `commandActionAccessSync` recalculates access metadata only.
- `commandActionCreated` creates a separate Connection and does not update the Action.
- `commandActionCompleted` creates the completion Connection when status first becomes `completed`.

## Safe maintenance

Use archive/restore instead of direct deletion where supported. Administrative repair or test-data functions are not general UI endpoints. Avoid running broad deployments that include rules unless rules are explicitly in scope.

## Documentation maintenance

Every backend PR that changes a callable name, request/response, schema, access rule, integration, schedule, or deployment requirement must update the corresponding document in `docs/`.

## Contact identity and ExMail checks

- Use `commandEmailIdentityIndex` to diagnose explicit contact email ownership; do not delete it as routine cleanup.
- Confirm `users.commandEmailAddress`, `commandEmailAddresses/{uid}`, and `commandEmailAliases/{localPart}` agree before diagnosing send failures.
- For an inbound thread, `senderEmail` is the external correspondent; `senderAddress` is the internal receiving mailbox.
- Manual Connect-to-Person should change only the thread Person association and existing Connection `personRef`. If a Person's email or Organization changes, treat it as a regression.
- An Action assignment `permission-denied` means the selected user is outside the authenticated rep's permitted self/team hierarchy.
