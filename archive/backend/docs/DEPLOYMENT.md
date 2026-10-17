# Deployment

## Prerequisites

- Firebase CLI authenticated for project `experience-app-ce493`
- Node.js 22
- Dependencies installed in `functions/`
- Required Firebase secrets configured

## Entry point

`functions/package.json` declares:

```json
{ "main": "entrypoint.js", "engines": { "node": "22" } }
```

Do not change the entry point back to `index.js`; that would omit the isolated Experience Command exports.

## Recommended workflow

1. Start from updated `main`.
2. Create a feature branch.
3. Make scoped changes.
4. Review `git diff` and run relevant checks.
5. Commit and push.
6. Open a pull request and merge after review.
7. Deploy only the intended functions when practical.
8. Add a descriptive Git tag before material production changes when a rollback point is desired.

Example targeted deployment:

```bash
firebase deploy --only functions:functionNameA,functions:functionNameB
```

After merging the Command Action creation change:

```bash
git switch main
git pull origin main
firebase deploy --only functions:createCommandAction
```

The existing `commandActionAccessSync` and `commandActionCreated` triggers do not need redeployment when only the new callable or its documentation changes.

Full functions deployment:

```bash
cd functions
npm install
cd ..
firebase deploy --only functions
```

## Rules warning

Normal backend deployments in this project must leave `firestore.rules`, `firestore.indexes.json`, and `storage.rules` alone unless the deployment is explicitly intended to update those resources. FlutterFlow normally manages Firestore rules/indexes; Storage rules are manually managed.

## Rollback

A Git tag or prior commit is a source rollback point, not an automatic production rollback. Check out or revert to the intended code, review the diff, and redeploy the affected functions.

## Targeted deployment for ExMail linking and Action assignment

After merging the association-only ExMail and Action assignment authorization change, deploy these callable functions from the repository `functions` directory:

```bash
firebase deploy --only functions:linkCommandEmailThreadToPerson,functions:createCommandAction
```

Shared helper files are bundled automatically with their importing functions. Run `npm test` before deployment.

## Daily Overview and Call Leads deployment

After this pull request is merged, install dependencies and validate from the repository root, deploy the two required Connection indexes, then deploy only the changed functions:

```bash
cd functions
npm ci
npm test
cd ..
firebase deploy --only firestore:indexes
firebase deploy --only functions:getCommandDailyOverview,functions:listCommandCallQueue,functions:logCommandCallOutcome,functions:commandActionCreated
```

This deployment does not include Firestore rules or Storage rules.
