# Experience Calgary Internal — Preservation Status

Date: 2026-10-16. This repository is an **archive**, not a deployed application.

## Purpose
Preserve Experience Calgary Command Center, sales rep, ExMail, lead management, agreements, scheduling, reporting and Sara recruiting functionality for a future standalone internal application. No Next.js conversion is underway.

## Backend archive
`archive/backend/` contains source snapshots from `experiencecalgary/experience-calgary-backend`, including internal command and email libraries/routes, Sara modules, rep operations, recruiting, associated tests, documents, function entry points and Firebase configuration references. The archive was completed and verified on 2026-10-17 against all 208 function source, script, and test files and all 29 documentation files removed by the backend cleanup. This is a **reference archive**, not an independently deployable Firebase project.

**Source repository:** https://github.com/experiencecalgary/experience-calgary-backend

## FlutterFlow archive
The separate FlutterFlow internal-source ZIP was extracted from the user's full application export. It contains 249 source files plus its manifest/README. **It has not yet been uploaded to this GitHub repository.** Preserve the ZIP until the upload is verified. Do not assume this repository contains the complete internal FlutterFlow UI.

## Production safety
- The cleanup remains isolated on a review branch; no source deletion has been merged into the original backend default branch.
- No Firebase functions were deleted, redeployed, or moved to a new deployment owner.
- The live FlutterFlow app was not modified.
- Existing functions remain owned by the original production repository.

## Before removing FlutterFlow pages
1. Upload and verify the separate FlutterFlow internal-source ZIP or its extracted files here.
2. Audit shared imports and API endpoints, particularly `functions/index.js`, `functions/entrypoint.js`, Firestore rules, authentication and common utilities.
3. Keep production Cloud Functions and rules intact until separately reviewed.
4. Test customer, experience-business, and guest-list flows in FlutterFlow before publishing.

## Future development
When rebuilding internal operations, start by checking current production API contracts and secrets/configuration separately. Do not deploy this archive as-is.
