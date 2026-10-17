"use strict";

const { writeAdminAudit } = require("./adminAudit");
const { sixWeekTarget, nextMonthStart } = require("./edmontonTime");
const { ensureTeamRepMembership } = require("./teamRepMembership");
const { sendRepPasswordResetEmail } = require("./mailer");

function clean(value) { return String(value ?? "").trim(); }
function asDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
function stamp(admin, value) { return admin.firestore.Timestamp.fromDate(value); }
function repDetailRecord(data, id) {
  return {
    id,
    ...data,
    repId: data.repId || id,
    active: data.active !== false,
    appAccess: data.appAccess !== false,
  };
}

async function getRep(db, repId) {
  const ref = db.collection("reps").doc(clean(repId));
  const snap = await ref.get();
  if (!snap.exists) throw Object.assign(new Error("Rep not found"), { statusCode: 404 });
  return { ref, data: snap.data() || {} };
}

async function previewCampDecision(db, repId) {
  const rep = await getRep(db, repId);
  return {
    repId: rep.ref.id,
    currentStatus: clean(rep.data.developmentCampStatus || "active"),
    firstActualShiftAt: rep.data.firstActualShiftAt || null,
    meetingTargetAt: rep.data.developmentCampMeetingTargetAt || null,
    x: Number(rep.data.developmentCampX || 0),
    revenue: Number(rep.data.developmentCampRevenue || 0),
    salesCount: Number(rep.data.developmentCampSalesCount || 0),
    completionIsManual: true,
  };
}

async function recordFirstActualShift({ db, admin, repId, shiftAt }) {
  const rep = await getRep(db, repId);
  const first = asDate(rep.data.firstActualShiftAt);
  const incoming = asDate(shiftAt);
  if (!incoming) throw new Error("Valid shiftAt is required");
  if (first && first.getTime() <= incoming.getTime()) return { changed: false, firstActualShiftAt: first };
  const target = sixWeekTarget(incoming);
  const update = {
    firstActualShiftAt: stamp(admin, incoming),
    developmentCampStartDate: stamp(admin, incoming),
    developmentCampThrough: stamp(admin, target),
    developmentCampMeetingTargetAt: stamp(admin, target),
    developmentCampStatus: "active",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  await rep.ref.set(update, { merge: true });
  if (rep.data.firebaseUid) await db.collection("users").doc(String(rep.data.firebaseUid)).set(update, { merge: true });
  return { changed: true, firstActualShiftAt: incoming, meetingTargetAt: target };
}

async function completeCamp({ db, admin, actor, repId, reason, requestId }) {
  if (!clean(reason)) throw new Error("A reason is required");
  const rep = await getRep(db, repId);
  const currentStatus = clean(rep.data.developmentCampStatus);
  if (currentStatus !== "awaiting_admin_review") {
    throw new Error("Development Camp must be awaiting admin review before completion");
  }
  const before = { developmentCampStatus: rep.data.developmentCampStatus || null };
  const update = {
    developmentCampStatus: "completed",
    developmentCampCompletedAt: admin.firestore.FieldValue.serverTimestamp(),
    developmentCampDecision: "completed",
    developmentCampDecisionReason: clean(reason),
    developmentCampDecisionBy: actor.uid,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  await rep.ref.set(update, { merge: true });
  if (rep.data.firebaseUid) await db.collection("users").doc(String(rep.data.firebaseUid)).set(update, { merge: true });
  const auditId = await writeAdminAudit(db, admin, { action: "rep.camp.complete", actorUid: actor.uid, actorEmail: actor.email, targetType: "rep", targetId: rep.ref.id, reason, requestId, before, after: update });
  return { repId: rep.ref.id, status: "completed", auditId };
}

async function extendCamp({ db, admin, actor, repId, through, reason, requestId }) {
  const rep = await getRep(db, repId);
  const date = asDate(through);
  const current = asDate(rep.data.developmentCampThrough);
  if (!date || (current && date <= current)) throw new Error("Extension date must be after the current camp end");
  const update = {
    developmentCampStatus: "extended",
    developmentCampThrough: stamp(admin, date),
    developmentCampMeetingTargetAt: stamp(admin, date),
    developmentCampDecision: "extended",
    developmentCampDecisionReason: clean(reason),
    developmentCampDecisionBy: actor.uid,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  await rep.ref.set(update, { merge: true });
  if (rep.data.firebaseUid) await db.collection("users").doc(String(rep.data.firebaseUid)).set(update, { merge: true });
  const auditId = await writeAdminAudit(db, admin, { action: "rep.camp.extend", actorUid: actor.uid, actorEmail: actor.email, targetType: "rep", targetId: rep.ref.id, reason, requestId, before: { developmentCampThrough: rep.data.developmentCampThrough || null }, after: update });
  return { repId: rep.ref.id, status: "extended", through: date.toISOString(), auditId };
}

async function approvePromotion({ db, admin, actor, repId, promotionId, reason, exceptionalEffectiveDate, requestId }) {
  const rep = await getRep(db, repId);
  const ref = rep.ref.collection("promotions").doc(clean(promotionId));
  const snap = await ref.get();
  if (!snap.exists) throw Object.assign(new Error("Promotion not found"), { statusCode: 404 });
  const promotion = snap.data() || {};
  if (!["qualified_pending_review","scheduled"].includes(clean(promotion.status))) throw new Error("Promotion is not awaiting approval");
  const exceptional = asDate(exceptionalEffectiveDate);
  if (exceptional && !clean(reason)) throw new Error("A reason is required for an exceptional promotion date");
  const effective = exceptional || nextMonthStart(new Date());
  const update = {
    status: "approved_pending_activation",
    effectiveDate: stamp(admin, effective),
    approvedAt: admin.firestore.FieldValue.serverTimestamp(),
    approvedBy: actor.uid,
    approvalNotes: clean(reason),
    exceptionalEffectiveDate: Boolean(exceptional),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  await ref.set(update, { merge: true });
  const auditId = await writeAdminAudit(db, admin, { action: "rep.promotion.approve", actorUid: actor.uid, actorEmail: actor.email, targetType: "promotion", targetId: ref.path, reason, requestId, before: promotion, after: update });
  return { repId: rep.ref.id, promotionId: ref.id, status: update.status, effectiveDate: effective.toISOString(), auditId };
}

async function previewDeactivation(db, repId) {
  const rep = await getRep(db, repId);
  const uid = clean(rep.data.firebaseUid);
  const queries = [
    ["people", db.collection("commandPeople").where("ownerUid", "==", uid).where("archived", "==", false).limit(501)],
    ["organizations", db.collection("commandOrganizations").where("ownerUid", "==", uid).where("archived", "==", false).limit(501)],
    ["actions", db.collection("commandActions").where("assignedToUid", "==", uid).where("status", "==", "open").limit(501)],
  ];
  const rows = {};
  for (const [name, query] of queries) {
    const snap = uid ? await query.get() : { size: 0 };
    rows[name] = { count: snap.size, truncated: snap.size > 500 };
  }
  return { repId: rep.ref.id, firebaseUid: uid, active: rep.data.active !== false, work: rows };
}

async function deactivateRep({ db, admin, actor, repId, reason, requestId }) {
  if (!clean(reason)) throw new Error("A reason is required");
  const preview = await previewDeactivation(db, repId);
  if (Object.values(preview.work).some((row) => row.count > 0)) throw new Error("Active work must be reassigned before deactivation");
  const rep = await getRep(db, repId);
  const update = { active: false, appAccess: false, status: "disabled", deactivatedAt: admin.firestore.FieldValue.serverTimestamp(), deactivatedBy: actor.uid, deactivationReason: clean(reason), updatedAt: admin.firestore.FieldValue.serverTimestamp() };
  await rep.ref.set(update, { merge: true });
  if (rep.data.firebaseUid) {
    await admin.auth().updateUser(String(rep.data.firebaseUid), { disabled: true });
    await db.collection("users").doc(String(rep.data.firebaseUid)).set(update, { merge: true });
  }
  const auditId = await writeAdminAudit(db, admin, { action: "rep.deactivate", actorUid: actor.uid, actorEmail: actor.email, targetType: "rep", targetId: rep.ref.id, reason, requestId, before: { active: rep.data.active, status: rep.data.status }, after: update });
  return { repId: rep.ref.id, status: "disabled", auditId };
}


async function reassignActiveWork({ db, admin, actor, repId, recipientRepId, reason, requestId, dryRun = false }) {
  if (!clean(reason)) throw new Error("A reason is required");
  const source = await getRep(db, repId);
  const recipient = await getRep(db, recipientRepId);
  if (recipient.data.active === false || !clean(recipient.data.firebaseUid)) throw new Error("Recipient must be an active rep");
  const sourceUid = clean(source.data.firebaseUid);
  const recipientUid = clean(recipient.data.firebaseUid);
  if (!sourceUid || sourceUid === recipientUid) throw new Error("A different valid recipient is required");

  const specs = [
    { name: "people", query: db.collection("commandPeople").where("ownerUid", "==", sourceUid).where("archived", "==", false), owner: true },
    { name: "organizations", query: db.collection("commandOrganizations").where("ownerUid", "==", sourceUid).where("archived", "==", false), owner: true },
    { name: "actions", query: db.collection("commandActions").where("assignedToUid", "==", sourceUid).where("status", "==", "open"), owner: false },
  ];
  const found = [];
  for (const spec of specs) {
    const snap = await spec.query.limit(501).get();
    if (snap.size > 500) throw new Error(`More than 500 active ${spec.name} records require staged reassignment`);
    found.push({ ...spec, docs: snap.docs });
  }
  const counts = Object.fromEntries(found.map((row) => [row.name, row.docs.length]));
  if (dryRun) return { repId: source.ref.id, recipientRepId: recipient.ref.id, counts, dryRun: true };

  const now = admin.firestore.FieldValue.serverTimestamp();
  const recipientRef = db.collection("users").doc(recipientUid);
  const recipientName = clean(recipient.data.fullName);
  const writes = [];
  for (const row of found) {
    for (const doc of row.docs) {
      const update = row.owner ? {
        ownerUid: recipientUid, ownerRef: recipientRef, ownerName: recipientName,
        assignedToUid: recipientUid, assignedToRef: recipientRef, assignedToName: recipientName,
        updatedAt: now,
      } : {
        assignedToUid: recipientUid, assignedToRef: recipientRef, assignedToName: recipientName,
        updatedAt: now,
      };
      writes.push({ ref: doc.ref, update });
    }
  }
  for (const group of chunk(writes, 400)) {
    const batch = db.batch();
    for (const write of group) batch.set(write.ref, write.update, { merge: true });
    await batch.commit();
  }
  const auditId = await writeAdminAudit(db, admin, {
    action: "rep.work.reassign", actorUid: actor.uid, actorEmail: actor.email,
    targetType: "rep", targetId: source.ref.id, reason, requestId,
    before: { firebaseUid: sourceUid }, after: { recipientRepId: recipient.ref.id, recipientUid, counts },
  });
  return { repId: source.ref.id, recipientRepId: recipient.ref.id, counts, auditId, dryRun: false };
}


function chunk(values, size = 400) {
  if (!Number.isInteger(size) || size < 1 || size > 500) throw new Error("Batch size must be between 1 and 500");
  const groups = [];
  for (let i = 0; i < values.length; i += size) groups.push(values.slice(i, i + size));
  return groups;
}

async function retryOnboarding({ db, admin, actor, repId, reason, requestId, mailUserSecret, mailAppPasswordSecret }) {
  if (!clean(reason)) throw new Error("A reason is required");
  const rep = await getRep(db, repId);
  const email = clean(rep.data.email).toLowerCase();
  if (!email) throw new Error("The rep does not have an email address");
  if (!clean(rep.data.programDirectorRepId) || !clean(rep.data.directorRepId)) {
    throw new Error("Program Director and Regional Director are required before retrying onboarding");
  }

  let authUser;
  try {
    authUser = await admin.auth().getUserByEmail(email);
    if (authUser.disabled) authUser = await admin.auth().updateUser(authUser.uid, { disabled: false });
  } catch (error) {
    if (error.code !== "auth/user-not-found") throw error;
    authUser = await admin.auth().createUser({
      email,
      displayName: clean(rep.data.fullName),
      disabled: false,
    });
  }

  await admin.auth().setCustomUserClaims(authUser.uid, { role: "sales_rep" });
  const now = admin.firestore.FieldValue.serverTimestamp();
  const update = {
    firebaseUid: authUser.uid,
    onboardingStatus: "active",
    onboardingLastRetryAt: now,
    onboardingLastRetryBy: actor.uid,
    onboardingLastRetryReason: clean(reason),
    active: true,
    appAccess: true,
    status: "active",
    updatedAt: now,
  };
  const userPayload = {
    ...rep.data,
    ...update,
    uid: authUser.uid,
    repId: rep.ref.id,
    userType: "rep",
    source: rep.data.source || "wordpress_onboarding",
  };

  const batch = db.batch();
  batch.set(rep.ref, update, { merge: true });
  batch.set(db.collection("users").doc(authUser.uid), userPayload, { merge: true });
  await batch.commit();

  let teamMembership;
  try {
    teamMembership = await ensureTeamRepMembership({
      db,
      admin,
      repId: rep.ref.id,
      firebaseUid: authUser.uid,
      email,
      cityId: clean(rep.data.homeCityId || "yyc"),
    });
    const membershipStatus = {
      onboardingStatus: "membership_complete",
      teamRepMembershipId: teamMembership.membershipId,
      membershipProvisioningStatus: "complete",
      membershipProvisioningError: null,
      membershipProvisionedAt:
        admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await Promise.all([
      rep.ref.set(membershipStatus, { merge: true }),
      db.collection("users").doc(authUser.uid)
        .set(membershipStatus, { merge: true }),
    ]);
  } catch (membershipError) {
    const membershipFailure = {
      onboardingStatus: "membership_pending",
      teamRepMembershipId: `R${rep.ref.id}`,
      membershipProvisioningStatus: "failed",
      membershipProvisioningError: String(
        membershipError?.message || membershipError
      ).slice(0, 1000),
      membershipProvisioningUpdatedAt:
        admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await Promise.all([
      rep.ref.set(membershipFailure, { merge: true }),
      db.collection("users").doc(authUser.uid)
        .set(membershipFailure, { merge: true }),
    ]);
    throw membershipError;
  }

  const welcomeAlreadySent =
    clean(rep.data.welcomeEmailStatus).toLowerCase() === "sent";
  let mailResult = { ok: true, skipped: welcomeAlreadySent };

  if (!welcomeAlreadySent) {
    try {
      const passwordLink = await admin.auth().generatePasswordResetLink(email);
      mailResult = await sendRepPasswordResetEmail({
        toEmail: email,
        repName: clean(rep.data.fullName || rep.data.firstName),
        repId: rep.ref.id,
        currentRoleId: clean(rep.data.currentRoleId),
        currentRoleName: clean(rep.data.currentRoleName),
        complimentaryVipActive: true,
        passwordLink,
        mailUserSecret: mailUserSecret || null,
        mailAppPasswordSecret: mailAppPasswordSecret || null,
      });
    } catch (mailError) {
      mailResult = {
        ok: false,
        error: clean(mailError?.message || mailError),
      };
    }
  }

  if (!mailResult?.ok) {
    const emailError = clean(mailResult?.error || "Unknown mailer error");
    const emailFailure = {
      onboardingStatus: "email_pending",
      welcomeEmailStatus: "failed",
      welcomeEmailError: emailError,
      welcomeEmailUpdatedAt:
        admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await Promise.all([
      rep.ref.set(emailFailure, { merge: true }),
      db.collection("users").doc(authUser.uid)
        .set(emailFailure, { merge: true }),
    ]);
    throw new Error(`Rep membership is ready but welcome email failed: ${emailError}`);
  }

  const completeStatus = {
    onboardingStatus: "complete",
    welcomeEmailStatus: "sent",
    welcomeEmailError: null,
    welcomeEmailUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    ...(!welcomeAlreadySent ? {
      welcomeEmailSentAt: admin.firestore.FieldValue.serverTimestamp(),
    } : {}),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  await Promise.all([
    rep.ref.set(completeStatus, { merge: true }),
    db.collection("users").doc(authUser.uid)
      .set(completeStatus, { merge: true }),
  ]);

  const auditId = await writeAdminAudit(db, admin, {
    action: "rep.onboarding.retry",
    actorUid: actor.uid,
    actorEmail: actor.email,
    targetType: "rep",
    targetId: rep.ref.id,
    reason,
    requestId,
    before: { onboardingStatus: rep.data.onboardingStatus || null, firebaseUid: rep.data.firebaseUid || null },
    after: {
      onboardingStatus: "complete",
      status: "active",
      firebaseUid: authUser.uid,
      teamMembership,
      welcomeEmailStatus: "sent",
      welcomeEmailResent: !welcomeAlreadySent,
    },
  });
  return {
    repId: rep.ref.id,
    status: "active",
    onboardingStatus: "complete",
    firebaseUid: authUser.uid,
    teamMembership,
    emailSent: !welcomeAlreadySent,
    emailSkipped: welcomeAlreadySent,
    auditId,
  };
}

async function createCampMeeting({ db, admin, actor, repId, startAt, endAt, reason, requestId }) {
  if (!clean(reason)) throw new Error("A reason is required");
  const rep = await getRep(db, repId);
  const start = asDate(startAt || rep.data.developmentCampMeetingTargetAt);
  if (!start) throw new Error("A valid meeting start is required");
  const end = asDate(endAt) || new Date(start.getTime() + 60 * 60 * 1000);
  if (end <= start) throw new Error("Meeting end must be after its start");
  const attendeeRepIds = [
    rep.ref.id,
    clean(rep.data.programDirectorRepId),
    clean(rep.data.directorRepId),
  ].filter(Boolean);
  const attendeeSnaps = await Promise.all(
    attendeeRepIds.map((id) => db.collection("reps").doc(id).get())
  );
  const missingLeader = attendeeSnaps.find((snap) => !snap.exists);
  if (missingLeader) throw new Error("Rep, Program Director, or Regional Director record was not found");
  const attendees = attendeeSnaps.map((snap) => ({ repId: snap.id, ...(snap.data() || {}) }));
  const inactiveLeader = attendees.slice(1).find((row) => row.active === false);
  if (inactiveLeader) throw new Error("Program Director and Regional Director must be active");
  const ids = attendees.map((row) => clean(row.firebaseUid)).filter(Boolean);
  if (ids.length !== attendees.length) throw new Error("Every meeting participant must have a Firebase user");
  const meetingRef = db.collection("commandActions").doc();
  const now = admin.firestore.FieldValue.serverTimestamp();
  const data = {
    title: "Development Camp Six-Week Review", description: clean(reason), agenda: clean(reason),
    actionType: "meeting", type: "meeting", isMeeting: true,
    relatedType: "General", priority: "Medium", status: "open",
    ownerUid: actor.uid, ownerRef: db.collection("users").doc(actor.uid),
    assignedToUid: ids[0], assignedToRef: db.collection("users").doc(ids[0]),
    assignedToName: clean(attendees[0].fullName),
    viewerUids: [...new Set([actor.uid, ...ids])],
    internalAttendeeUids: [...new Set(ids)], internalAttendeeRepIds: [...new Set(attendeeRepIds)],
    attendeeUids: [...new Set(ids)], attendeeRepIds: [...new Set(attendeeRepIds)],
    participantUids: [...new Set(ids)], participantRepIds: [...new Set(attendeeRepIds)],
    startAt: stamp(admin, start), endAt: stamp(admin, end),
    meetingStartAt: stamp(admin, start), meetingEndAt: stamp(admin, end),
    scheduledAt: stamp(admin, start), dueAt: stamp(admin, end),
    timeZone: "America/Edmonton", locationType: "virtual",
    lifecycleMeetingType: "development_camp_review", lifecycleRepId: rep.ref.id,
    createdAt: now, updatedAt: now,
  };
  await meetingRef.create(data);
  const repUpdate = { developmentCampMeetingRef: meetingRef, developmentCampMeetingTargetAt: stamp(admin, start), updatedAt: now };
  await rep.ref.set(repUpdate, { merge: true });
  if (rep.data.firebaseUid) await db.collection("users").doc(clean(rep.data.firebaseUid)).set(repUpdate, { merge: true });
  const auditId = await writeAdminAudit(db, admin, { action: "rep.camp.meeting.create", actorUid: actor.uid, actorEmail: actor.email, targetType: "rep", targetId: rep.ref.id, reason, requestId, before: { developmentCampMeetingRef: rep.data.developmentCampMeetingRef || null }, after: { meetingRef: meetingRef.path, startAt: start.toISOString(), endAt: end.toISOString() } });
  return { repId: rep.ref.id, meetingRefPath: meetingRef.path, startAt: start.toISOString(), endAt: end.toISOString(), auditId };
}

async function schedulePromotion({ db, admin, actor, repId, promotionId, effectiveDate, reason, requestId }) {
  if (!clean(reason)) throw new Error("A reason is required");
  const rep = await getRep(db, repId);
  const ref = rep.ref.collection("promotions").doc(clean(promotionId));
  const snap = await ref.get();
  if (!snap.exists) throw Object.assign(new Error("Promotion not found"), { statusCode: 404 });
  const promotion = snap.data() || {};
  if (clean(promotion.status) !== "qualified_pending_review") throw new Error("Promotion is not awaiting scheduling");
  const effective = asDate(effectiveDate) || nextMonthStart(new Date());
  const update = { status: "scheduled", effectiveDate: stamp(admin, effective), scheduledAt: admin.firestore.FieldValue.serverTimestamp(), scheduledBy: actor.uid, scheduleReason: clean(reason), updatedAt: admin.firestore.FieldValue.serverTimestamp() };
  await ref.set(update, { merge: true });
  const auditId = await writeAdminAudit(db, admin, { action: "rep.promotion.schedule", actorUid: actor.uid, actorEmail: actor.email, targetType: "promotion", targetId: ref.path, reason, requestId, before: promotion, after: update });
  return { repId: rep.ref.id, promotionId: ref.id, status: "scheduled", effectiveDate: effective.toISOString(), auditId };
}

async function correctAttendance({ db, admin, actor, attendanceId, status, reason, requestId }) {
  if (!clean(attendanceId) || !clean(status) || !clean(reason)) throw new Error("attendanceId, status and reason are required");
  const allowed = new Set(["Completed", "Missed", "Approved Absence", "Review Needed", "Forgot Clock Out"]);
  if (!allowed.has(clean(status))) throw new Error("Unsupported attendance status");
  const ref = db.collection("attendanceLogs").doc(clean(attendanceId));
  const snap = await ref.get();
  if (!snap.exists) throw Object.assign(new Error("Attendance record not found"), { statusCode: 404 });
  const before = snap.data() || {};
  const update = { status: clean(status), correctedAt: admin.firestore.FieldValue.serverTimestamp(), correctedBy: actor.uid, correctionReason: clean(reason), updatedAt: admin.firestore.FieldValue.serverTimestamp() };
  await ref.set(update, { merge: true });
  if (clean(before.shiftId)) await db.collection("scheduledShifts").doc(clean(before.shiftId)).set({ status: clean(status), attendanceCorrectedAt: update.correctedAt, updatedAt: update.updatedAt }, { merge: true });
  const auditId = await writeAdminAudit(db, admin, { action: "rep.attendance.correct", actorUid: actor.uid, actorEmail: actor.email, targetType: "attendance", targetId: ref.id, reason, requestId, before, after: update });
  return { attendanceId: ref.id, status: clean(status), auditId };
}


async function getRepLifecycle({ db, repId }) {
  const rep = await getRep(db, repId);
  const data = rep.data;
  const [pdSnap, directorSnap, promotionsSnap, attendanceSnap, auditsSnap,
    qualificationsSnap, roleHistorySnap] = await Promise.all([
    clean(data.programDirectorRepId)
      ? db.collection("reps").doc(clean(data.programDirectorRepId)).get()
      : Promise.resolve(null),
    clean(data.directorRepId)
      ? db.collection("reps").doc(clean(data.directorRepId)).get()
      : Promise.resolve(null),
    rep.ref.collection("promotions").orderBy("updatedAt", "desc").limit(10).get(),
    db.collection("attendanceLogs").where("repId", "==", rep.ref.id).limit(100).get(),
    db.collection("adminAudit").where("targetId", "==", rep.ref.id).limit(50).get(),
    rep.ref.collection("monthlyQualifications").orderBy("monthKey", "desc").limit(24).get(),
    rep.ref.collection("roleHistory").orderBy("effectiveStart", "desc").limit(50).get(),
  ]);

  let meeting = null;
  const meetingPath = clean(data.developmentCampMeetingRef?.path || data.developmentCampMeetingRef);
  if (meetingPath) {
    const meetingSnap = await db.doc(meetingPath).get();
    if (meetingSnap.exists) meeting = { id: meetingSnap.id, refPath: meetingSnap.ref.path, ...meetingSnap.data() };
  }

  const attendance = attendanceSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  attendance.sort((a, b) => {
    const aTime = asDate(a.shiftStartAt || a.clockInAt || a.createdAt)?.getTime() || 0;
    const bTime = asDate(b.shiftStartAt || b.clockInAt || b.createdAt)?.getTime() || 0;
    return bTime - aTime;
  });
  const completedAttendance = attendance.filter((row) => clean(row.status).toLowerCase() === "completed").length;

  const start = asDate(data.developmentCampStartDate || data.firstActualShiftAt || data.hireDate);
  const through = asDate(data.developmentCampThrough);
  const now = new Date();
  const totalMs = start && through ? Math.max(1, through.getTime() - start.getTime()) : 0;
  const elapsedMs = start ? Math.max(0, Math.min(totalMs || 1, now.getTime() - start.getTime())) : 0;

  return {
    rep: repDetailRecord(data, rep.ref.id),
    monthlyQualifications: qualificationsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
    roleHistory: roleHistorySnap.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
    programDirector: pdSnap?.exists ? { repId: pdSnap.id, ...(pdSnap.data() || {}) } : null,
    regionalDirector: directorSnap?.exists ? { repId: directorSnap.id, ...(directorSnap.data() || {}) } : null,
    developmentCamp: {
      status: data.developmentCampStatus || null,
      startAt: data.developmentCampStartDate || data.firstActualShiftAt || data.hireDate || null,
      through: data.developmentCampThrough || null,
      progressPercent: totalMs ? Math.round((elapsedMs / totalMs) * 100) : 0,
      qualified: data.developmentCampQualified ?? null,
      x: Number(data.developmentCampX || 0),
      revenue: Number(data.developmentCampRevenue || 0),
      salesCount: Number(data.developmentCampSalesCount || 0),
      bonusAmount: Number(data.developmentCampBonusAmount || 0),
      decision: data.developmentCampDecision || null,
      decisionReason: data.developmentCampDecisionReason || null,
    },
    firstActualShiftAt: data.firstActualShiftAt || null,
    attendance: { completedCount: completedAttendance, recent: attendance.slice(0, 25) },
    sixWeekMeeting: meeting,
    promotions: promotionsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
    activeWork: await previewDeactivation(db, rep.ref.id),
    auditHistory: auditsSnap.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => (asDate(b.createdAt)?.getTime() || 0) - (asDate(a.createdAt)?.getTime() || 0)),
  };
}

module.exports = { getRepLifecycle, repDetailRecord, chunk, retryOnboarding, createCampMeeting, schedulePromotion, correctAttendance, previewCampDecision, recordFirstActualShift, completeCamp, extendCamp, approvePromotion, previewDeactivation, reassignActiveWork, deactivateRep };
