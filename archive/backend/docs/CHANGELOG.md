# Changelog

## 2026-07-29

- Added the authenticated `createCommandAction` callable as the shared production creation path for the Actions, Person, and Organization pages.
- Replaced the FlutterFlow Create Document followed by Update Document architecture with one backend write.
- Documented nullable frontend Person/Organization path inputs, empty-string normalization, and non-null Firestore DocumentReference fields.
- Documented exact Person, Organization, and General relationship behavior.
- Documented active representative assignee validation, authoritative name resolution, Edmonton `dueDateKey`, and the callable response contract.
- Clarified that `commandActionAccessSync` maintains access metadata only and `commandActionCreated` writes a separate Connection.
- Added the targeted deployment command for `createCommandAction`.
- No Firestore rules, Firestore indexes, Storage rules, or existing triggers were changed.

## 2026-07-28

- Added the repository documentation system and root index.
- Documented `functions/entrypoint.js` as the effective Cloud Functions entry point.
- Documented current Experience Command exports, collections, access metadata, email, listing/search, Library, Exchanges, and CSV import.
- Corrected the FlutterFlow CSV commit condition to `$.committed Is True`.
- Documented `completed` and `already_completed` as committed outcomes.
- Recorded configuration ownership: FlutterFlow manages Firestore rules/indexes; Storage rules are manually managed.
- No Firestore rules, Firestore indexes, or Storage rules were changed.

## 2026-07-31 — ExMail association and Action authorization alignment

- Changed manual ExMail thread-to-Person linking to association-only behavior.
- Preserved existing thread Organization fields during manual Person linking.
- Stopped manual linking from adding contact emails or writing email identity claims.
- Limited existing thread activity updates to `personRef`.
- Enforced the Action widget's self/direct-team assignee rule in `createCommandAction`.
- Added regression tests for ExMail link patch boundaries and numeric/string rep hierarchy comparisons.
- Updated architecture, schema, callable, FlutterFlow, security, email, identity, CSV, operations, and deployment documentation.
