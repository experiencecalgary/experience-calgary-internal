"use strict";

const crypto = require("crypto");

const ALLOWED_CERTIFICATION_IDS = new Set(["EC1", "EC2", "EC3"]);
const ALLOWED_OPTIONS = new Set(["A", "B", "C", "D"]);
const MIN_ACTIVE_QUESTIONS_PER_CERTIFICATION = 25;
const MAX_QUESTIONS_PER_SYNC = 2000;
const MAX_TEXT_LENGTH = 20000;
const MAX_VALIDATION_ERRORS = 100;

function clean(value) {
  return value == null ? "" : String(value).trim();
}

function readSecret(secretOrString) {
  if (!secretOrString) return "";
  if (typeof secretOrString === "string") return secretOrString;
  if (typeof secretOrString.value === "function") {
    return clean(secretOrString.value());
  }
  return "";
}

function safeSecretEqual(received, expected) {
  const left = Buffer.from(clean(received), "utf8");
  const right = Buffer.from(clean(expected), "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function normalizeBoolean(value) {
  if (value === true || value === false) return value;
  const normalized = clean(value).toLowerCase();
  if (["true", "yes", "1"].includes(normalized)) return true;
  if (["false", "no", "0", ""].includes(normalized)) return false;
  return null;
}

function normalizeNumber(value, fallback) {
  if (value === "" || value == null) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeQuestion(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    questionId: clean(source.questionId).toUpperCase(),
    active: normalizeBoolean(source.active),
    certificationId: clean(source.certificationId).toUpperCase(),
    section: clean(source.section),
    difficulty: clean(source.difficulty),
    question: clean(source.question),
    context: clean(source.context),
    options: {
      A: clean(source.optionA ?? source.options?.A),
      B: clean(source.optionB ?? source.options?.B),
      C: clean(source.optionC ?? source.options?.C),
      D: clean(source.optionD ?? source.options?.D),
    },
    correctOption: clean(source.correctOption).toUpperCase(),
    explanation: clean(source.explanation),
    points: normalizeNumber(source.points, 1),
    randomGroup: clean(source.randomGroup),
    displayImageUrl: clean(source.displayImageUrl),
    displayOrder: normalizeNumber(source.displayOrder, 0),
    managerNotes: clean(source.managerNotes),
  };
}

function validateUrl(value) {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch (error) {
    return false;
  }
}

function validateQuestions(rawQuestions) {
  const errors = [];
  const warnings = [];
  const seenIds = new Set();
  const seenQuestionText = new Map();
  const counts = {
    total: 0,
    active: 0,
    inactive: 0,
    EC1: { total: 0, active: 0 },
    EC2: { total: 0, active: 0 },
    EC3: { total: 0, active: 0 },
  };

  function addError(message) {
    if (errors.length < MAX_VALIDATION_ERRORS) errors.push(message);
  }

  if (!Array.isArray(rawQuestions)) {
    return { ok: false, errors: ["Body must contain a questions array."], warnings, questions: [], counts };
  }

  if (!rawQuestions.length) {
    return { ok: false, errors: ["The questions array is empty."], warnings, questions: [], counts };
  }

  if (rawQuestions.length > MAX_QUESTIONS_PER_SYNC) {
    return {
      ok: false,
      errors: [`A sync may contain no more than ${MAX_QUESTIONS_PER_SYNC} questions.`],
      warnings,
      questions: [],
      counts,
    };
  }

  const questions = rawQuestions.map(normalizeQuestion);

  questions.forEach((question, index) => {
    const row = index + 2;
    const label = question.questionId || `row ${row}`;
    counts.total += 1;

    if (!question.questionId) {
      addError(`Row ${row}: Question ID is required.`);
    } else if (!/^[A-Z0-9][A-Z0-9_-]{1,99}$/.test(question.questionId)) {
      addError(`${label}: Question ID may contain only letters, numbers, hyphens and underscores.`);
    } else if (seenIds.has(question.questionId)) {
      addError(`${label}: Duplicate Question ID.`);
    } else {
      seenIds.add(question.questionId);
    }

    if (!ALLOWED_CERTIFICATION_IDS.has(question.certificationId)) {
      addError(`${label}: Certification ID must be EC1, EC2 or EC3.`);
    } else {
      counts[question.certificationId].total += 1;
      if (question.active === true) counts[question.certificationId].active += 1;
    }

    if (question.active === null) {
      addError(`${label}: Active must be TRUE or FALSE.`);
    } else if (question.active) {
      counts.active += 1;
    } else {
      counts.inactive += 1;
    }

    if (!question.section) addError(`${label}: Section is required.`);
    if (!question.question) addError(`${label}: Question text is required.`);

    Object.entries(question.options).forEach(([key, value]) => {
      if (!value) addError(`${label}: Option ${key} is required.`);
    });

    if (!ALLOWED_OPTIONS.has(question.correctOption)) {
      addError(`${label}: Correct Option must be A, B, C or D.`);
    }

    if (question.points === null || question.points <= 0 || question.points > 100) {
      addError(`${label}: Points must be a number greater than 0 and no more than 100.`);
    }

    if (question.displayOrder === null || question.displayOrder < 0) {
      addError(`${label}: Display Order must be zero or a positive number.`);
    }

    if (!validateUrl(question.displayImageUrl)) {
      addError(`${label}: Display Image URL must be a valid HTTP or HTTPS URL.`);
    }

    const textFields = [
      ["Question", question.question],
      ["Context", question.context],
      ["Explanation", question.explanation],
      ["Manager Notes", question.managerNotes],
      ...Object.entries(question.options).map(([key, value]) => [`Option ${key}`, value]),
    ];
    textFields.forEach(([name, value]) => {
      if (Buffer.byteLength(value, "utf8") > MAX_TEXT_LENGTH) {
        addError(`${label}: ${name} is too long.`);
      }
    });

    if (question.active && !question.explanation) {
      warnings.push(`${label}: Active question has no explanation.`);
    }

    const normalizedText = question.question.toLowerCase().replace(/\s+/g, " ").trim();
    if (normalizedText) {
      const priorId = seenQuestionText.get(normalizedText);
      if (priorId && priorId !== question.questionId) {
        warnings.push(`${label}: Question text duplicates ${priorId}.`);
      } else {
        seenQuestionText.set(normalizedText, question.questionId);
      }
    }
  });

  for (const certificationId of ALLOWED_CERTIFICATION_IDS) {
    const activeCount = counts[certificationId].active;
    if (activeCount < MIN_ACTIVE_QUESTIONS_PER_CERTIFICATION) {
      addError(
        `${certificationId}: At least ${MIN_ACTIVE_QUESTIONS_PER_CERTIFICATION} active questions are required; found ${activeCount}.`
      );
    }
  }

  return { ok: errors.length === 0, errors, warnings, questions, counts };
}

function canonicalQuestion(question) {
  return {
    questionId: question.questionId,
    active: question.active,
    certificationId: question.certificationId,
    section: question.section,
    difficulty: question.difficulty,
    question: question.question,
    context: question.context,
    options: question.options,
    correctOption: question.correctOption,
    explanation: question.explanation,
    points: question.points,
    randomGroup: question.randomGroup,
    displayImageUrl: question.displayImageUrl,
    displayOrder: question.displayOrder,
    managerNotes: question.managerNotes,
  };
}

function contentHash(questions) {
  const canonical = questions
    .map(canonicalQuestion)
    .sort((a, b) => a.questionId.localeCompare(b.questionId));
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function createVersionId(hash) {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  return `v_${timestamp}_${hash.slice(0, 10)}`;
}

async function writeQuestionVersion({ admin, db, questions, counts, hash, source }) {
  const FieldValue = admin.firestore.FieldValue;
  const versionId = createVersionId(hash);
  const versionRef = db.collection("certificationQuestionVersions").doc(versionId);

  await versionRef.set({
    versionId,
    contentHash: hash,
    status: "publishing",
    source,
    counts,
    createdAt: FieldValue.serverTimestamp(),
    activatedAt: null,
  });

  const writer = db.bulkWriter();
  let writeFailure = null;

  writer.onWriteError((error) => {
    if (error.failedAttempts < 3) return true;
    writeFailure = error;
    return false;
  });

  for (const question of questions) {
    const questionRef = versionRef.collection("questions").doc(question.questionId);
    writer.set(questionRef, {
      ...canonicalQuestion(question),
      contentVersion: versionId,
      syncedAt: FieldValue.serverTimestamp(),
    });
  }

  try {
    await writer.close();
    if (writeFailure) throw writeFailure;
  } catch (error) {
    await versionRef.set({
      status: "failed",
      error: clean(error.message).slice(0, 1000),
      failedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    throw error;
  }

  const configRef = db.collection("certificationConfig").doc("current");

  await db.runTransaction(async (tx) => {
    const configSnap = await tx.get(configRef);
    const previousVersionId = clean(configSnap.data()?.activeVersion);

    tx.update(versionRef, {
      status: "active",
      activatedAt: FieldValue.serverTimestamp(),
      previousVersionId: previousVersionId || null,
    });

    tx.set(configRef, {
      activeVersion: versionId,
      contentHash: hash,
      questionCount: counts.total,
      activeQuestionCount: counts.active,
      counts,
      source,
      syncedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    if (previousVersionId && previousVersionId !== versionId) {
      const previousRef = db.collection("certificationQuestionVersions").doc(previousVersionId);
      tx.set(previousRef, {
        status: "archived",
        supersededBy: versionId,
        archivedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
  });

  return versionId;
}

module.exports = function registerCertificationSyncRoutes(app, {
  admin,
  db,
  logger,
  CERTIFICATION_SYNC_SECRET,
}) {
  if (!app || !admin || !db) {
    throw new Error("Certification sync route is missing required dependencies.");
  }

  app.get("/admin/syncCertificationQuestions/health", (req, res) => {
    return res.status(200).json({
      ok: true,
      system: "certificationQuestionSync",
      timestamp: new Date().toISOString(),
    });
  });

  app.post("/admin/syncCertificationQuestions", async (req, res) => {
    const expectedSecret = readSecret(CERTIFICATION_SYNC_SECRET);
    const receivedSecret = req.get("x-certification-secret");

    if (!expectedSecret) {
      logger.error("CERTIFICATION_SYNC_SECRET_MISSING");
      return res.status(500).json({
        ok: false,
        error: "Certification synchronization is not configured.",
      });
    }

    if (!safeSecretEqual(receivedSecret, expectedSecret)) {
      logger.warn("CERTIFICATION_SYNC_UNAUTHORIZED", {
        ip: req.ip,
        userAgent: clean(req.get("user-agent")).slice(0, 300),
      });
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    try {
      const validation = validateQuestions(req.body?.questions);

      if (!validation.ok) {
        logger.warn("CERTIFICATION_SYNC_VALIDATION_FAILED", {
          errorCount: validation.errors.length,
          counts: validation.counts,
        });
        return res.status(400).json({
          ok: false,
          error: "Question validation failed.",
          validationErrors: validation.errors,
          warnings: validation.warnings.slice(0, MAX_VALIDATION_ERRORS),
          counts: validation.counts,
        });
      }

      const hash = contentHash(validation.questions);
      const configRef = db.collection("certificationConfig").doc("current");
      const configSnap = await configRef.get();
      const current = configSnap.data() || {};

      if (clean(current.contentHash) === hash && clean(current.activeVersion)) {
        return res.status(200).json({
          ok: true,
          noChanges: true,
          message: "Firestore already contains this exact question bank.",
          activeVersion: clean(current.activeVersion),
          contentHash: hash,
          counts: validation.counts,
          warnings: validation.warnings.slice(0, MAX_VALIDATION_ERRORS),
        });
      }

      const source = {
        system: "google_sheets",
        spreadsheetId: clean(req.body?.source?.spreadsheetId),
        spreadsheetName: clean(req.body?.source?.spreadsheetName),
        sheetName: clean(req.body?.source?.sheetName) || "Questions",
        requestedBy: clean(req.body?.source?.requestedBy),
      };

      const versionId = await writeQuestionVersion({
        admin,
        db,
        questions: validation.questions,
        counts: validation.counts,
        hash,
        source,
      });

      logger.info("CERTIFICATION_SYNC_COMPLETED", {
        versionId,
        contentHash: hash,
        counts: validation.counts,
        warningCount: validation.warnings.length,
      });

      return res.status(200).json({
        ok: true,
        noChanges: false,
        message: "Certification questions synchronized successfully.",
        activeVersion: versionId,
        contentHash: hash,
        counts: validation.counts,
        warnings: validation.warnings.slice(0, MAX_VALIDATION_ERRORS),
      });
    } catch (error) {
      logger.error("CERTIFICATION_SYNC_FAILED", {
        message: clean(error.message),
        stack: clean(error.stack).slice(0, 4000),
      });
      return res.status(500).json({
        ok: false,
        error: "Certification question synchronization failed.",
      });
    }
  });
};
