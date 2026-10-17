'use strict';

const { HttpsError } = require('firebase-functions/v2/https');
const { isPlatformAdminUser } = require('./commandPersonUtils');
const { isProgramDirectorRole, isDirectorRole } = require('../repHierarchy');
const clean = value => String(value ?? '').trim();

function canAssignTo({ uid, userData, roleId }, targetUid, target) {
  if (target.active === false || target.userType !== 'rep' || !clean(target.repId)) return false;
  if (isPlatformAdminUser(userData)) return true;
  if (uid === targetUid) return true;
  const repId = clean(userData.repId);
  if (!repId) return false;
  if (isDirectorRole(roleId)) return clean(target.directorRepId) === repId;
  return isProgramDirectorRole(roleId) && clean(target.programDirectorRepId) === repId;
}

async function assignmentActor(db, uid, userData) {
  let roleId = '';
  if (!isPlatformAdminUser(userData) && clean(userData.repId)) {
    const rep = await db.collection('reps').doc(clean(userData.repId)).get();
    if (rep.exists && rep.data().active !== false && rep.data().status !== 'inactive') {
      roleId = clean(rep.data().currentRoleId);
    }
  }
  return { uid, userData, roleId };
}

async function assertRecordAssignment(db, actor, record, assigneeRef, read = ref => ref.get()) {
  if (!assigneeRef || assigneeRef.parent?.id !== 'users') throw new HttpsError('invalid-argument', 'Select a representative.');
  const target = await read(assigneeRef);
  if (!target.exists || !canAssignTo(actor, assigneeRef.id, target.data() || {})) {
    throw new HttpsError('permission-denied', 'Assign only to an active representative on your team. Platform administrators may assign to any active representative.');
  }
  if (!record || isPlatformAdminUser(actor.userData)) return;
  // Current assignment is authoritative; viewer ACLs alone do not grant transfer rights.
  const sourceUid = clean(record.assignedToUid || record.assignedToRef?.id || record.ownerUid || record.ownerRef?.id);
  if (sourceUid === actor.uid) return;
  if (!sourceUid) throw new HttpsError('permission-denied', 'Only a platform administrator can assign this unowned record.');
  const source = await read(db.collection('users').doc(sourceUid));
  // Inactive team members' records must still be recoverable by their leader.
  if (!source.exists || !canAssignTo(actor, sourceUid, { ...source.data(), active: true })) {
    throw new HttpsError('permission-denied', 'You may reassign only your own records or records assigned within your team.');
  }
}

module.exports = { canAssignTo, assignmentActor, assertRecordAssignment };

function assignmentEvent(actorRef, recordRef, before, after, at) {
  const organization = recordRef.parent.id === 'commandOrganizations';
  return {
    type: organization ? 'organization_assigned' : 'person_assigned',
    recordType: organization ? 'organization' : 'person',
    personRef: organization ? null : recordRef,
    organizationRef: organization ? recordRef : (after.organizationRef || null),
    recordName: clean(after.fullName || after.organization || after.organizationName || after.displayName),
    summary: `Assigned to ${clean(after.assignedToName) || clean(after.assignedToUid)}`,
    details: { previousAssignedToUid: clean(before.assignedToUid || before.assignedToRef?.id), assignedToUid: clean(after.assignedToUid) },
    ownerUid: clean(after.ownerUid), assignedToUid: clean(after.assignedToUid),
    viewerUids: after.viewerUids || [], teamRepIds: after.teamRepIds || [],
    createdByRef: actorRef, createdByUid: actorRef.id, createdAt: at,
  };
}
module.exports.assignmentEvent = assignmentEvent;
