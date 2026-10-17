'use strict';

const crypto = require('crypto');
const admin = require('firebase-admin');
const { assignmentActor, assertRecordAssignment } = require('./commandRecordAssignment');
const { HttpsError } = require('firebase-functions/v2/https');
const {
  requireAuth,
  requireCommandAccess,
  isPlatformAdminUser,
} = require('./commandPersonUtils');
const {
  buildCommandAccessMetadata,
} = require('./commandAccessMetadata');
const { resolveCommandLeadList } = require('./commandLeadLists');
const {
  identityRef,
  sameRef,
  syncEmailIdentityClaims,
} = require('./commandEmailIdentity');

const MAX_ROWS = 250;
const PEOPLE = 'commandPeople';
const ORGANIZATIONS = 'commandOrganizations';
const LEADS = 'commandLeads';
const CONNECTIONS = 'commandConnections';
const IMPORTS = 'commandCsvImports';
const MAX_HEADERS = 60;
const PROCESSING_LEASE_MS = 15 * 60 * 1000;
const TEMPLATES = Object.freeze({
  people: ['firstName', 'lastName', 'email', 'phone', 'organizationName', 'estimatedValue'],
  organizations: ['name', 'email', 'phone', 'address', 'city', 'province', 'postalCode', 'estimatedValue'],
});

const TARGET_FIELDS = Object.freeze([
  'firstName', 'lastName', 'fullName', 'personEmail', 'personPhone',
  'organizationName', 'organizationEmail', 'organizationPhone', 'website',
  'industry', 'address', 'city', 'province', 'postalCode', 'leadName',
  'leadType', 'source', 'estimatedValue', 'notes',
]);
const HEADER_ALIASES = Object.freeze({
  firstname: 'firstName', givenname: 'firstName', first: 'firstName',
  lastname: 'lastName', surname: 'lastName', last: 'lastName',
  fullname: 'fullName', contactname: 'fullName', person: 'fullName', contact: 'fullName', customername: 'fullName',
  email: 'personEmail', emailaddress: 'personEmail', contactemail: 'personEmail', personemail: 'personEmail',
  phone: 'personPhone', phonenumber: 'personPhone', mobile: 'personPhone', cellphone: 'personPhone', contactphone: 'personPhone',
  company: 'organizationName', companyname: 'organizationName', organization: 'organizationName', organizationname: 'organizationName', business: 'organizationName', businessname: 'organizationName',
  organizationemail: 'organizationEmail', companyemail: 'organizationEmail', businessemail: 'organizationEmail', generalemail: 'organizationEmail',
  organizationphone: 'organizationPhone', companyphone: 'organizationPhone', businessphone: 'organizationPhone', officephone: 'organizationPhone',
  website: 'website', url: 'website', companywebsite: 'website', industry: 'industry', sector: 'industry',
  address: 'address', streetaddress: 'address', companyaddress: 'address', city: 'city', municipality: 'city', province: 'province', state: 'province', postalcode: 'postalCode', zipcode: 'postalCode', zip: 'postalCode',
  leadname: 'leadName', opportunityname: 'leadName', leadtype: 'leadType', recordtype: 'leadType', source: 'source', leadsource: 'source',
  estimatedvalue: 'estimatedValue', value: 'estimatedValue', dealvalue: 'estimatedValue', amount: 'estimatedValue',
  notes: 'notes', note: 'notes', comments: 'notes', description: 'notes',
});

const clean = (value) => typeof value === 'string' ? value.trim() : '';
const whitespace = (value) => clean(value).replace(/\s+/g, ' ');
const email = (value) => clean(value).toLowerCase();
const phone = (value) => clean(value).replace(/\D/g, '');
const nameKey = (value) => whitespace(value).toLowerCase();
const validEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const unique = (values) => [...new Set(values.filter(Boolean))];
const deterministicId = (...parts) => crypto.createHash('sha256')
  .update(parts.join(':')).digest('hex').slice(0, 32);

function rowNumber(index) {
  return index + 3; // Header is row 1; template instructions are row 2.
}

function parseAmount(value, errors) {
  if (value === null || value === undefined || clean(String(value)) === '') return 0;
  const amount = Number(String(value).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(amount) || amount < 0) {
    errors.push('Estimated value must be a positive number or blank.');
    return 0;
  }
  return amount;
}

function validateHeaders(headers, recordType) {
  const expected = TEMPLATES[recordType];
  if (!Array.isArray(headers) || headers.length !== expected.length ||
      headers.some((header, index) => clean(header) !== expected[index])) {
    return {
      status: 'invalid_template',
      message: `This file does not match the ${recordType === 'people' ? 'People' : 'Organizations'} CSV template. Download the current template and do not rename, reorder, add, or remove columns.`,
    };
  }
  return null;
}

function normalizeRows(rawRows, recordType) {
  if (!Array.isArray(rawRows) || rawRows.length < 1) {
    throw new HttpsError('invalid-argument', 'The CSV must contain at least one data row.');
  }
  if (rawRows.length > MAX_ROWS) {
    throw new HttpsError('invalid-argument', `A CSV import may contain no more than ${MAX_ROWS} data rows.`);
  }

  return rawRows.map((raw, index) => {
    const row = raw && typeof raw === 'object' ? raw : {};
    const errors = [];
    const normalizedEmail = email(row.email);
    const normalizedPhone = phone(row.phone);

    if (!normalizedEmail && !normalizedPhone) {
      errors.push('Enter an email address or phone number.');
    }
    if (normalizedEmail && !validEmail(normalizedEmail)) {
      errors.push('Enter a valid email address.');
    }
    if (clean(row.phone) && normalizedPhone.length !== 10) {
      errors.push('Phone numbers must contain exactly 10 digits.');
    }

    if (recordType === 'people') {
      const firstName = whitespace(row.firstName);
      const lastName = whitespace(row.lastName);
      if (!firstName) errors.push('First name is required.');
      if (firstName.length > 100) errors.push('First name must be 100 characters or fewer.');
      if (lastName.length > 100) errors.push('Last name must be 100 characters or fewer.');
      if (normalizedEmail.length > 254) errors.push('Email must be 254 characters or fewer.');
      const organizationName = whitespace(row.organizationName);
      if (organizationName.length > 200) errors.push('Organization name must be 200 characters or fewer.');
      return {
        index,
        rowNumber: rowNumber(index),
        errors,
        duplicateReasons: [],
        data: {
          firstName,
          lastName,
          fullName: [firstName, lastName].filter(Boolean).join(' '),
          fullNameNormalized: nameKey([firstName, lastName].filter(Boolean).join(' ')),
          email: clean(row.email),
          emailNormalized: normalizedEmail,
          additionalEmails: [],
          additionalEmailsNormalized: [],
          phone: normalizedPhone,
          phoneNormalized: normalizedPhone,
          organizationName,
          organizationKey: nameKey(organizationName),
          estimatedValue: parseAmount(row.estimatedValue, errors),
          stage: 'New',
          archived: false,
        },
      };
    }

    const organization = whitespace(row.name);
    if (!organization) errors.push('Organization name is required.');
    if (organization.length > 200) errors.push('Organization name must be 200 characters or fewer.');
    if (normalizedEmail.length > 254) errors.push('Email must be 254 characters or fewer.');
    const fields = {
      address: whitespace(row.address),
      city: whitespace(row.city),
      province: whitespace(row.province),
      postalCode: whitespace(row.postalCode),
    };
    if (fields.address.length > 300) errors.push('Address must be 300 characters or fewer.');
    if (fields.city.length > 120) errors.push('City must be 120 characters or fewer.');
    if (fields.province.length > 120) errors.push('Province must be 120 characters or fewer.');
    if (fields.postalCode.length > 30) errors.push('Postal code must be 30 characters or fewer.');
    return {
      index,
      rowNumber: rowNumber(index),
      errors,
      duplicateReasons: [],
      data: {
        organization,
        organizationNormalized: nameKey(organization),
        email: clean(row.email),
        emailNormalized: normalizedEmail,
        additionalEmails: [],
        additionalEmailsNormalized: [],
        phone: normalizedPhone,
        phoneNormalized: normalizedPhone,
        ...fields,
        estimatedValue: parseAmount(row.estimatedValue, errors),
        stage: 'New',
        archived: false,
      },
    };
  });
}

function flagFileDuplicates(entries, recordType) {
  const seen = { email: new Map(), phone: new Map(), name: new Map() };
  for (const entry of entries) {
    const keys = [
      ['email', entry.data.emailNormalized],
      ['phone', entry.data.phoneNormalized],
      ...(recordType === 'organizations'
        ? [['name', entry.data.organizationNormalized]]
        : []),
    ];
    for (const [field, value] of keys) {
      if (!value) continue;
      const earlier = seen[field].get(value);
      if (earlier) {
        entry.duplicateReasons.push({
          field,
          reason: field === 'name'
            ? (recordType === 'people' ? 'exact_name' : 'exact_organization')
            : `exact_${field}`,
          source: 'csv',
          matchesRowNumber: earlier.rowNumber,
        });
      } else {
        seen[field].set(value, entry);
      }
    }
  }
}

async function queryValues(db, collection, field, values) {
  const found = new Map();
  const list = unique(values);
  for (let offset = 0; offset < list.length; offset += 10) {
    const snap = await db.collection(collection)
      .where(field, 'in', list.slice(offset, offset + 10)).get();
    for (const doc of snap.docs) {
      if (doc.data()?.archived === true) continue;
      const value = clean(doc.data()?.[field]);
      if (!found.has(value)) found.set(value, []);
      found.get(value).push(doc);
    }
  }
  return found;
}

async function addDatabaseFindings(db, entries, recordType, importId) {
  const collection = recordType === 'people' ? PEOPLE : ORGANIZATIONS;
  const nameField = recordType === 'people'
    ? 'fullNameNormalized'
    : 'organizationNormalized';
  const [emails, phones, names] = await Promise.all([
    queryValues(db, collection, 'emailNormalized', entries.map((entry) => entry.data.emailNormalized)),
    queryValues(db, collection, 'phoneNormalized', entries.map((entry) => entry.data.phoneNormalized)),
    queryValues(db, collection, nameField, entries.map((entry) => entry.data[nameField])),
  ]);

  const hasOtherImport = (map, value) =>
    (map.get(value) || []).some((doc) => clean(doc.data()?.importBatchId) !== importId);

  for (const entry of entries) {
    if (entry.data.emailNormalized && hasOtherImport(emails, entry.data.emailNormalized)) {
      entry.duplicateReasons.push({ field: 'email', reason: 'exact_email', source: 'database' });
    }
    if (entry.data.phoneNormalized && hasOtherImport(phones, entry.data.phoneNormalized)) {
      entry.duplicateReasons.push({ field: 'phone', reason: 'exact_phone', source: 'database' });
    }
    if (
      recordType === 'organizations' &&
      entry.data[nameField] &&
      hasOtherImport(names, entry.data[nameField])
    ) {
      entry.duplicateReasons.push({
        field: 'name',
        reason: 'exact_organization',
        source: 'database',
      });
    }
  }

  if (recordType === 'people') {
    const organizations = await queryValues(
      db, ORGANIZATIONS, 'organizationNormalized',
      entries.map((entry) => entry.data.organizationKey)
    );
    for (const entry of entries) {
      const matches = organizations.get(entry.data.organizationKey) || [];
      if (entry.duplicateReasons.length > 0 || !entry.data.organizationKey) {
        entry.data.organizationRef = null;
      } else if (matches.length === 1) {
        entry.data.organizationRef = matches[0].ref;
        entry.data.organizationName = clean(matches[0].data()?.organization) || entry.data.organizationName;
      } else if (matches.length > 1) {
        entry.errors.push('Organization name matches more than one existing organization.');
      } else {
        entry.data.organizationRef = null;
        entry.data.importedOrganizationName = entry.data.organizationName;
        entry.data.organizationName = '';
      }
      delete entry.data.organizationKey;
    }
  }

  const entriesWithEmail = entries.filter((entry) => entry.data.emailNormalized);
  const uniqueEmails = unique(
    entriesWithEmail.map((entry) => entry.data.emailNormalized)
  );
  const claimRefs = uniqueEmails.map((value) => identityRef(db, value));
  const claimSnapshots = claimRefs.length ? await db.getAll(...claimRefs) : [];
  const claimsByEmail = new Map(
    claimSnapshots.map((snapshot, index) => [
      uniqueEmails[index],
      snapshot.exists ? snapshot.data() || {} : null,
    ])
  );

  entriesWithEmail.forEach((entry) => {
    const claim = claimsByEmail.get(entry.data.emailNormalized);
    if (!claim) return;
    const targetRef = db.collection(collection).doc(
      importedDocumentId(importId, entry.index)
    );
    const sameTypeRef = recordType === 'people'
      ? claim.personRef
      : claim.organizationRef;
    const crossTypeConflict = recordType === 'people'
      ? claim.organizationRef &&
        !sameRef(claim.organizationRef, entry.data.organizationRef)
      : Boolean(claim.personRef);

    if ((sameTypeRef && !sameRef(sameTypeRef, targetRef)) || crossTypeConflict) {
      entry.duplicateReasons.push({
        field: 'email',
        reason: 'email_identity_conflict',
        source: 'database',
      });
    }
  });
}

function publicErrors(entries) {
  return entries.filter((entry) => entry.errors.length).map((entry) => ({
    rowNumber: entry.rowNumber,
    errors: unique(entry.errors),
    message: `Row ${entry.rowNumber}: ${unique(entry.errors).join(' ')}`,
  }));
}

function publicDuplicates(entries) {
  return entries.filter((entry) => entry.duplicateReasons.length > 0).map((entry) => ({
    rowNumber: entry.rowNumber,
    reasons: entry.duplicateReasons,
  }));
}

function batchId(uid, recordType, headers, rows) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ uid, recordType, headers, rows }))
    .digest('hex');
}

function importedDocumentId(importId, index) {
  return crypto.createHash('sha256')
    .update(`${importId}:${index}`)
    .digest('hex')
    .slice(0, 32);
}

function resultPayload(recordType, entries, id) {
  const errors = publicErrors(entries);
  const duplicates = publicDuplicates(entries);
  const duplicateRows = new Set(duplicates.map((entry) => entry.rowNumber));
  const readyCount = entries.filter(
    (entry) => entry.errors.length === 0 && !duplicateRows.has(entry.rowNumber)
  ).length;
  const status = errors.length
    ? 'errors'
    : duplicates.length
      ? 'ready_with_duplicates'
      : 'ready';
  const message = errors.length
    ? `The CSV has ${errors.length} invalid ${errors.length === 1 ? 'row' : 'rows'} that must be corrected before importing.`
    : duplicates.length
      ? `${readyCount} ready to import, ${duplicates.length} skipped as ${duplicates.length === 1 ? 'duplicate' : 'duplicates'}.`
      : `All ${entries.length} ${recordType} rows passed validation and are ready to import.`;

  return {
    ok: true,
    status,
    isValid: errors.length === 0,
    recordType,
    totalCount: entries.length,
    readyCount,
    errorCount: errors.length,
    duplicateCount: duplicates.length,
    skippedCount: duplicates.length,
    importBatchId: id,
    message,
    errorMessage: errors.length
      ? [message, ...errors.map((error) => error.message)].join('\n')
      : '',
    errors,
    duplicateRows: duplicates,
  };
}

async function validate(db, uid, recordType, headers, rows) {
  if (!TEMPLATES[recordType]) {
    throw new HttpsError('invalid-argument', 'recordType must be people or organizations.');
  }
  const headerError = validateHeaders(headers, recordType);
  if (headerError) return { headerError };
  const entries = normalizeRows(rows, recordType);
  const id = batchId(uid, recordType, headers, rows);
  flagFileDuplicates(entries, recordType);
  await addDatabaseFindings(db, entries, recordType, id);
  return { entries, payload: resultPayload(recordType, entries, id) };
}

async function actor(request) {
  const db = admin.firestore();
  const uid = requireAuth(request);
  const access = await requireCommandAccess(db, uid);
  return { db, uid, ...access };
}

async function validateCommandCsvImportService(request) {
  const { db, uid } = await actor(request);
  try {
    const recordType = clean(request.data?.recordType);
    const checked = await validate(db, uid, recordType, request.data?.headers, request.data?.rows);
    if (checked.headerError) {
      return {
        ok: false,
        isValid: false,
        recordType,
        totalCount: Array.isArray(request.data?.rows) ? request.data.rows.length : 0,
        readyCount: 0,
        errorCount: 0,
        importBatchId: '',
        errorMessage: checked.headerError.message,
        ...checked.headerError,
      };
    }
    return checked.payload;
  } catch (error) {
    if (error instanceof HttpsError && error.code === 'invalid-argument') {
      const message = error.message || 'The CSV is invalid.';
      return {
        ok: false,
        status: message.includes(`more than ${MAX_ROWS}`) ? 'too_many_rows' : 'errors',
        isValid: false,
        recordType: clean(request.data?.recordType),
        totalCount: Array.isArray(request.data?.rows) ? request.data.rows.length : 0,
        readyCount: 0,
        errorCount: 1,
        importBatchId: '',
        message,
        errorMessage: message,
        errors: [{ rowNumber: 0, errors: [message], message }],
      };
    }
    if (error instanceof HttpsError) throw error;
    console.error('CSV validation failed', error);
    return { ok: false, status: 'system_error', isValid: false, message: 'The CSV could not be validated. Please try again.', errorMessage: 'The CSV could not be validated. Please try again.' };
  }
}

async function resolveAssignee(db, actorRef, actorData, path) {
  const assignedPath = clean(path) || actorRef.path;
  const parts = assignedPath.split('/').filter(Boolean);
  if (parts.length !== 2 || parts[0] !== 'users') {
    throw new HttpsError('invalid-argument', 'assignedToRefPath must use users/{documentId}.');
  }
  const ref = db.doc(assignedPath);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.active === false || !clean(snap.data()?.repId)) {
    throw new HttpsError('failed-precondition', 'The selected representative is unavailable.');
  }
  await assertRecordAssignment(db, await assignmentActor(db, actorRef.id, actorData), null, ref);
  return ref;
}

async function commitCommandCsvImportService(request) {
  const { db, uid, userRef, userData } = await actor(request);
  const recordType = clean(request.data?.recordType);
  const requestedBatchId = clean(request.data?.importBatchId);
  if (!/^[a-f0-9]{64}$/.test(requestedBatchId)) {
    throw new HttpsError('invalid-argument', 'A valid importBatchId is required.');
  }
  const importRef = db.collection(IMPORTS).doc(requestedBatchId);
  const priorImport = await importRef.get();
  if (priorImport.exists && priorImport.data()?.status === 'completed') {
    const prior = priorImport.data() || {};
    if (prior.ownerUid !== uid || prior.recordType !== recordType) {
      throw new HttpsError('permission-denied', 'This import batch does not belong to you.');
    }
    return {
      ok: true,
      status: 'already_completed',
      committed: true,
      recordType,
      createdCount: Number(prior.createdCount || 0),
      skippedCount: Number(prior.skippedCount || prior.duplicateCount || 0),
      failedCount: 0,
      duplicateCount: Number(prior.duplicateCount || prior.skippedCount || 0),
      duplicateRows: Array.isArray(prior.duplicateRows) ? prior.duplicateRows : [],
      importBatchId: importRef.id,
      message: prior.message || 'This CSV was already imported successfully.',
    };
  }
  const checked = await validate(db, uid, recordType, request.data?.headers, request.data?.rows);
  if (checked.headerError) {
    throw new HttpsError('failed-precondition', checked.headerError.message);
  }
  if (!checked.payload.isValid) {
    throw new HttpsError('failed-precondition', checked.payload.message, checked.payload);
  }
  if (requestedBatchId !== checked.payload.importBatchId) {
    throw new HttpsError('failed-precondition', 'The CSV changed after validation. Validate it again.');
  }

  const assignedToRef = await resolveAssignee(
    db, userRef, userData, request.data?.assignedToRefPath
  );
  const access = await buildCommandAccessMetadata(db, {
    actorRef: userRef,
    ownerRef: userRef,
    assignedToRef,
  });
  const requestedLeadListId = clean(request.data?.leadListId);
  const leadList = requestedLeadListId
    ? await resolveCommandLeadList(db, uid, userData, requestedLeadListId)
    : null;

  const rawRowAssignments = request.data?.rowAssignments;
  if (rawRowAssignments !== undefined && !Array.isArray(rawRowAssignments)) {
    throw new HttpsError('invalid-argument', 'rowAssignments must be a list.');
  }
  const knownRowNumbers = new Set(checked.entries.map((entry) => entry.rowNumber));
  const assignmentPathByRow = new Map();
  for (const raw of rawRowAssignments || []) {
    const row = raw && typeof raw === 'object' ? raw : {};
    const rowNumberValue = Number(row.rowNumber);
    if (!Number.isInteger(rowNumberValue) || !knownRowNumbers.has(rowNumberValue)) {
      throw new HttpsError(
        'invalid-argument',
        'Each row assignment must reference a row from the validated CSV.'
      );
    }
    if (assignmentPathByRow.has(rowNumberValue)) {
      throw new HttpsError(
        'invalid-argument',
        `Row ${rowNumberValue} has more than one assignment override.`
      );
    }
    assignmentPathByRow.set(
      rowNumberValue,
      clean(row.assignedToRefPath) || userRef.path
    );
  }

  const uniqueAssignmentPaths = unique([...assignmentPathByRow.values()]);
  const assigneeByPath = new Map();
  for (const assignedPath of uniqueAssignmentPaths) {
    assigneeByPath.set(
      assignedPath,
      await resolveAssignee(db, userRef, userData, assignedPath)
    );
  }
  const accessByRow = new Map();
  for (const [rowNumberValue, assignedPath] of assignmentPathByRow.entries()) {
    accessByRow.set(
      rowNumberValue,
      await buildCommandAccessMetadata(db, {
        actorRef: userRef,
        ownerRef: userRef,
        assignedToRef: assigneeByPath.get(assignedPath),
      })
    );
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  const collection = recordType === 'people' ? PEOPLE : ORGANIZATIONS;
  const importableEntries = checked.entries.filter(
    (entry) => entry.errors.length === 0 && entry.duplicateReasons.length === 0
  );
  const duplicateEntries = checked.entries.filter(
    (entry) => entry.duplicateReasons.length > 0
  );
  const recordRefs = importableEntries.map((entry) =>
    db.collection(collection).doc(importedDocumentId(importRef.id, entry.index))
  );
  const claimEntries = importableEntries
    .map((entry, entryIndex) => ({
      entryIndex,
      ref: entry.data.emailNormalized
        ? identityRef(db, entry.data.emailNormalized)
        : null,
    }))
    .filter((item) => item.ref);
  const claimRefs = claimEntries.map((item) => item.ref);
  const createdPaths = recordRefs.map((ref) => ref.path);

  await importRef.set({
    status: 'processing',
    recordType,
    ownerUid: uid,
    ownerRef: userRef,
    assignedToRef,
    leadListId: leadList?.ref.id || '',
    leadListName: clean(leadList?.data?.name),
    rowAssignmentCount: accessByRow.size,
    startedAt: now,
    updatedAt: now,
  }, { merge: true });

  // At the 250-row maximum this transaction performs exactly 500 writes:
  // one CRM record and one authoritative email claim per row.
  await db.runTransaction(async (transaction) => {
    const snapshots = importableEntries.length
      ? await transaction.getAll(...recordRefs, ...claimRefs)
      : [];
    const recordSnapshots = snapshots.slice(0, recordRefs.length);
    const claimSnapshots = snapshots.slice(recordRefs.length);
    const claimsByEntryIndex = new Map(
      claimEntries.map((item, claimIndex) => [
        item.entryIndex,
        claimSnapshots[claimIndex],
      ])
    );

    for (let index = 0; index < importableEntries.length; index += 1) {
      const entry = importableEntries[index];
      const recordRef = recordRefs[index];
      const recordSnapshot = recordSnapshots[index];
      const claimSnapshot = claimsByEntryIndex.get(index);
      const claim = claimSnapshot?.exists ? claimSnapshot.data() || {} : {};

      if (
        recordSnapshot?.exists &&
        clean(recordSnapshot.data()?.importBatchId) !== importRef.id
      ) {
        throw new HttpsError(
          'already-exists',
          `Row ${entry.rowNumber} conflicts with an existing imported record.`
        );
      }

      const sameTypeRef = entry.data.emailNormalized
        ? recordType === 'people'
          ? claim.personRef
          : claim.organizationRef
        : null;
      const crossTypeConflict = entry.data.emailNormalized
        ? recordType === 'people'
          ? claim.organizationRef &&
            !sameRef(claim.organizationRef, entry.data.organizationRef)
          : Boolean(claim.personRef)
        : false;
      if (
        (sameTypeRef && !sameRef(sameTypeRef, recordRef)) ||
        crossTypeConflict
      ) {
        throw new HttpsError(
          'already-exists',
          `Row ${entry.rowNumber} has an email identity conflict. Validate the file again.`
        );
      }

      if (!recordSnapshot?.exists) {
        transaction.create(recordRef, {
          ...entry.data,
          ...(accessByRow.get(entry.rowNumber) || access),
          ...(leadList ? { leadListId: leadList.ref.id, leadListName: clean(leadList.data.name) } : {}),
          importBatchId: importRef.id,
          importSource: 'csv',
          source: 'csv_import',
          importedAt: now,
          sourceRowNumber: entry.rowNumber,
          accessUpdatedAt: now,
          createdAt: now,
          createdByRef: userRef,
          updatedAt: now,
          updatedByRef: userRef,
        });
      }

      const claimEntry = claimEntries.find((item) => item.entryIndex === index);
      if (claimEntry) {
        transaction.set(claimEntry.ref, {
          emailNormalized: entry.data.emailNormalized,
          [recordType === 'people' ? 'personRef' : 'organizationRef']: recordRef,
          updatedAt: now,
          updatedByRef: userRef,
        }, { merge: true });
      }
    }
  });

  if (recordType === 'people') {
    const firstPersonByOrganization = new Map();
    importableEntries.forEach((entry, index) => {
      const organizationRef = entry.data.organizationRef;
      if (!organizationRef?.path || firstPersonByOrganization.has(organizationRef.path)) {
        return;
      }
      firstPersonByOrganization.set(organizationRef.path, {
        organizationRef,
        personRef: recordRefs[index],
        personName: entry.data.fullName,
      });
    });

    for (const relationship of firstPersonByOrganization.values()) {
      await db.runTransaction(async (transaction) => {
        const organizationSnapshot = await transaction.get(
          relationship.organizationRef
        );
        if (!organizationSnapshot.exists) return;
        const organization = organizationSnapshot.data() || {};
        if (organization.archived === true || organization.primaryContactRef) return;
        transaction.update(relationship.organizationRef, {
          primaryContactRef: relationship.personRef,
          primaryContactName: relationship.personName,
          updatedAt: now,
          updatedByRef: userRef,
        });
      });
    }
  }

  await importRef.set({
    status: 'completed',
    recordType,
    createdCount: importableEntries.length,
    duplicateCount: duplicateEntries.length,
    skippedCount: duplicateEntries.length,
    duplicateRows: publicDuplicates(duplicateEntries),
    message: duplicateEntries.length > 0
      ? `${importableEntries.length} imported, ${duplicateEntries.length} skipped as duplicates.`
      : `${importableEntries.length} imported successfully.`,
    createdPaths,
    ownerUid: uid,
    ownerRef: userRef,
    assignedToRef,
    leadListId: leadList?.ref.id || '',
    leadListName: clean(leadList?.data?.name),
    rowAssignmentCount: accessByRow.size,
    completedAt: now,
    updatedAt: now,
  }, { merge: true });

  return {
    ok: true,
    status: 'completed',
    committed: true,
    recordType,
    createdCount: importableEntries.length,
    skippedCount: duplicateEntries.length,
    failedCount: 0,
    duplicateCount: duplicateEntries.length,
    duplicateRows: publicDuplicates(duplicateEntries),
    createdPaths,
    importBatchId: importRef.id,
    message: duplicateEntries.length > 0
      ? `${importableEntries.length} imported, ${duplicateEntries.length} skipped as duplicates.`
      : `${importableEntries.length} imported successfully.`,
  };
}

const headerKey = value => nameKey(value).replace(/[^a-z0-9]/g, '');
const refPath = value => clean(value?.path || value);

function canSee(uid, userData, data = {}) {
  if (isPlatformAdminUser(userData)) return true;
  const repId = clean(String(userData?.repId ?? ''));
  return Boolean(clean(data.ownerUid) === uid || clean(data.assignedToUid) === uid ||
    (Array.isArray(data.viewerUids) && data.viewerUids.includes(uid)) ||
    (repId && Array.isArray(data.teamRepIds) && data.teamRepIds.map(String).includes(repId)));
}

function normalizeSmartMappings(headers, proposedMappings) {
  const proposed = new Map((proposedMappings || []).map(item => [clean(item?.sourceColumn), item || {}]));
  const used = new Set();
  return headers.map(sourceColumn => {
    const item = proposed.get(sourceColumn) || {};
    const candidate = TARGET_FIELDS.includes(clean(item.targetField)) ? clean(item.targetField) : '';
    const targetField = candidate && !used.has(candidate) ? candidate : '';
    if (targetField) used.add(targetField);
    const requested = clean(item.action).toLowerCase();
    const action = targetField ? 'standard' : ['additional', 'notes', 'ignore'].includes(requested) ? requested : 'ignore';
    return {
      sourceColumn,
      action,
      targetField,
      label: action === 'additional' ? whitespace(item.label || sourceColumn).slice(0, 100) : '',
      includeInAi: action === 'additional' ? item.includeInAi !== false : action !== 'ignore',
      confidence: targetField ? clean(item.confidence) || 'medium' : 'none',
      reason: clean(item.reason) || (targetField ? 'Suggested mapping' : 'Needs review'),
    };
  });
}

function deterministicSmartMappings(headers) {
  return normalizeSmartMappings(headers, headers.map(sourceColumn => {
    const targetField = HEADER_ALIASES[headerKey(sourceColumn)] || '';
    return { sourceColumn, action: targetField ? 'standard' : 'ignore', targetField, confidence: targetField ? 'high' : 'none', reason: targetField ? 'Known column name' : 'Needs review' };
  }));
}

function openAiText(response) {
  for (const item of response?.output || []) for (const content of item?.content || []) {
    if (content.type === 'output_text' && typeof content.text === 'string') return content.text;
  }
  return '';
}

async function suggestSmartMappings(headers, ai) {
  if (!clean(ai?.apiKey)) return null;
  const schema = {
    type: 'object', additionalProperties: false, required: ['mappings'],
    properties: { mappings: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['sourceColumn', 'action', 'targetField', 'label', 'includeInAi', 'confidence', 'reason'],
      properties: {
        sourceColumn: { type: 'string' }, action: { type: 'string', enum: ['standard', 'additional', 'notes', 'ignore'] },
        targetField: { type: ['string', 'null'], enum: [...TARGET_FIELDS, null] }, label: { type: 'string' },
        includeInAi: { type: 'boolean' }, confidence: { type: 'string', enum: ['high', 'medium', 'low', 'none'] }, reason: { type: 'string' },
      },
    } } },
  };
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ai.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: clean(ai.model) || 'gpt-5-mini', store: false, max_output_tokens: 2500,
        instructions: `Map CRM columns without inventing meaning. Prefer a standard field only when clear; otherwise choose additional, notes, or ignore. Allowed standard fields: ${TARGET_FIELDS.join(', ')}.`,
        input: JSON.stringify({ headers }), text: { format: { type: 'json_schema', name: 'command_lead_column_mapping', strict: true, schema } },
      }), signal: controller.signal,
    });
    if (!response.ok) throw new Error(`OpenAI mapping failed (${response.status}).`);
    const text = openAiText(await response.json());
    if (!text) throw new Error('OpenAI returned no mapping.');
    return JSON.parse(text).mappings;
  } finally { clearTimeout(timeoutId); }
}

function smartHeaders(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_HEADERS) throw new HttpsError('invalid-argument', `headers must contain between 1 and ${MAX_HEADERS} columns.`);
  const headers = raw.map(whitespace);
  if (headers.some(value => !value || value.length > 120) || new Set(headers.map(nameKey)).size !== headers.length) throw new HttpsError('invalid-argument', 'Headers must be unique, non-empty, and 120 characters or fewer.');
  return headers;
}

function splitFullName(value) {
  const parts = whitespace(value).split(' ').filter(Boolean);
  return { firstName: parts.shift() || '', lastName: parts.join(' ') };
}

function smartRows(headers, rawRows, mappings) {
  if (!Array.isArray(rawRows) || !rawRows.length || rawRows.length > MAX_ROWS) throw new HttpsError('invalid-argument', `rows must contain between 1 and ${MAX_ROWS} records.`);
  const byHeader = new Map(mappings.map(item => [item.sourceColumn, item]));
  return rawRows.map((raw, index) => {
    const source = raw && typeof raw === 'object' ? raw : {};
    const data = {}; const extra = []; const notes = [];
    for (const header of headers) {
      const mapping = byHeader.get(header); const value = source[header] ?? '';
      if (mapping?.action === 'standard' && mapping.targetField) data[mapping.targetField] = value;
      if (mapping?.action === 'additional' && clean(String(value))) extra.push({ label: mapping.label || header, value: clean(String(value)).slice(0, 2000), sourceColumn: header, includeInAi: mapping.includeInAi !== false });
      if (mapping?.action === 'notes' && clean(String(value))) notes.push(`${header}: ${clean(String(value)).slice(0, 3000)}`);
    }
    if (data.fullName && !data.firstName) Object.assign(data, splitFullName(data.fullName));
    data.firstName = whitespace(data.firstName); data.lastName = whitespace(data.lastName);
    data.fullName = whitespace(data.fullName) || [data.firstName, data.lastName].filter(Boolean).join(' ');
    data.personEmail = email(data.personEmail); data.personPhone = phone(data.personPhone);
    data.organizationName = whitespace(data.organizationName); data.organizationEmail = email(data.organizationEmail); data.organizationPhone = phone(data.organizationPhone);
    // A generic Email/Phone column belongs to the Organization when the row has
    // no Person at all. This preserves company-only files without guessing when
    // both a Person and Organization are present.
    if (!data.fullName && data.organizationName) {
      data.organizationEmail = data.organizationEmail || data.personEmail;
      data.organizationPhone = data.organizationPhone || data.personPhone;
      data.personEmail = ''; data.personPhone = '';
    }
    data.leadName = whitespace(data.leadName); data.source = whitespace(data.source);
    data.notes = [clean(data.notes), ...notes].filter(Boolean).join('\n').slice(0, 10000); data.additionalInformation = extra;
    const errors = [];
    if (!data.fullName && !data.organizationName) errors.push('Enter a Person name or Organization name.');
    if (!data.personEmail && !data.personPhone && !data.organizationEmail && !data.organizationPhone) errors.push('Enter at least one phone number or email address.');
    if (data.personEmail && !validEmail(data.personEmail)) errors.push('Enter a valid Person email.');
    if (data.organizationEmail && !validEmail(data.organizationEmail)) errors.push('Enter a valid Organization email.');
    if (data.personPhone && data.personPhone.length !== 10) errors.push('Person phone numbers must contain exactly 10 digits.');
    if (data.organizationPhone && data.organizationPhone.length !== 10) errors.push('Organization phone numbers must contain exactly 10 digits.');
    const requested = nameKey(data.leadType); data.leadType = ['person', 'organization'].includes(requested) ? requested : data.organizationName ? 'organization' : 'person';
    if (data.leadType === 'person' && !data.fullName) errors.push('A Person Lead requires a Person name.');
    if (data.leadType === 'organization' && !data.organizationName) errors.push('An Organization Lead requires an Organization name.');
    data.estimatedValue = parseAmount(data.estimatedValue, errors);
    return { index, rowNumber: index + 1, normalized: data, sourceData: Object.fromEntries(headers.map(header => [header, clean(String(source[header] ?? '')).slice(0, 2000)])), errors: unique(errors), warnings: [] };
  });
}

async function exactMatches(db, uid, userData, collection, checks) {
  const found = new Map();
  for (const [field, value] of checks) {
    if (!value) continue;
    const snap = await db.collection(collection).where(field, '==', value).limit(3).get();
    snap.docs.filter(doc => doc.data()?.archived !== true && canSee(uid, userData, doc.data() || {})).forEach(doc => found.set(doc.ref.path, doc));
  }
  return found.size > 1 ? { status: 'ambiguous' } : found.size === 1 ? { status: 'existing', doc: [...found.values()][0] } : { status: 'new' };
}

async function matchSmartRows(db, uid, userData, rows, importBatchId) {
  for (const row of rows) {
    if (row.errors.length) continue;
    const data = row.normalized;
    const person = data.fullName ? await exactMatches(db, uid, userData, PEOPLE, [['emailNormalized', data.personEmail], ['email', data.personEmail], ['phoneNormalized', data.personPhone], ['phone', data.personPhone]]) : { status: 'none' };
    const organization = data.organizationName ? await exactMatches(db, uid, userData, ORGANIZATIONS, [['organizationNormalized', nameKey(data.organizationName)], ['emailNormalized', data.organizationEmail], ['email', data.organizationEmail], ['phoneNormalized', data.organizationPhone], ['phone', data.organizationPhone]]) : { status: 'none' };
    if (person.status === 'ambiguous') row.errors.push('Person details match multiple existing People. Correct the row before importing.');
    if (organization.status === 'ambiguous') row.errors.push('Organization details match multiple existing Organizations. Correct the row before importing.');
    row.personMatchStatus = person.status; row.personRefPath = person.doc?.ref.path || '';
    row.personImportedByBatch = Boolean(person.doc && clean(person.doc.data()?.importBatchId) === importBatchId);
    row.personGroupKey = row.personRefPath || data.personEmail || data.personPhone || nameKey(data.fullName);
    row.organizationMatchStatus = organization.status; row.organizationRefPath = organization.doc?.ref.path || '';
    row.organizationImportedByBatch = Boolean(organization.doc && clean(organization.doc.data()?.importBatchId) === importBatchId);
    row.personName = person.doc ? whitespace(person.doc.data()?.fullName || [person.doc.data()?.firstName, person.doc.data()?.lastName].filter(Boolean).join(' ')) : data.fullName;
    row.organizationDisplayName = organization.doc ? whitespace(organization.doc.data()?.organization || organization.doc.data()?.name) : data.organizationName;
  }
  const groups = new Map();
  rows.filter(row => !row.errors.length).forEach(row => {
    const data = row.normalized;
    const groupKey = data.leadType === 'organization' ? `organization:${row.organizationRefPath || nameKey(data.organizationName)}` : `person:${row.personRefPath || data.personEmail || data.personPhone || nameKey(data.fullName)}`;
    row.leadGroupKey = groupKey; if (!groups.has(groupKey)) groups.set(groupKey, []); groups.get(groupKey).push(row);
  });
  for (const groupRows of groups.values()) {
    const first = groupRows[0]; let matches = []; let staleMatch = false;
    const path = first.normalized.leadType === 'organization' ? first.organizationRefPath : first.personRefPath;
    if (path) {
      const field = first.normalized.leadType === 'organization' ? 'subjectOrganizationRef' : 'subjectPersonRef';
      // A stale opportunity remains an existing Lead, even outside rep visibility.
      // Do not recreate it through a fresh CSV; admin must reassign it explicitly.
      const stale = await db.collection(LEADS).where(field, '==', db.doc(path)).where('status', '==', 'stale').limit(1).get();
      staleMatch = stale.size > 0;
      const snap = await db.collection(LEADS).where(field, '==', db.doc(path)).limit(3).get();
      matches = snap.docs.filter(doc => doc.data()?.archived !== true && clean(doc.data()?.status) === 'active' && canSee(uid, userData, doc.data() || {}));
    }
    const sameImport = matches.length === 1 && clean(matches[0].data()?.importBatchId) === importBatchId;
    const status = staleMatch ? 'existing' : matches.length > 1 ? 'ambiguous' : sameImport ? 'resume' : matches.length === 1 ? 'existing' : 'new';
    groupRows.forEach(row => { row.leadMatchStatus = status; row.leadRefPath = staleMatch ? '' : matches[0]?.ref.path || ''; if (status === 'existing') row.warnings.push(staleMatch ? 'A matching Lead is awaiting admin review and will be skipped.' : 'An active Lead already exists and will be skipped.'); if (status === 'ambiguous') row.errors.push('Multiple active Leads exist for this subject.'); });
  }
}

function smartHash(uid, headers, rows, mappings) {
  return crypto.createHash('sha256').update(JSON.stringify({ version: 2, uid, headers, rows, mappings })).digest('hex');
}

function smartPayload(rows, mappings, id, aiStatus, aiError) {
  const grouped = new Map();
  rows.forEach(row => { if (row.leadGroupKey) { if (!grouped.has(row.leadGroupKey)) grouped.set(row.leadGroupKey, []); grouped.get(row.leadGroupKey).push(row); } });
  const leads = [...grouped.entries()].map(([groupKey, groupRows]) => {
    const first = groupRows[0];
    return { groupKey, leadType: first.normalized.leadType, leadName: first.normalized.leadName || (first.normalized.leadType === 'organization' ? first.organizationDisplayName : first.personName), organizationRefPath: first.organizationRefPath, organizationName: first.organizationDisplayName, primaryContactRefPath: groupRows.find(row => row.personRefPath)?.personRefPath || '', rowNumbers: groupRows.map(row => row.rowNumber), matchStatus: first.leadMatchStatus, existingLeadRefPath: first.leadRefPath, errors: unique(groupRows.flatMap(row => row.errors)), warnings: unique(groupRows.flatMap(row => row.warnings)) };
  });
  const errorCount = rows.filter(row => row.errors.length).length; const existingLeadCount = leads.filter(lead => lead.matchStatus === 'existing').length; const readyLeadCount = leads.filter(lead => ['new', 'resume'].includes(lead.matchStatus) && !lead.errors.length).length;
  return { ok: true, status: errorCount ? 'needs_review' : 'ready', isValid: errorCount === 0, importBatchId: id, mappings, aiStatus, aiError, rows, leads, totalRowCount: rows.length, totalLeadCount: leads.length, readyLeadCount, existingLeadCount, errorCount, skippedCount: existingLeadCount, message: errorCount ? `${errorCount} ${errorCount === 1 ? 'row needs' : 'rows need'} attention.` : `${readyLeadCount} ${readyLeadCount === 1 ? 'Lead is' : 'Leads are'} ready to import.` };
}

async function buildSmartPreview(db, uid, input, ai = {}) {
  const headers = smartHeaders(input.headers); const confirmed = Array.isArray(input.confirmedMappings) ? input.confirmedMappings : null;
  let mappings = confirmed ? normalizeSmartMappings(headers, confirmed) : deterministicSmartMappings(headers); let aiStatus = confirmed ? 'confirmed' : 'not_needed'; let aiError = '';
  if (!confirmed && mappings.some(item => item.action === 'ignore')) {
    try { const suggestions = await suggestSmartMappings(headers, ai); if (suggestions) { const known = new Map(mappings.filter(item => item.targetField).map(item => [item.sourceColumn, item])); mappings = normalizeSmartMappings(headers, headers.map(header => known.get(header) || suggestions.find(item => clean(item.sourceColumn) === header) || { sourceColumn: header, action: 'ignore' })); aiStatus = 'completed'; } else aiStatus = 'unavailable'; }
    catch (error) { aiStatus = 'failed'; aiError = clean(error.message); }
  }
  const additional = mappings.filter(item => item.action === 'additional');
  if (additional.length > 20 || new Set(additional.map(item => nameKey(item.label))).size !== additional.length) throw new HttpsError('invalid-argument', 'Use no more than 20 uniquely named additional columns.');
  const id = smartHash(uid, headers, input.rows, mappings);
  const rows = smartRows(headers, input.rows, mappings); await matchSmartRows(db, uid, input.actorData || {}, rows, id);
  return smartPayload(rows, mappings, id, aiStatus, aiError);
}

async function validateSmartCommandCsvImportService(request, ai = {}) {
  const { db, uid, userData } = await actor(request); return buildSmartPreview(db, uid, { ...(request.data || {}), actorData: userData }, ai);
}

function importedLeadId(importId, groupKey) { return deterministicId(importId, 'lead', groupKey); }
function importedPersonId(importId, personGroupKey) { return deterministicId(importId, 'person', personGroupKey); }
function importedOrganizationId(importId, groupKey) { return deterministicId(importId, 'organization', groupKey); }

async function createImportedRecordWithEmailClaim(db, options) {
  const { ref, recordType, data, emailNormalized, relatedOrganizationRef, userRef, timestamp } = options;
  let created = false;
  await db.runTransaction(async transaction => {
    const existing = await transaction.get(ref);
    if (existing.exists) return;
    await syncEmailIdentityClaims(transaction, db, {
      recordType,
      recordRef: ref,
      emails: emailNormalized ? [emailNormalized] : [],
      relatedOrganizationRef: relatedOrganizationRef || null,
      actorRef: userRef,
      timestamp,
    });
    transaction.create(ref, data);
    created = true;
  });
  return created;
}

async function writeImportRowAudit(db, importRef, preview, timestamp) {
  let batch = db.batch(); let operations = 0;
  for (const row of preview.rows) {
    batch.set(importRef.collection('rows').doc(String(row.rowNumber).padStart(4, '0')), {
      rowNumber: row.rowNumber,
      sourceData: row.sourceData,
      normalized: row.normalized,
      personMatchStatus: row.personMatchStatus || '',
      personRefPath: row.personRefPath || '',
      organizationMatchStatus: row.organizationMatchStatus || '',
      organizationRefPath: row.organizationRefPath || '',
      leadGroupKey: row.leadGroupKey || '',
      leadMatchStatus: row.leadMatchStatus || '',
      leadRefPath: row.leadRefPath || '',
      errors: row.errors || [], warnings: row.warnings || [],
      recordedAt: timestamp,
    }, { merge: true });
    operations += 1;
    if (operations === 400) { await batch.commit(); batch = db.batch(); operations = 0; }
  }
  if (operations) await batch.commit();
}

async function commitSmartCommandCsvImportService(request) {
  const { db, uid, userRef, userData } = await actor(request); const input = request.data || {}; const requestedId = clean(input.importBatchId);
  if (!/^[a-f0-9]{64}$/.test(requestedId)) throw new HttpsError('invalid-argument', 'A valid importBatchId is required.');

  // Check the durable import state before repeating the expensive preview work.
  // This makes double-clicks and retries fail quickly instead of spending 30+
  // seconds rebuilding every match before reporting that the batch is locked.
  const importRef = db.collection(IMPORTS).doc(requestedId);
  const existingImport = await importRef.get();
  const existingData = existingImport.data() || {};
  if (existingData.ownerUid && existingData.ownerUid !== uid) {
    throw new HttpsError('permission-denied', 'This import does not belong to you.');
  }
  if (existingData.status === 'completed') {
    return {
      ok: true,
      status: 'already_completed',
      committed: true,
      importBatchId: requestedId,
      createdLeadCount: Number(existingData.createdLeadCount || 0),
      createdPersonCount: Number(existingData.createdPersonCount || 0),
      createdOrganizationCount: Number(existingData.createdOrganizationCount || 0),
      skippedLeadCount: Number(existingData.skippedLeadCount || 0),
      message: existingData.message || 'This file was already imported.',
    };
  }
  if (
    existingData.status === 'processing' &&
    existingData.leaseExpiresAt?.toMillis?.() > Date.now()
  ) {
    throw new HttpsError('aborted', 'This import is already processing.');
  }

  console.info('Command CSV import requested', {
    importBatchId: requestedId,
    uid,
    rowCount: Array.isArray(input.rows) ? input.rows.length : 0,
  });

  const preview = await buildSmartPreview(db, uid, { headers: input.headers, rows: input.rows, confirmedMappings: input.confirmedMappings, actorData: userData });
  if (!preview.isValid) throw new HttpsError('failed-precondition', 'Fix preview errors before importing.', preview);
  if (preview.importBatchId !== requestedId) throw new HttpsError('failed-precondition', 'The file or mapping changed after preview. Preview it again.');
  const assignedToRef = await resolveAssignee(db, userRef, userData, input.assignedToRefPath);
  const access = await buildCommandAccessMetadata(db, { actorRef: userRef, ownerRef: userRef, assignedToRef });
  if (input.leadOverrides !== undefined && !Array.isArray(input.leadOverrides)) throw new HttpsError('invalid-argument', 'leadOverrides must be a list.');
  const knownGroups = new Set(preview.leads.map(lead => lead.groupKey));
  const overrideByGroup = new Map();
  for (const raw of input.leadOverrides || []) {
    const groupKey = clean(raw?.groupKey);
    if (!knownGroups.has(groupKey) || overrideByGroup.has(groupKey)) throw new HttpsError('invalid-argument', 'Each Lead override must reference one unique preview Lead.');
    const primaryContactRowNumber = raw.primaryContactRowNumber === undefined || raw.primaryContactRowNumber === null ? null : Number(raw.primaryContactRowNumber);
    const leadPreview = preview.leads.find(lead => lead.groupKey === groupKey);
    if (primaryContactRowNumber !== null && (!Number.isInteger(primaryContactRowNumber) || !leadPreview.rowNumbers.includes(primaryContactRowNumber))) throw new HttpsError('invalid-argument', 'A primary-contact row must belong to its preview Lead.');
    overrideByGroup.set(groupKey, { primaryContactRowNumber, assignedToRefPath: clean(raw.assignedToRefPath) });
  }
  const leadList = clean(input.leadListId) ? await resolveCommandLeadList(db, uid, userData, clean(input.leadListId)) : null; const source = whitespace(input.source) || 'csv_import';
  const lease = await db.runTransaction(async transaction => {
    const snap = await transaction.get(importRef); const data = snap.data() || {};
    if (data.ownerUid && data.ownerUid !== uid) throw new HttpsError('permission-denied', 'This import does not belong to you.');
    if (data.status === 'completed') return { completed: true, data };
    if (data.status === 'processing' && data.leaseExpiresAt?.toMillis?.() > Date.now()) throw new HttpsError('aborted', 'This import is already processing.');
    transaction.set(importRef, { status: 'processing', ownerUid: uid, ownerRef: userRef, assignedToRef, leadListId: leadList?.ref.id || '', leadListName: clean(leadList?.data?.name), source, leaseExpiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + PROCESSING_LEASE_MS), startedAt: data.startedAt || admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return { completed: false, data };
  });
  if (lease.completed) return { ok: true, status: 'already_completed', committed: true, importBatchId: requestedId, createdLeadCount: Number(lease.data.createdLeadCount || 0), createdPersonCount: Number(lease.data.createdPersonCount || 0), createdOrganizationCount: Number(lease.data.createdOrganizationCount || 0), skippedLeadCount: Number(lease.data.skippedLeadCount || 0), message: lease.data.message || 'This file was already imported.' };
  console.info('Command CSV import lease acquired', {
    importBatchId: requestedId,
    totalLeads: preview.totalLeadCount,
    readyLeads: preview.readyLeadCount,
  });
  const createdPeople = new Set(lease.data?.createdPersonPaths || []); const createdOrganizations = new Set(lease.data?.createdOrganizationPaths || []); const createdLeads = new Set(lease.data?.createdLeadPaths || []); const timestamp = admin.firestore.Timestamp.now();
  try {
    await importRef.set({ headers: smartHeaders(input.headers), mappings: preview.mappings, leadOverrides: [...overrideByGroup.entries()].map(([groupKey, value]) => ({ groupKey, ...value })), previewSummary: { totalRowCount: preview.totalRowCount, totalLeadCount: preview.totalLeadCount, readyLeadCount: preview.readyLeadCount, existingLeadCount: preview.existingLeadCount }, updatedAt: timestamp }, { merge: true });
    await writeImportRowAudit(db, importRef, preview, timestamp);
    for (const leadPreview of preview.leads.filter(lead => ['new', 'resume'].includes(lead.matchStatus) && !lead.errors.length)) {
      const groupRows = leadPreview.rowNumbers.map(number => preview.rows.find(row => row.rowNumber === number)); const first = groupRows[0];
      let organizationRef = first.organizationRefPath ? db.doc(first.organizationRefPath) : null;
      if (organizationRef && first.organizationImportedByBatch) createdOrganizations.add(organizationRef.path);
      if (!organizationRef && first.normalized.organizationName) {
        organizationRef = db.collection(ORGANIZATIONS).doc(importedOrganizationId(requestedId, leadPreview.groupKey));
        const organizationCreated = await createImportedRecordWithEmailClaim(db, {
          ref: organizationRef,
          recordType: 'organization',
          emailNormalized: first.normalized.organizationEmail,
          userRef,
          timestamp,
          data: { organization: first.normalized.organizationName, organizationNormalized: nameKey(first.normalized.organizationName), email: first.normalized.organizationEmail, emailNormalized: first.normalized.organizationEmail, additionalEmails: [], additionalEmailsNormalized: [], phone: first.normalized.organizationPhone, phoneNormalized: first.normalized.organizationPhone, website: whitespace(first.normalized.website), industry: whitespace(first.normalized.industry), address: whitespace(first.normalized.address), city: whitespace(first.normalized.city), province: whitespace(first.normalized.province), postalCode: whitespace(first.normalized.postalCode), stage: 'New', archived: false, ...access, importBatchId: requestedId, importSource: 'csv', sourceRowNumber: first.rowNumber, importedAt: timestamp, createdAt: timestamp, createdByRef: userRef, updatedAt: timestamp, updatedByRef: userRef },
        });
        if (organizationCreated) createdOrganizations.add(organizationRef.path);
      }
      const personRefs = []; const personNames = []; const personByRow = new Map();
      for (const row of groupRows) {
        if (!row.normalized.fullName) continue; let personRef = row.personRefPath ? db.doc(row.personRefPath) : null;
        if (personRef && row.personImportedByBatch) createdPeople.add(personRef.path);
        if (!personRef) {
          personRef = db.collection(PEOPLE).doc(importedPersonId(requestedId, row.personGroupKey));
          const personCreated = await createImportedRecordWithEmailClaim(db, {
            ref: personRef,
            recordType: 'person',
            emailNormalized: row.normalized.personEmail,
            relatedOrganizationRef: organizationRef,
            userRef,
            timestamp,
            data: { firstName: row.normalized.firstName, lastName: row.normalized.lastName, fullName: row.normalized.fullName, fullNameNormalized: nameKey(row.normalized.fullName), email: row.normalized.personEmail, emailNormalized: row.normalized.personEmail, additionalEmails: [], additionalEmailsNormalized: [], phone: row.normalized.personPhone, phoneNormalized: row.normalized.personPhone, organizationRef: organizationRef || null, organizationName: leadPreview.organizationName || '', stage: 'New', archived: false, notes: row.normalized.notes, additionalInformation: row.normalized.additionalInformation, ...access, importBatchId: requestedId, importSource: 'csv', sourceRowNumber: row.rowNumber, importedAt: timestamp, createdAt: timestamp, createdByRef: userRef, updatedAt: timestamp, updatedByRef: userRef },
          });
          if (personCreated) createdPeople.add(personRef.path);
        }
        if (!personRefs.some(ref => ref.path === personRef.path)) { personRefs.push(personRef); personNames.push(row.normalized.fullName); }
        personByRow.set(row.rowNumber, { ref: personRef, name: row.normalized.fullName });
      }
      const override = overrideByGroup.get(leadPreview.groupKey) || {};
      const selectedPrimary = override.primaryContactRowNumber === null || override.primaryContactRowNumber === undefined ? (personRefs[0] ? { ref: personRefs[0], name: personNames[0] } : null) : personByRow.get(override.primaryContactRowNumber);
      if (override.primaryContactRowNumber !== null && override.primaryContactRowNumber !== undefined && !selectedPrimary) throw new HttpsError('failed-precondition', 'The selected primary-contact row does not contain a Person.');
      const leadAssignedToRef = override.assignedToRefPath ? await resolveAssignee(db, userRef, userData, override.assignedToRefPath) : assignedToRef;
      const leadAccess = leadAssignedToRef.path === assignedToRef.path ? access : await buildCommandAccessMetadata(db, { actorRef: userRef, ownerRef: userRef, assignedToRef: leadAssignedToRef });
      const subjectPersonRef = first.normalized.leadType === 'person' ? personRefs[0] || null : null; const primaryContactRef = selectedPrimary?.ref || null; const displayName = leadPreview.leadName; const leadRef = db.collection(LEADS).doc(importedLeadId(requestedId, leadPreview.groupKey));
      const lead = { displayName, displayNameNormalized: nameKey(displayName), searchTextNormalized: unique([nameKey(displayName), nameKey(leadPreview.organizationName), ...groupRows.flatMap(row => [nameKey(row.normalized.fullName), row.normalized.personEmail, row.normalized.personPhone])]).join(' '), leadType: first.normalized.leadType, stage: 'New', status: 'active', archived: false, subjectPersonRef, subjectPersonName: subjectPersonRef ? personNames[0] : '', subjectOrganizationRef: organizationRef, subjectOrganizationName: leadPreview.organizationName || '', primaryContactRef, primaryContactName: selectedPrimary?.name || '', connectedPersonRefs: personRefs, connectedPersonNames: personNames, leadListId: leadList?.ref.id || '', leadListName: clean(leadList?.data?.name), source, estimatedValue: Math.max(...groupRows.map(row => Number(row.normalized.estimatedValue) || 0)), importBatchId: requestedId, importedAt: timestamp, sourceRowNumbers: leadPreview.rowNumbers, nextActionRef: null, nextActionTitle: '', nextActionType: '', nextActionAt: null, lastActivityAt: timestamp, lastActivityType: 'lead_imported', lastActivityOutcome: 'imported', wonAt: null, lostAt: null, lostReason: '', archivedAt: null, ...leadAccess, createdAt: timestamp, updatedAt: timestamp, createdByRef: userRef, createdByUid: uid, updatedByRef: userRef };
      const connectionRef = db.collection(CONNECTIONS).doc(`lead_imported_${leadRef.id}`); const batch = db.batch(); batch.set(leadRef, lead); batch.set(connectionRef, { performanceVersion: 1, performanceLinkStatus: 'linked', type: 'lead_imported', eventType: 'lead_imported', eventAt: timestamp, outcome: 'imported', summary: `Lead imported: ${displayName}`, body: '', details: { importBatchId: requestedId, sourceRowNumbers: leadPreview.rowNumbers }, sourceRef: leadRef, leadRef, leadName: displayName, repRef: lead.assignedToRef, repUid: lead.assignedToUid, repId: clean(String(userData.repId || '')), repName: lead.assignedToName, personRef: subjectPersonRef || primaryContactRef, personName: lead.subjectPersonName || lead.primaryContactName, organizationRef, organizationName: lead.subjectOrganizationName, leadSource: source, leadListId: lead.leadListId, leadListName: lead.leadListName, previousStage: '', nextStage: 'New', startedAt: null, finishedAt: null, durationSeconds: null, completedOnTime: null, completionTiming: '', lostReason: '', ownerRef: lead.ownerRef, ownerUid: lead.ownerUid, ownerName: lead.ownerName, viewerUids: lead.viewerUids, teamRepIds: lead.teamRepIds, createdAt: timestamp, createdByRef: userRef, createdByUid: uid, createdByName: whitespace(userData.fullName || userData.displayName || userData.email), deduplicationKey: `lead_imported:${leadRef.id}` }, { merge: true });
      if (organizationRef && primaryContactRef) { const orgSnap = await organizationRef.get(); if (orgSnap.exists && !orgSnap.data()?.primaryContactRef) batch.update(organizationRef, { primaryContactRef, primaryContactName: personNames[0], updatedAt: timestamp, updatedByRef: userRef }); }
      await batch.commit(); createdLeads.add(leadRef.path);
      await importRef.set({
        createdLeadCount: createdLeads.size,
        createdPersonCount: createdPeople.size,
        createdOrganizationCount: createdOrganizations.size,
        createdLeadPaths: [...createdLeads],
        createdPersonPaths: [...createdPeople],
        createdOrganizationPaths: [...createdOrganizations],
        lastCommittedGroupKey: leadPreview.groupKey,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    const skippedLeadCount = preview.leads.filter(lead => lead.matchStatus === 'existing').length; const message = `${createdLeads.size} ${createdLeads.size === 1 ? 'Lead' : 'Leads'} imported${skippedLeadCount ? `; ${skippedLeadCount} existing active ${skippedLeadCount === 1 ? 'Lead was' : 'Leads were'} skipped` : ''}.`;
    await importRef.set({ status: 'completed', leaseExpiresAt: admin.firestore.FieldValue.delete(), createdLeadCount: createdLeads.size, createdPersonCount: createdPeople.size, createdOrganizationCount: createdOrganizations.size, skippedLeadCount, createdLeadPaths: [...createdLeads], createdPersonPaths: [...createdPeople], createdOrganizationPaths: [...createdOrganizations], message, completedAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    console.info('Command CSV import completed', {
      importBatchId: requestedId,
      createdLeadCount: createdLeads.size,
      createdPersonCount: createdPeople.size,
      createdOrganizationCount: createdOrganizations.size,
      skippedLeadCount,
    });
    return { ok: true, status: 'completed', committed: true, importBatchId: requestedId, createdLeadCount: createdLeads.size, createdPersonCount: createdPeople.size, createdOrganizationCount: createdOrganizations.size, skippedLeadCount, createdLeadPaths: [...createdLeads], message };
  } catch (error) {
    console.error('Command CSV import failed', {
      importBatchId: requestedId,
      uid,
      code: clean(error?.code),
      message: clean(error?.message),
      stack: clean(error?.stack).slice(0, 4000),
    });
    await importRef.set({ status: 'failed', error: clean(error.message).slice(0, 1000), leaseExpiresAt: admin.firestore.FieldValue.delete(), failedAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    throw error;
  }
}

module.exports = {
  MAX_ROWS,
  MAX_HEADERS,
  TEMPLATES,
  TARGET_FIELDS,
  validateCommandCsvImportService: validateSmartCommandCsvImportService,
  commitCommandCsvImportService: commitSmartCommandCsvImportService,
  _test: { headerKey, normalizeSmartMappings, deterministicSmartMappings, splitFullName, smartRows, smartHash, importedLeadId, importedPersonId, importedOrganizationId, canSee, matchSmartRows },
};


