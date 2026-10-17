# Experience Command Deployment Runbook

## Before merge

1. Confirm the pull request is limited to the intended Command scope.
2. Confirm existing unrelated functions are unchanged.
3. Run syntax checks and available tests.
4. Review required secrets and Firestore indexes.
5. Confirm a production backup branch or Git tag exists.

## Backup

Current production backup branch:

`backup/pre-command-v1-2026-07-26`

Create a Git tag from `main` before final merge/deployment when using the local Git CLI.

## Merge

- Merge only after approval.
- Prefer squash merge for focused feature pull requests.
- Never merge a draft pull request.

## Deployment

Deploy only explicitly named functions when practical:

```bash
firebase deploy --only functions:functionNameA,functions:functionNameB
```

Do not deploy Firestore rules, Firestore indexes, or Storage rules from this repository.

- FlutterFlow owns Firestore rules and indexes.
- Firebase Console owns the live Storage rules.
- The repository rule files are informational only and may be stale.

Before manually changing Storage rules in Firebase Console:

1. Copy the complete current live rules.
2. Preserve every existing path and permission.
3. Add only the dedicated EC Exchange rule block.
4. Publish from Firebase Console.
5. Test all existing public and authenticated Storage workflows as well as Exchange.

## Verification

- Confirm existing app APIs still respond.
- Test new callable functions with an authorized test user.
- Test public Exchange links in an incognito browser.
- Confirm expired/cancelled links fail.
- Confirm direct access to Exchange storage paths is denied.
- Confirm public business images still load.
- Confirm user-owned uploads still work.
- Confirm recruiting video upload/read still works.
- Confirm the authenticated onboarding manual still opens.
- Review Cloud Logging for errors.

## Rollback

- Revert the merge commit or redeploy the backup commit.
- Restore individual existing function exports if a new export causes deployment trouble.
- For Storage rules, republish the saved pre-change live rules in Firebase Console.
