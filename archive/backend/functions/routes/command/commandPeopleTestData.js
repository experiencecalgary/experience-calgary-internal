'use strict';

const admin = require('firebase-admin');
const { onCall, HttpsError } = require('firebase-functions/v2/https');

const ADMIN_UID = 'E26s7oE6aXNRrWaDpEO5hxz25jE3';
const PEOPLE_COLLECTION = 'commandPeople';
const USERS_COLLECTION = 'users';
const SEED_BATCH_ID = 'command_people_test_100';
const TEST_RECORD_COUNT = 100;

const FIRST_NAMES = [
  'Avery', 'Noah', 'Mia', 'Liam', 'Emma', 'Ethan', 'Olivia', 'Lucas', 'Sophia', 'Mason',
  'Amelia', 'Logan', 'Charlotte', 'Elijah', 'Harper', 'James', 'Evelyn', 'Benjamin', 'Isla', 'Henry',
];

const LAST_NAMES = [
  'Anderson', 'Bennett', 'Campbell', 'Chen', 'Davis', 'Edwards', 'Foster', 'Garcia', 'Hall', 'Irwin',
  'Johnson', 'Khan', 'Lewis', 'Martin', 'Nguyen', 'Patel', 'Robinson', 'Singh', 'Taylor', 'Wilson',
];

const ORGANIZATIONS = [
  'Bow River Events', 'Prairie Peak Hospitality', 'Calgary Summit Group', 'Rocky View Partners',
  'Chinook Creative Co.', 'Foothills Business Network', 'Heritage Park Consulting', 'East Village Collective',
  'Mission District Media', 'Beltline Hospitality Group', 'Inglewood Market Co.', 'Aspen Landing Partners',
  'Copperfield Community Group', 'Kensington Events', 'Signal Hill Services', 'Bridgeland Ventures',
  'Seton Business Alliance', 'Mahogany Hospitality', 'University District Group', 'West Springs Collective',
];

const STAGES = ['New', 'Opened', 'Engaged', 'Closing', 'Won', 'Lost'];

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function assertAdmin(request) {
  const uid = request.auth?.uid || '';
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Authentication is required.');
  }
  if (uid !== ADMIN_UID) {
    throw new HttpsError('permission-denied', 'Only the Experience Command admin can manage test data.');
  }
  return uid;
}

function phoneFor(index) {
  return `403555${String(1000 + index).slice(-4)}`;
}

function testPerson(index, adminRef, adminData) {
  const firstName = FIRST_NAMES[index % FIRST_NAMES.length];
  const lastName = LAST_NAMES[Math.floor(index / FIRST_NAMES.length) % LAST_NAMES.length];
  const suffix = String(index + 1).padStart(3, '0');
  const fullName = `${firstName} ${lastName} ${suffix}`;
  const email = `command.test.${suffix}@example.com`;
  const phone = phoneFor(index);
  const organizationName = ORGANIZATIONS[index % ORGANIZATIONS.length];
  const stage = STAGES[index % STAGES.length];
  const ownerName = clean(adminData.fullName) ||
    [clean(adminData.firstName), clean(adminData.lastName)].filter(Boolean).join(' ') ||
    clean(adminData.displayName) || clean(adminData.email) || 'Admin EC';
  const teamRepIds = unique([
    clean(adminData.repId),
    clean(adminData.programDirectorRepId),
    clean(adminData.directorRepId),
  ]);

  return {
    firstName,
    lastName: `${lastName} ${suffix}`,
    fullName,
    email,
    emailNormalized: email.toLowerCase(),
    phone,
    phoneNormalized: phone,
    organizationRef: null,
    organizationName,
    stage,
    estimatedValue: 500 + ((index * 375) % 14500),
    ownerRef: adminRef,
    ownerUid: ADMIN_UID,
    ownerName,
    assignedToRef: null,
    assignedToUid: '',
    assignedToName: '',
    teamRepIds,
    viewerUids: [ADMIN_UID],
    archived: false,
    isTestData: true,
    seedBatchId: SEED_BATCH_ID,
    seedSequence: index + 1,
  };
}

async function seedCommandPeopleTestDataService(request) {
  assertAdmin(request);
  const db = admin.firestore();
  const adminRef = db.collection(USERS_COLLECTION).doc(ADMIN_UID);
  const adminSnap = await adminRef.get();
  if (!adminSnap.exists) {
    throw new HttpsError('failed-precondition', 'The configured admin user document does not exist.');
  }

  const existing = await db.collection(PEOPLE_COLLECTION)
    .where('seedBatchId', '==', SEED_BATCH_ID)
    .limit(1)
    .get();
  if (!existing.empty) {
    throw new HttpsError(
      'already-exists',
      'This test-data batch already exists. Delete it before seeding again.'
    );
  }

  const adminData = adminSnap.data() || {};
  const now = admin.firestore.FieldValue.serverTimestamp();
  const batch = db.batch();

  for (let index = 0; index < TEST_RECORD_COUNT; index += 1) {
    const ref = db.collection(PEOPLE_COLLECTION).doc();
    batch.create(ref, {
      ...testPerson(index, adminRef, adminData),
      createdAt: now,
      updatedAt: now,
      createdByRef: adminRef,
      updatedByRef: adminRef,
    });
  }

  await batch.commit();
  return {
    ok: true,
    createdCount: TEST_RECORD_COUNT,
    seedBatchId: SEED_BATCH_ID,
    ownerUid: ADMIN_UID,
  };
}

async function deleteCommandPeopleTestDataService(request) {
  assertAdmin(request);
  const db = admin.firestore();
  let deletedCount = 0;

  while (true) {
    const snapshot = await db.collection(PEOPLE_COLLECTION)
      .where('seedBatchId', '==', SEED_BATCH_ID)
      .limit(400)
      .get();

    if (snapshot.empty) break;

    const batch = db.batch();
    snapshot.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    deletedCount += snapshot.size;
  }

  return {
    ok: true,
    deletedCount,
    seedBatchId: SEED_BATCH_ID,
  };
}

exports.seedCommandPeopleTestData = onCall(
  { region: 'us-central1', cors: true, timeoutSeconds: 120, memory: '256MiB' },
  seedCommandPeopleTestDataService
);

exports.deleteCommandPeopleTestData = onCall(
  { region: 'us-central1', cors: true, timeoutSeconds: 120, memory: '256MiB' },
  deleteCommandPeopleTestDataService
);
