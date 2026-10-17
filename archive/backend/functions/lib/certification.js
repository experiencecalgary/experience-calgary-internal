"use strict";

const CERTIFICATIONS = [
  {
    certificationId: "EC1",
    displayOrder: 1,
    title: "Brand Ambassador Foundations",
    shortTitle: "Foundations",
    tagline: "Learn the Brand",
    description: "Understand Experience Calgary, represent the brand professionally, guide the sales conversation, onboard new members, sell accurately, and recognize core experiences.",
    estimatedMinutes: 20,
    passingScore: 80,
    questionCount: 25,
    unlockRule: "IMMEDIATE",
    completionTitle: "Certified Brand Ambassador",
    badgeLabel: "FOUNDATIONS COMPLETE",
  },
  {
    certificationId: "EC2",
    displayOrder: 2,
    title: "Experience Specialist",
    shortTitle: "Experience Specialist",
    tagline: "Know the Collection",
    description: "Recognize the experience collection, read customer clues, create relevant matches, paint the picture, and recommend the right membership.",
    estimatedMinutes: 22,
    passingScore: 80,
    questionCount: 25,
    unlockRule: "PASS_EC1",
    completionTitle: "Certified Experience Specialist",
    badgeLabel: "EXPERIENCE SPECIALIST",
  },
  {
    certificationId: "EC3",
    displayOrder: 3,
    title: "Experience Calgary Professional",
    shortTitle: "EC Professional",
    tagline: "Build the Future",
    description: "Understand the promotional track, compensation design, leadership structure, company-building philosophy, and long-term growth model.",
    estimatedMinutes: 22,
    passingScore: 80,
    questionCount: 25,
    unlockRule: "PASS_EC2",
    completionTitle: "Certified Experience Calgary Professional",
    badgeLabel: "EC PROFESSIONAL",
  },
];

const CERTIFICATION_MAP = new Map(CERTIFICATIONS.map((item) => [item.certificationId, item]));
const ATTEMPT_MODES = new Set(["PRACTICE", "CERTIFICATION"]);
const ATTEMPT_LIFETIME_MS = 6 * 60 * 60 * 1000;

function clean(value) {
  return value == null ? "" : String(value).trim();
}

function normalizeRepId(value) {
  return clean(value);
}

function normalizeOption(value) {
  const option = clean(value).toUpperCase();
  return ["A", "B", "C", "D"].includes(option) ? option : "";
}

function error(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function timestampToIso(value) {
  if (!value) return null;
  const date = typeof value.toDate === "function" ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function shuffle(items) {
  const output = items.slice();
  for (let index = output.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [output[index], output[randomIndex]] = [output[randomIndex], output[index]];
  }
  return output;
}

function publicRep(uid, user) {
  return {
    uid,
    repId: clean(user.repId),
    fullName: clean(user.fullName || user.displayName || user.name),
    email: clean(user.email),
    role: clean(user.role || user.roleId),
    status: clean(user.status),
  };
}

function publicQuestion(question) {
  return {
    questionId: clean(question.questionId),
    section: clean(question.section || "GENERAL"),
    difficulty: clean(question.difficulty),
    question: clean(question.question),
    context: clean(question.context),
    options: {
      A: clean(question.options?.A),
      B: clean(question.options?.B),
      C: clean(question.options?.C),
      D: clean(question.options?.D),
    },
    displayImageUrl: clean(question.displayImageUrl),
    displayOrder: Number(question.displayOrder || 0),
  };
}

function initialProgress(certificationId, FieldValue) {
  const unlocked = certificationId === "EC1";
  return {
    certificationId,
    status: unlocked ? "AVAILABLE" : "LOCKED",
    unlocked,
    passed: false,
    practiceAttempts: 0,
    certificationAttempts: 0,
    bestPracticeScore: null,
    bestCertificationScore: null,
    latestCertificationScore: null,
    completedAt: null,
    lastAttemptAt: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

function progressForClient(certification, data = {}) {
  return {
    ...certification,
    status: clean(data.status) || (certification.certificationId === "EC1" ? "AVAILABLE" : "LOCKED"),
    unlocked: data.unlocked === true || certification.certificationId === "EC1",
    passed: data.passed === true,
    practiceAttempts: Number(data.practiceAttempts || 0),
    certificationAttempts: Number(data.certificationAttempts || 0),
    bestPracticeScore: data.bestPracticeScore == null ? null : Number(data.bestPracticeScore),
    bestCertificationScore: data.bestCertificationScore == null ? null : Number(data.bestCertificationScore),
    latestCertificationScore: data.latestCertificationScore == null ? null : Number(data.latestCertificationScore),
    completedAt: timestampToIso(data.completedAt),
    lastAttemptAt: timestampToIso(data.lastAttemptAt),
  };
}

module.exports = function createCertificationService({ admin, db, logger }) {
  const FieldValue = admin.firestore.FieldValue;

  async function findRepById(repIdValue) {
    const repId = normalizeRepId(repIdValue);
    if (!repId) throw error("Enter your Sales Rep ID.", 400);

    const snapshot = await db.collection("users").where("repId", "==", repId).limit(10).get();
    const matches = snapshot.docs.filter((doc) => clean(doc.data()?.userType).toLowerCase() === "rep");
    if (!matches.length) throw error("No Experience Calgary rep was found with that Sales Rep ID.", 404);
    if (matches.length > 1) {
      logger.error("CERTIFICATION_DUPLICATE_REP_ID", { repId, matches: matches.map((doc) => doc.id) });
      throw error("This Sales Rep ID requires administrator review.", 409);
    }

    const userDoc = matches[0];
    const user = userDoc.data() || {};
    if (clean(user.status).toLowerCase() === "inactive" || user.active === false) {
      throw error("This Sales Rep ID is not active.", 403);
    }
    return { userRef: userDoc.ref, uid: userDoc.id, user, rep: publicRep(userDoc.id, user) };
  }

  async function ensureProgress(repContext) {
    const progressCollection = repContext.userRef.collection("certificationProgress");
    const snapshots = await Promise.all(CERTIFICATIONS.map((item) => progressCollection.doc(item.certificationId).get()));
    const batch = db.batch();
    let writes = 0;
    snapshots.forEach((snapshot, index) => {
      if (!snapshot.exists) {
        batch.set(snapshot.ref, initialProgress(CERTIFICATIONS[index].certificationId, FieldValue));
        writes += 1;
      }
    });
    if (writes) await batch.commit();
  }

  async function getDashboard(repId) {
    const repContext = await findRepById(repId);
    await ensureProgress(repContext);
    const progressSnap = await repContext.userRef.collection("certificationProgress").get();
    const progressMap = new Map(progressSnap.docs.map((doc) => [doc.id, doc.data() || {}]));
    return {
      rep: repContext.rep,
      certifications: CERTIFICATIONS.map((item) => progressForClient(item, progressMap.get(item.certificationId))),
    };
  }

  async function getActiveContent() {
    const configSnap = await db.collection("certificationConfig").doc("current").get();
    const config = configSnap.data() || {};
    const activeVersion = clean(config.activeVersion);
    if (!activeVersion) throw error("Certification questions have not been synchronized yet.", 503);
    return { activeVersion, config };
  }

  async function loadAttempt(repId, attemptIdValue) {
    const repContext = await findRepById(repId);
    const attemptId = clean(attemptIdValue);
    if (!attemptId) throw error("Attempt ID is required.");
    const attemptRef = repContext.userRef.collection("certificationAttempts").doc(attemptId);
    const attemptSnap = await attemptRef.get();
    if (!attemptSnap.exists) throw error("This certification attempt was not found.", 404);
    const attempt = attemptSnap.data() || {};
    return { ...repContext, attemptRef, attempt, attemptId };
  }

  async function loadVersionQuestions(versionId, certificationId) {
    const snapshot = await db.collection("certificationQuestionVersions").doc(versionId)
      .collection("questions").where("certificationId", "==", certificationId).get();
    return snapshot.docs.map((doc) => ({ questionId: doc.id, ...doc.data() })).filter((item) => item.active === true);
  }

  async function startAttempt({ repId, certificationId: rawCertificationId, mode: rawMode }) {
    const certificationId = clean(rawCertificationId).toUpperCase();
    const mode = clean(rawMode).toUpperCase();
    const certification = CERTIFICATION_MAP.get(certificationId);
    if (!certification) throw error("Invalid certification stage.");
    if (!ATTEMPT_MODES.has(mode)) throw error("Attempt mode must be PRACTICE or CERTIFICATION.");

    const repContext = await findRepById(repId);
    await ensureProgress(repContext);
    const progressSnap = await repContext.userRef.collection("certificationProgress").doc(certificationId).get();
    if (!progressSnap.exists) {
      throw error("Certification progress was not found.", 404);
    }

    const progress = progressSnap.data() || {};
    if (mode === "CERTIFICATION" && progress.unlocked !== true) {
      throw error(
        "Complete the previous certification before beginning this official exam.",
        403
      );
    }

    const { activeVersion } = await getActiveContent();
    const available = await loadVersionQuestions(activeVersion, certificationId);
    if (available.length < certification.questionCount) {
      throw error(`${certificationId} does not have enough active questions.`, 503);
    }
    const selected = shuffle(available).slice(0, certification.questionCount);
    const attemptRef = repContext.userRef.collection("certificationAttempts").doc();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ATTEMPT_LIFETIME_MS);
    const attempt = {
      attemptId: attemptRef.id,
      repId: repContext.rep.repId,
      ownerUid: repContext.uid,
      certificationId,
      certificationTitle: certification.title,
      mode,
      contentVersion: activeVersion,
      questionIds: selected.map((item) => item.questionId),
      totalQuestions: selected.length,
      status: "IN_PROGRESS",
      startedAt: FieldValue.serverTimestamp(),
      expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
      submittedAt: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    await attemptRef.set(attempt);
    await progressSnap.ref.set({ status: "IN_PROGRESS", lastAttemptAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return {
      attempt: {
        attemptId: attemptRef.id,
        certificationId,
        certificationTitle: certification.title,
        mode,
        contentVersion: activeVersion,
        totalQuestions: selected.length,
        expiresAt: expiresAt.toISOString(),
        questions: selected.map(publicQuestion),
      },
    };
  }

  function assertAttemptAvailable(attempt) {
    if (clean(attempt.status) !== "IN_PROGRESS") throw error("This attempt has already been completed.", 409);
    const expiresAt = attempt.expiresAt?.toDate ? attempt.expiresAt.toDate() : new Date(attempt.expiresAt);
    if (!expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) {
      throw error("This attempt has expired. Return to your dashboard and begin again.", 410);
    }
  }

  async function checkPracticeAnswer({ repId, attemptId, questionId: rawQuestionId, selectedOption: rawOption }) {
    const resolved = await loadAttempt(repId, attemptId);
    assertAttemptAvailable(resolved.attempt);
    if (clean(resolved.attempt.mode) !== "PRACTICE") throw error("Answer coaching is only available in Practice mode.", 403);
    const questionId = clean(rawQuestionId);
    if (!resolved.attempt.questionIds.includes(questionId)) throw error("This question is not part of the attempt.", 403);
    const selectedOption = normalizeOption(rawOption);
    if (!selectedOption) throw error("Select an answer first.");
    const questionSnap = await db.collection("certificationQuestionVersions").doc(resolved.attempt.contentVersion)
      .collection("questions").doc(questionId).get();
    if (!questionSnap.exists) throw error("Question not found.", 404);
    const question = questionSnap.data() || {};
    const correctOption = normalizeOption(question.correctOption);
    return {
      isCorrect: selectedOption === correctOption,
      correctOption,
      correctAnswer: clean(question.options?.[correctOption]),
      explanation: clean(question.explanation),
    };
  }

  async function submitAttempt({ repId, attemptId, answers: rawAnswers, finalReflection, browserInfo }) {
    const resolved = await loadAttempt(repId, attemptId);
    assertAttemptAvailable(resolved.attempt);
    const certification = CERTIFICATION_MAP.get(clean(resolved.attempt.certificationId));
    if (!certification) throw error("Certification stage configuration is missing.", 500);
    const submittedAnswers = Array.isArray(rawAnswers) ? rawAnswers : [];
    const supplied = new Map(submittedAnswers.map((item) => [clean(item?.questionId), item || {}]));

    const questionRefs = resolved.attempt.questionIds.map((questionId) =>
      db.collection("certificationQuestionVersions").doc(resolved.attempt.contentVersion).collection("questions").doc(questionId));
    const questionSnaps = await db.getAll(...questionRefs);
    let earned = 0;
    let available = 0;
    let correctAnswers = 0;
    const sectionScores = {};
    const answerRecords = [];

    questionSnaps.forEach((snapshot, index) => {
      if (!snapshot.exists) throw error("One or more attempt questions are unavailable.", 500);
      const question = { questionId: snapshot.id, ...snapshot.data() };
      const submitted = supplied.get(snapshot.id) || {};
      const selectedOption = normalizeOption(submitted.selectedOption);
      const correctOption = normalizeOption(question.correctOption);
      const pointsAvailable = Number(question.points || 1);
      const isCorrect = selectedOption !== "" && selectedOption === correctOption;
      const pointsEarned = isCorrect ? pointsAvailable : 0;
      const section = clean(question.section || "GENERAL");
      if (!sectionScores[section]) sectionScores[section] = { earned: 0, available: 0, correct: 0, questions: 0 };
      sectionScores[section].earned += pointsEarned;
      sectionScores[section].available += pointsAvailable;
      sectionScores[section].correct += isCorrect ? 1 : 0;
      sectionScores[section].questions += 1;
      earned += pointsEarned;
      available += pointsAvailable;
      correctAnswers += isCorrect ? 1 : 0;
      answerRecords.push({
        questionNumber: index + 1,
        questionId: snapshot.id,
        section,
        questionText: clean(question.question),
        options: question.options || {},
        selectedOption,
        selectedAnswerText: selectedOption ? clean(question.options?.[selectedOption]) : "",
        correctOption,
        correctAnswerText: clean(question.options?.[correctOption]),
        explanation: clean(question.explanation),
        isCorrect,
        pointsEarned,
        pointsAvailable,
        answeredAt: clean(submitted.answeredAt) || null,
      });
    });

    const percentage = available ? Math.round((earned / available) * 100) : 0;
    const passed = percentage >= certification.passingScore;
    const progressRef = resolved.userRef.collection("certificationProgress").doc(certification.certificationId);
    const nextCertification = CERTIFICATIONS[certification.displayOrder] || null;

    await db.runTransaction(async (tx) => {
      const freshAttempt = await tx.get(resolved.attemptRef);
      if (!freshAttempt.exists || clean(freshAttempt.data()?.status) !== "IN_PROGRESS") {
        throw error("This attempt has already been submitted.", 409);
      }
      const progressSnap = await tx.get(progressRef);
      const progress = progressSnap.data() || {};
      const isPractice = resolved.attempt.mode === "PRACTICE";
      const progressUpdate = {
        status: isPractice
          ? (
              progress.passed
                ? "COMPLETE"
                : progress.unlocked === true
                  ? "AVAILABLE"
                  : "LOCKED"
            )
          : (passed ? "COMPLETE" : "RETAKE_AVAILABLE"),
        lastAttemptAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (isPractice) {
        progressUpdate.practiceAttempts = Number(progress.practiceAttempts || 0) + 1;
        progressUpdate.bestPracticeScore = Math.max(Number(progress.bestPracticeScore || 0), percentage);
      } else {
        progressUpdate.certificationAttempts = Number(progress.certificationAttempts || 0) + 1;
        progressUpdate.latestCertificationScore = percentage;
        progressUpdate.bestCertificationScore = Math.max(Number(progress.bestCertificationScore || 0), percentage);
        progressUpdate.passed = progress.passed === true || passed;
        if (passed && !progress.completedAt) progressUpdate.completedAt = FieldValue.serverTimestamp();
      }
      tx.set(progressRef, progressUpdate, { merge: true });
      if (!isPractice && passed && nextCertification) {
        tx.set(resolved.userRef.collection("certificationProgress").doc(nextCertification.certificationId), {
          certificationId: nextCertification.certificationId,
          unlocked: true,
          status: "AVAILABLE",
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      tx.update(resolved.attemptRef, {
        status: "COMPLETED",
        submittedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        correctAnswers,
        totalScore: earned,
        totalAvailable: available,
        percentage,
        passed,
        passingScore: certification.passingScore,
        sectionScores,
        finalReflection: clean(finalReflection).slice(0, 5000),
        browserInfo: clean(browserInfo).slice(0, 1000),
      });
    });

    const writer = db.bulkWriter();
    answerRecords.forEach((record) => {
      writer.set(resolved.attemptRef.collection("answers").doc(record.questionId), {
        ...record,
        contentVersion: resolved.attempt.contentVersion,
        createdAt: FieldValue.serverTimestamp(),
      });
    });
    await writer.close();

    return {
      result: {
        attemptId: resolved.attemptId,
        mode: resolved.attempt.mode,
        certificationId: certification.certificationId,
        certificationTitle: certification.title,
        percentage,
        passed,
        passingScore: certification.passingScore,
        correctAnswers,
        totalQuestions: answerRecords.length,
        sectionScores,
        showCorrectAnswers: resolved.attempt.mode === "PRACTICE",
        answers: resolved.attempt.mode === "PRACTICE" ? answerRecords : [],
      },
    };
  }

  return {
    certifications: CERTIFICATIONS,
    findRepById,
    getDashboard,
    startAttempt,
    checkPracticeAnswer,
    submitAttempt,
  };
};
