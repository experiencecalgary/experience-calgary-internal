#!/usr/bin/env node

'use strict';

/**
 * One-time Firestore seed for EC Command actions.
 *
 * Copy this file to functions/scripts/seed-command-actions.js, then run:
 *   cd functions
 *   node scripts/seed-command-actions.js              # preview only
 *   node scripts/seed-command-actions.js --commit     # create 50 actions
 *
 * This intentionally calls the same service used by createCommandAction, so
 * seeded documents pass the production validation and creation path.
 *
 * From functions/scripts, run:
 *   node scripts/seed-command-actions.js --commit
 */

const admin = require('firebase-admin');
const {
  createCommandActionService,
} = require('../routes/command/createCommandAction');

const EXPECTED_PROJECT_ID = 'experience-app-ce493';
const ACTIONS_COLLECTION = 'commandActions';
const PEOPLE_COLLECTION = 'commandPeople';
const ORGANIZATIONS_COLLECTION = 'commandOrganizations';
const USERS_COLLECTION = 'users';
const SEED_BATCH_ID = 'command-actions-2026-07-29-v1';

const USER_IDS = [
  'KdlIrl5OxgcYo93ENEwsUXBo3c13',
  'vqkodIwxVVaNtkLHrNhVxSOrId22',
  'E26s7oE6aXNRrWaDpEO5hxz25jE3',
];

const CREATOR_USER_ID = 'E26s7oE6aXNRrWaDpEO5hxz25jE3';

const TYPES = ['Call', 'Email', 'Follow Up', 'Task'];
const PRIORITIES = ['High', 'Medium', 'Low'];
const RELATION_TYPES = ['Person', 'Organization', 'General'];

const TITLES = {
  Call: [
    'Discovery call',
    'Check-in call',
    'Partnership call',
    'Confirm next steps',
    'Follow-up phone call',
  ],
  Email: [
    'Send introduction email',
    'Email proposal',
    'Send event details',
    'Confirm availability by email',
    'Send partnership overview',
  ],
  'Follow Up': [
    'Follow up on conversation',
    'Follow up after meeting',
    'Confirm decision timeline',
    'Check proposal status',
    'Reconnect on next steps',
  ],
  Task: [
    'Prepare account notes',
    'Review opportunity details',
    'Update contact information',
    'Prepare meeting brief',
    'Complete internal review',
  ],
};

const DESCRIPTIONS = {
  Call: 'Call to confirm priorities, answer questions, and agree on the next step.',
  Email: 'Send a concise email with the relevant information and a clear next action.',
  'Follow Up': 'Follow up on the previous conversation and record the outcome in EC Command.',
  Task: 'Complete the internal task and update the related record when finished.',
};

const SCHEDULE = [
  ...Array.from({ length: 7 }, (_, index) => ({
    dueDateKey: index % 2 === 0 ? '2026-07-27' : '2026-07-28',
    status: 'open',
  })),
  ...Array.from({ length: 12 }, () => ({
    dueDateKey: '2026-07-29',
    status: 'open',
  })),
  ...Array.from({ length: 10 }, () => ({
    dueDateKey: '2026-07-30',
    status: 'open',
  })),
  ...Array.from({ length: 4 }, () => ({
    dueDateKey: '2026-08-03',
    status: 'open',
  })),
  ...Array.from({ length: 3 }, () => ({
    dueDateKey: '2026-08-04',
    status: 'open',
  })),
  ...Array.from({ length: 3 }, () => ({
    dueDateKey: '2026-08-05',
    status: 'open',
  })),
  ...Array.from({ length: 3 }, () => ({
    dueDateKey: '2026-08-06',
    status: 'open',
  })),
  ...Array.from({ length: 3 }, () => ({
    dueDateKey: '2026-08-07',
    status: 'open',
  })),
  ...Array.from({ length: 5 }, (_, index) => ({
    dueDateKey: index < 2 ? '2026-07-28' : '2026-07-29',
    status: 'completed',
  })),
];

const LOCAL_DUE_TIMES = [
  '09:00',
  '10:00',
  '11:00',
  '12:30',
  '14:00',
  '15:30',
  '16:30',
];

function getDisplayName(data, fallback) {
  const directName = [
    data.displayName,
    data.fullName,
    data.name,
    data.userName,
  ].find((value) => typeof value === 'string' && value.trim());

  if (directName) {
    return directName.trim();
  }

  const combinedName = [data.firstName, data.lastName]
    .filter((value) => typeof value === 'string' && value.trim())
    .join(' ')
    .trim();

  return combinedName || fallback;
}

function getPersonName(data, fallback) {
  return getDisplayName(data, fallback);
}

function getOrganizationName(data, fallback) {
  const name = [data.name, data.organizationName, data.fullName].find(
    (value) => typeof value === 'string' && value.trim(),
  );
  return name ? name.trim() : fallback;
}

function makeDueTimestamp(dueDateKey, index) {
  const time = LOCAL_DUE_TIMES[index % LOCAL_DUE_TIMES.length];
  // Edmonton is UTC-6 on all dates used by this July/August 2026 test batch.
  const parsed = new Date(`${dueDateKey}T${time}:00-06:00`);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid due date: ${dueDateKey} ${time}`);
  }

  return admin.firestore.Timestamp.fromDate(parsed);
}

async function loadUsers(db) {
  const snapshots = await Promise.all(
    USER_IDS.map((userId) => db.collection(USERS_COLLECTION).doc(userId).get()),
  );

  return snapshots.map((snapshot) => {
    if (!snapshot.exists) {
      throw new Error(`Required user does not exist: ${snapshot.ref.path}`);
    }

    return {
      id: snapshot.id,
      ref: snapshot.ref,
      name: getDisplayName(snapshot.data(), snapshot.id),
    };
  });
}

async function loadRelatedRecords(db, collectionName, nameResolver) {
  const snapshot = await db.collection(collectionName).limit(40).get();
  const records = snapshot.docs
    .filter((document) => document.data().archived !== true)
    .map((document) => ({
      ref: document.ref,
      name: nameResolver(document.data(), document.id),
    }))
    .filter((record) => record.name);

  if (records.length === 0) {
    throw new Error(`No usable records found in ${collectionName}.`);
  }

  return records;
}

function buildActions({ users, people, organizations }) {
  const creator = users.find((user) => user.id === CREATOR_USER_ID);

  if (!creator) {
    throw new Error(`Creator user was not loaded: ${CREATOR_USER_ID}`);
  }

  return SCHEDULE.map((schedule, index) => {
    const actionType = TYPES[index % TYPES.length];
    const relatedType = RELATION_TYPES[index % RELATION_TYPES.length];
    const priority = PRIORITIES[index % PRIORITIES.length];
    const assignedUser = users[index % users.length];
    const titleRoot = TITLES[actionType][
      Math.floor(index / TYPES.length) % TITLES[actionType].length
    ];
    const dueAt = makeDueTimestamp(schedule.dueDateKey, index);
    const input = {
      title: `[TEST 2026-07-29 #${String(index + 1).padStart(2, '0')}] ${titleRoot}`,
      description: DESCRIPTIONS[actionType],
      actionType,
      priority,
      dueAt: dueAt.toDate().toISOString(),
      relatedType,
      assignedToRefPath: assignedUser.ref.path,
      personRefPath: '',
      organizationRefPath: '',
    };

    if (relatedType === 'Person') {
      const person = people[index % people.length];
      input.personRefPath = person.ref.path;
    } else if (relatedType === 'Organization') {
      const organization = organizations[index % organizations.length];
      input.organizationRefPath = organization.ref.path;
    }

    return {
      assignedToName: assignedUser.name,
      dueDateKey: schedule.dueDateKey,
      status: schedule.status,
      input,
    };
  });
}

function printSummary(actions) {
  const countBy = (selector) =>
    actions.reduce((totals, action) => {
      const key = selector(action);
      totals[key] = (totals[key] || 0) + 1;
      return totals;
    }, {});

  console.table({
    total: { count: actions.length },
    open: {
      count: actions.filter((action) => action.status === 'open').length,
    },
    completed: {
      count: actions.filter((action) => action.status === 'completed')
        .length,
    },
  });
  console.log('By due date:', countBy((action) => action.dueDateKey));
  console.log('By action type:', countBy((action) => action.input.actionType));
  console.log('By related type:', countBy((action) => action.input.relatedType));
  console.log('By assignee:', countBy((action) => action.assignedToName));
}

async function main() {
  const shouldCommit = process.argv.includes('--commit');

  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId: EXPECTED_PROJECT_ID,
  });

  const db = admin.firestore();
  const detectedProjectId = admin.app().options.projectId;

  if (detectedProjectId !== EXPECTED_PROJECT_ID) {
    throw new Error(
      `Refusing to run against project "${detectedProjectId}". Expected "${EXPECTED_PROJECT_ID}".`,
    );
  }

  const [users, people, organizations] = await Promise.all([
    loadUsers(db),
    loadRelatedRecords(db, PEOPLE_COLLECTION, getPersonName),
    loadRelatedRecords(db, ORGANIZATIONS_COLLECTION, getOrganizationName),
  ]);

  const actions = buildActions({ users, people, organizations });

  const existingSeed = await db
    .collection(ACTIONS_COLLECTION)
    .where('title', '==', actions[0].input.title)
    .limit(1)
    .get();

  if (!existingSeed.empty) {
    throw new Error(
      `Seed batch "${SEED_BATCH_ID}" already exists. No documents were written.`,
    );
  }

  printSummary(actions);

  if (!shouldCommit) {
    console.log(
      '\nPreview complete. Run again with --commit to create these 50 actions.',
    );
    return;
  }

  const createdPaths = [];

  // Small chunks keep the one-time script quick without creating a burst of
  // hundreds of simultaneous reads.
  for (let start = 0; start < actions.length; start += 5) {
    const chunk = actions.slice(start, start + 5);
    const results = await Promise.all(
      chunk.map((action) =>
        createCommandActionService({
          auth: { uid: CREATOR_USER_ID },
          data: action.input,
        }),
      ),
    );

    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      const action = chunk[index];
      createdPaths.push(result.actionPath);

      if (action.status === 'completed') {
        const completionDate = new Date(
          new Date(action.input.dueAt).getTime() + 30 * 60 * 1000,
        );

        await db.doc(result.actionPath).update({
          status: 'completed',
          completedAt: admin.firestore.Timestamp.fromDate(completionDate),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedByRef: db.collection(USERS_COLLECTION).doc(CREATOR_USER_ID),
        });
      }
    }
  }

  console.log(`\nCreated ${createdPaths.length} actions successfully.`);
  console.log(`Seed batch ID: ${SEED_BATCH_ID}`);
  console.log('First document:', createdPaths[0]);
  console.log(
    'Allow several seconds for the existing access and activity triggers to finish.',
  );
}

main().catch((error) => {
  console.error('\nSeed failed:', error.message);
  process.exitCode = 1;
});
