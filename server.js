const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
try {
  require("dotenv").config();
} catch (error) {
  // dotenv is optional during local fallback mode
}
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "kuizzosh.sqlite");
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").trim();
const SUPABASE_ANON_KEY = String(process.env.SUPABASE_ANON_KEY || "").trim();
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const USE_POSTGRES = Boolean(DATABASE_URL);
const USE_SUPABASE_AUTH = Boolean(
  SUPABASE_URL && SUPABASE_ANON_KEY && SUPABASE_SERVICE_ROLE_KEY
);

fs.mkdirSync(DATA_DIR, { recursive: true });

let db = null;
let pool = null;
let sessionStore = null;
let supabaseModulePromise = null;
let supabaseAdminClientPromise = null;

if (USE_POSTGRES) {
  const { Pool } = require("pg");
  const PgSession = require("connect-pg-simple")(session);

  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes("localhost")
      ? false
      : {
          rejectUnauthorized: false
        }
  });

  sessionStore = new PgSession({
    pool,
    tableName: "user_sessions",
    createTableIfMissing: true
  });
} else {
  const SQLiteStore = require("connect-sqlite3")(session);
  const sqlite3 = require("sqlite3").verbose();

  db = new sqlite3.Database(DB_PATH);
  sessionStore = new SQLiteStore({
    db: "sessions.sqlite",
    dir: DATA_DIR
  });
}

function toPostgresSql(sql) {
  let parameterIndex = 0;
  return String(sql || "").replace(/\?/g, () => `$${++parameterIndex}`);
}

async function dbRun(sql, params = [], executor = null) {
  if (USE_POSTGRES) {
    const runner = executor || pool;
    const trimmedSql = String(sql || "").trim();
    const postgresSql =
      /^\s*insert\b/i.test(trimmedSql) && !/\breturning\b/i.test(trimmedSql)
        ? `${trimmedSql} RETURNING id`
        : trimmedSql;
    const result = await runner.query(toPostgresSql(postgresSql), params);

    return {
      lastID: result.rows[0]?.id || null,
      changes: result.rowCount
    };
  }

  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }

      resolve(this);
    });
  });
}

async function dbGet(sql, params = [], executor = null) {
  if (USE_POSTGRES) {
    const runner = executor || pool;
    const result = await runner.query(toPostgresSql(sql), params);
    return result.rows[0];
  }

  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(row);
    });
  });
}

async function dbAll(sql, params = [], executor = null) {
  if (USE_POSTGRES) {
    const runner = executor || pool;
    const result = await runner.query(toPostgresSql(sql), params);
    return result.rows;
  }

  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(rows);
    });
  });
}

async function withTransaction(callback) {
  if (USE_POSTGRES) {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  await dbRun("BEGIN TRANSACTION");

  try {
    const result = await callback(null);
    await dbRun("COMMIT");
    return result;
  } catch (error) {
    await dbRun("ROLLBACK");
    throw error;
  }
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

async function loadSupabaseModule() {
  if (!supabaseModulePromise) {
    supabaseModulePromise = import("@supabase/supabase-js");
  }

  return supabaseModulePromise;
}

function getSupabaseClientOptions() {
  return {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false
    }
  };
}

async function createSupabasePublicClient() {
  if (!USE_SUPABASE_AUTH) {
    throw new Error("Supabase Auth is not configured.");
  }

  const { createClient } = await loadSupabaseModule();
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, getSupabaseClientOptions());
}

async function getSupabaseAdminClient() {
  if (!USE_SUPABASE_AUTH) {
    throw new Error("Supabase Auth is not configured.");
  }

  if (!supabaseAdminClientPromise) {
    supabaseAdminClientPromise = loadSupabaseModule().then(({ createClient }) =>
      createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, getSupabaseClientOptions())
    );
  }

  return supabaseAdminClientPromise;
}

function getSupabaseUserDisplayName(authUser) {
  const metadata = authUser?.user_metadata || authUser?.raw_user_meta_data || {};
  const preferredName = String(metadata.full_name || metadata.name || "").trim();

  if (preferredName) {
    return preferredName;
  }

  return buildDefaultNameFromEmail(authUser?.email);
}

function buildDefaultNameFromEmail(email) {
  const normalized = normalizeEmail(email);
  const localPart = normalized.split("@")[0];

  if (!localPart) {
    return "Kuizzosh Host";
  }

  return localPart
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function isSupabaseEmailAlreadyRegisteredError(error) {
  const message = String(error?.message || "").toLowerCase();

  return (
    message.includes("already registered") ||
    message.includes("already been registered") ||
    message.includes("already exists") ||
    message.includes("duplicate")
  );
}

async function getUserById(userId) {
  return dbGet(
    `
      SELECT id, name, email, password_hash, supabase_auth_user_id, created_at
      FROM users
      WHERE id = ?
    `,
    [userId]
  );
}

async function getUserByEmail(email) {
  return dbGet(
    `
      SELECT id, name, email, password_hash, supabase_auth_user_id, created_at
      FROM users
      WHERE email = ?
    `,
    [normalizeEmail(email)]
  );
}

async function getUserBySupabaseAuthUserId(authUserId) {
  return dbGet(
    `
      SELECT id, name, email, password_hash, supabase_auth_user_id, created_at
      FROM users
      WHERE supabase_auth_user_id = ?
    `,
    [String(authUserId || "").trim()]
  );
}

async function syncLocalUserWithSupabaseAuthUser(authUser, options = {}) {
  const authUserId = String(authUser?.id || "").trim();
  const email = normalizeEmail(authUser?.email);
  const allowCreate = options.createIfMissing !== false;

  if (!authUserId || !email) {
    throw new Error("Supabase auth user is missing an id or email.");
  }

  let localUser = await getUserBySupabaseAuthUserId(authUserId);

  if (localUser) {
    return localUser;
  }

  localUser = await getUserByEmail(email);

  if (localUser) {
    const nextName = localUser.name || getSupabaseUserDisplayName(authUser);
    await dbRun(
      `
        UPDATE users
        SET name = ?, email = ?, supabase_auth_user_id = ?
        WHERE id = ?
      `,
      [nextName, email, authUserId, localUser.id]
    );

    return getUserById(localUser.id);
  }

  if (!allowCreate) {
    return null;
  }

  const insertResult = await dbRun(
    `
      INSERT INTO users (name, email, password_hash, supabase_auth_user_id)
      VALUES (?, ?, ?, ?)
    `,
    [getSupabaseUserDisplayName(authUser), email, "", authUserId]
  );

  return getUserById(insertResult.lastID);
}

async function signInWithSupabase(email, password) {
  const supabase = await createSupabasePublicClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password
  });

  if (error) {
    throw error;
  }

  if (!data.user) {
    throw new Error("Supabase did not return a user.");
  }

  return data.user;
}

async function registerWithSupabase({ name, email, password }) {
  const supabaseAdmin = await getSupabaseAdminClient();
  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      full_name: name,
      name
    }
  });

  if (error) {
    throw error;
  }

  if (!data.user) {
    throw new Error("Supabase did not return the created user.");
  }

  return data.user;
}

function normalizeVisibility(value) {
  return value === "public" ? "public" : "private";
}

function isValidDateInput(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function formatShortDate(value) {
  const [year, month, day] = String(value || "").split("-");
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthIndex = Number(month) - 1;
  const dayNumber = Number(day);

  if (!year || monthIndex < 0 || monthIndex > 11 || Number.isNaN(dayNumber)) {
    return value;
  }

  return {
    year: Number(year),
    monthIndex,
    monthLabel: monthNames[monthIndex],
    dayNumber
  };
}

function buildDurationLabel(startDate, endDate) {
  const start = formatShortDate(startDate);
  const end = formatShortDate(endDate);

  if (!start || !end || typeof start === "string" || typeof end === "string") {
    return `${startDate} - ${endDate}`;
  }

  if (
    start.year === end.year &&
    start.monthIndex === end.monthIndex &&
    start.dayNumber === end.dayNumber
  ) {
    return `${start.monthLabel} ${start.dayNumber}`;
  }

  if (start.year === end.year && start.monthIndex === end.monthIndex) {
    return `${start.monthLabel} ${start.dayNumber} - ${end.dayNumber}`;
  }

  return `${start.monthLabel} ${start.dayNumber} - ${end.monthLabel} ${end.dayNumber}`;
}

function getCurrentDateInTimeZone(timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const parts = formatter.formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  return `${year}-${month}-${day}`;
}

function getKuizzoshStatus(startDate, endDate, currentDate) {
  if (currentDate >= startDate && currentDate <= endDate) {
    return "active";
  }

  return "inactive";
}

const MODULE_PAGE_CONFIG = {
  quizzes: {
    dbType: "quiz",
    pageTitle: "Quizzes",
    singular: "Quiz",
    description: "Create and manage quizzes directly from this page."
  },
  polls: {
    dbType: "poll",
    pageTitle: "Polls",
    singular: "Poll",
    description: "Create and manage polls directly from this page."
  },
  rankings: {
    dbType: "ranking",
    pageTitle: "Rankings",
    singular: "Ranking",
    description: "Create and manage rankings directly from this page."
  }
};

function getModuleFlashKey(pageKey) {
  return `${pageKey}Flash`;
}

function parseItemId(value) {
  const itemId = Number.parseInt(value, 10);
  return Number.isInteger(itemId) && itemId > 0 ? itemId : null;
}

function buildDuplicateTitle(title) {
  const suffix = " Copy";
  const baseTitle = String(title || "").trim();

  if (baseTitle.length <= 120 - suffix.length) {
    return `${baseTitle}${suffix}`;
  }

  return `${baseTitle.slice(0, 120 - suffix.length).trimEnd()}${suffix}`;
}

async function generateUniqueQuizCode(usedCodes = null) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const quizCode = String(Math.floor(100000 + Math.random() * 900000));

    if (usedCodes) {
      if (!usedCodes.has(quizCode)) {
        usedCodes.add(quizCode);
        return quizCode;
      }

      continue;
    }

    const existingItem = await dbGet(
      "SELECT id FROM kuizzosh_items WHERE quiz_code = ?",
      [quizCode]
    );

    if (!existingItem) {
      return quizCode;
    }
  }

  throw new Error("Unable to generate a unique quiz code.");
}

async function generateUniqueModuleQuizCode(usedCodes = null) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const quizCode = String(Math.floor(100000 + Math.random() * 900000));

    if (usedCodes) {
      if (!usedCodes.has(quizCode)) {
        usedCodes.add(quizCode);
        return quizCode;
      }

      continue;
    }

    const existingItem = await dbGet(
      "SELECT id FROM module_items WHERE quiz_code = ?",
      [quizCode]
    );

    if (!existingItem) {
      return quizCode;
    }
  }

  throw new Error("Unable to generate a unique module quiz code.");
}

function parseBooleanFlag(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return value === true || value === "true" || value === "on" || value === 1 || value === "1";
}

function normalizeQuestionType(value) {
  const questionType = String(value || "").trim();
  const allowedTypes = ["single_choice", "multiple_choice", "true_false"];
  return allowedTypes.includes(questionType) ? questionType : "single_choice";
}

function normalizeInteger(value, fallback, min, max) {
  const nextValue = Number.parseInt(value, 10);

  if (!Number.isInteger(nextValue)) {
    return fallback;
  }

  if (nextValue < min) {
    return min;
  }

  if (nextValue > max) {
    return max;
  }

  return nextValue;
}

const QUIZ_LIVE_STATUSES = {
  LOBBY: "lobby",
  QUESTION: "question",
  LEADERBOARD: "leaderboard",
  ENDED: "ended"
};

const QUIZ_LIVE_PHASES = {
  CHART: "chart",
  LEADERBOARD: "leaderboard",
  COUNTDOWN: "countdown"
};

const QUIZ_CHART_DURATION_MS = 8000;
const QUIZ_LEADERBOARD_DURATION_MS = 5000;
const QUIZ_COUNTDOWN_DURATION_MS = 5000;

function createRandomToken() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return crypto.randomBytes(16).toString("hex");
}

function toIsoString(value) {
  if (!value) {
    return "";
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function formatMillisecondsAsSeconds(value) {
  const nextValue = Number(value);

  if (!Number.isFinite(nextValue) || nextValue <= 0) {
    return "0.0s";
  }

  return `${(nextValue / 1000).toFixed(1)}s`;
}

function parseChoiceIdList(value) {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];

  return Array.from(
    new Set(
      rawValues
        .map((item) => Number.parseInt(String(item || "").trim(), 10))
        .filter((item) => Number.isInteger(item) && item > 0)
        .sort((left, right) => left - right)
    )
  );
}

function serializeChoiceIdList(choiceIds) {
  return parseChoiceIdList(choiceIds).join(",");
}

function getQuizParticipantStore(req) {
  if (!req.session.quizParticipantStore || typeof req.session.quizParticipantStore !== "object") {
    req.session.quizParticipantStore = {};
  }

  return req.session.quizParticipantStore;
}

function getQuizParticipantEntry(req, quizCode) {
  return getQuizParticipantStore(req)[quizCode] || null;
}

function setQuizParticipantEntry(req, quizCode, entry) {
  getQuizParticipantStore(req)[quizCode] = entry;
}

function clearQuizParticipantEntry(req, quizCode) {
  const store = getQuizParticipantStore(req);
  delete store[quizCode];
}

function toOrderedArray(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  return Object.keys(value)
    .sort((left, right) => Number(left) - Number(right))
    .map((key) => value[key]);
}

const MAX_QUIZ_QUESTION_IMAGE_LENGTH = 2_000_000;

function createDefaultQuizChoice(index, overrides = {}) {
  return {
    label: overrides.label || `Option ${index}`,
    isCorrect: overrides.isCorrect === undefined ? index === 1 : Boolean(overrides.isCorrect)
  };
}

function normalizeQuizQuestionImage(value) {
  const imageValue = String(value || "").trim();

  if (!imageValue || imageValue.length > MAX_QUIZ_QUESTION_IMAGE_LENGTH) {
    return "";
  }

  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(imageValue)) {
    return imageValue;
  }

  if (imageValue.startsWith("/") && !imageValue.startsWith("//")) {
    return imageValue;
  }

  return "";
}

function createDefaultQuizQuestion(index = 1) {
  return {
    prompt: "",
    imageUrl: "",
    questionType: "single_choice",
    points: 100,
    timeLimit: 20,
    showLeaderboard: false,
    choices: [
      createDefaultQuizChoice(1),
      createDefaultQuizChoice(2, { isCorrect: false }),
      createDefaultQuizChoice(3, { isCorrect: false }),
      createDefaultQuizChoice(4, { isCorrect: false })
    ]
  };
}

function createDefaultQuizSection(index = 1) {
  return {
    title: `Section ${index}`,
    questions: [createDefaultQuizQuestion(1)]
  };
}

function createDefaultQuizBuilderState() {
  return {
    sections: [createDefaultQuizSection(1)]
  };
}

function createDefaultQuizSettings() {
  return {
    leaderboardEnabled: true,
    speedBonusEnabled: true,
    showCorrectAnswer: true,
    randomizeQuestions: false,
    randomizeChoices: false
  };
}

function normalizeQuizBuilderState(rawState) {
  const rawSections = toOrderedArray(rawState?.sections);
  const sections = rawSections.map((section, sectionIndex) => {
    const rawQuestions = toOrderedArray(section?.questions);
    const questions = rawQuestions.map((question, questionIndex) => {
      const questionType = normalizeQuestionType(question?.questionType);
      const fallbackChoices =
        questionType === "true_false"
          ? [
              createDefaultQuizChoice(1, { label: "True" }),
              createDefaultQuizChoice(2, { label: "False", isCorrect: false })
            ]
          : createDefaultQuizQuestion(questionIndex + 1).choices;

      const rawChoices = toOrderedArray(question?.choices);
      const choices = (rawChoices.length ? rawChoices : fallbackChoices).map((choice, choiceIndex) => ({
        label: String(choice?.label || "").trim() || fallbackChoices[choiceIndex]?.label || `Option ${choiceIndex + 1}`,
        isCorrect: parseBooleanFlag(choice?.isCorrect, false)
      }));

      return {
        prompt: String(question?.prompt || "").trim(),
        imageUrl: normalizeQuizQuestionImage(question?.imageUrl),
        questionType,
        points: normalizeInteger(question?.points, 100, 10, 1000),
        timeLimit: normalizeInteger(question?.timeLimit, 20, 5, 300),
        showLeaderboard: parseBooleanFlag(question?.showLeaderboard, false),
        choices
      };
    });

    return {
      title: String(section?.title || "").trim() || `Section ${sectionIndex + 1}`,
      questions
    };
  });

  return {
    sections: sections.length ? sections : createDefaultQuizBuilderState().sections
  };
}

function validateQuizBuilderState(rawState) {
  const builderState = normalizeQuizBuilderState(rawState);

  if (!builderState.sections.length) {
    return {
      error: "Add at least one section to the quiz.",
      builderState: createDefaultQuizBuilderState()
    };
  }

  for (let sectionIndex = 0; sectionIndex < builderState.sections.length; sectionIndex += 1) {
    const section = builderState.sections[sectionIndex];

    if (!section.questions.length) {
      return {
        error: `Section ${sectionIndex + 1} needs at least one question.`,
        builderState
      };
    }

    for (let questionIndex = 0; questionIndex < section.questions.length; questionIndex += 1) {
      const question = section.questions[questionIndex];
      const hasPrompt = Boolean(String(question.prompt || "").trim());
      const hasFilledChoice = question.choices.some((choice) => String(choice.label || "").trim());

      if (!hasPrompt && !hasFilledChoice) {
        question.choices =
          question.questionType === "true_false"
            ? [
                { label: "True", isCorrect: true },
                { label: "False", isCorrect: false }
              ]
            : question.choices;
        continue;
      }

      const choices =
        question.questionType === "true_false"
          ? [
              {
                label: "True",
                isCorrect: question.choices.some(
                  (choice) => choice.label.toLowerCase() === "true" && choice.isCorrect
                )
              },
              {
                label: "False",
                isCorrect: question.choices.some(
                  (choice) => choice.label.toLowerCase() === "false" && choice.isCorrect
                )
              }
            ]
          : question.choices.filter((choice) => choice.label);

      question.choices = choices;
    }
  }

  return {
    error: "",
    builderState
  };
}

async function ensureModuleItemColumns() {
  if (USE_POSTGRES) {
    return;
  }

  const columns = await dbAll("PRAGMA table_info(module_items)");
  const hasStartDate = columns.some((column) => column.name === "start_date");
  const hasEndDate = columns.some((column) => column.name === "end_date");
  const hasVisibility = columns.some((column) => column.name === "visibility");
  const hasQuizCode = columns.some((column) => column.name === "quiz_code");

  if (!hasStartDate) {
    await dbRun("ALTER TABLE module_items ADD COLUMN start_date TEXT");
  }

  if (!hasEndDate) {
    await dbRun("ALTER TABLE module_items ADD COLUMN end_date TEXT");
  }

  if (!hasVisibility) {
    await dbRun("ALTER TABLE module_items ADD COLUMN visibility TEXT");
  }

  if (!hasQuizCode) {
    await dbRun("ALTER TABLE module_items ADD COLUMN quiz_code TEXT");
  }

  const currentDate = getCurrentDateInTimeZone("Asia/Kuala_Lumpur");
  await dbRun(
    `
      UPDATE module_items
      SET
        start_date = COALESCE(start_date, ?),
        end_date = COALESCE(end_date, ?),
        visibility = COALESCE(visibility, 'private')
      WHERE start_date IS NULL OR end_date IS NULL OR visibility IS NULL
    `,
    [currentDate, currentDate]
  );
}

async function ensureModuleQuizCodes() {
  const existingItems = await dbAll(
    `
      SELECT id, quiz_code
      FROM module_items
      WHERE module_type = 'quiz'
      ORDER BY id ASC
    `
  );
  const usedCodes = new Set();

  for (const item of existingItems) {
    const hasValidCode =
      /^\d{6}$/.test(String(item.quiz_code || "")) && !usedCodes.has(item.quiz_code);

    if (hasValidCode) {
      usedCodes.add(item.quiz_code);
      continue;
    }

    const quizCode = await generateUniqueModuleQuizCode(usedCodes);
    await dbRun("UPDATE module_items SET quiz_code = ? WHERE id = ?", [
      quizCode,
      item.id
    ]);
  }

  await dbRun(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_module_items_quiz_code ON module_items(quiz_code)"
  );
}

async function ensureQuizQuestionColumns() {
  if (USE_POSTGRES) {
    await dbRun(
      "ALTER TABLE quiz_questions ADD COLUMN IF NOT EXISTS show_leaderboard INTEGER NOT NULL DEFAULT 0"
    );
    await dbRun(
      "ALTER TABLE quiz_questions ADD COLUMN IF NOT EXISTS image_url TEXT NOT NULL DEFAULT ''"
    );
    return;
  }

  const columns = await dbAll("PRAGMA table_info(quiz_questions)");
  const hasShowLeaderboard = columns.some((column) => column.name === "show_leaderboard");
  const hasImageUrl = columns.some((column) => column.name === "image_url");

  if (!hasShowLeaderboard) {
    await dbRun(
      "ALTER TABLE quiz_questions ADD COLUMN show_leaderboard INTEGER NOT NULL DEFAULT 0"
    );
  }

  if (!hasImageUrl) {
    await dbRun(
      "ALTER TABLE quiz_questions ADD COLUMN image_url TEXT NOT NULL DEFAULT ''"
    );
  }
}

async function ensureQuizLiveSessionColumns() {
  if (USE_POSTGRES) {
    await dbRun(
      "ALTER TABLE quiz_live_sessions ADD COLUMN IF NOT EXISTS phase_mode TEXT"
    );
    await dbRun(
      "ALTER TABLE quiz_live_sessions ADD COLUMN IF NOT EXISTS phase_ends_at TIMESTAMPTZ"
    );
    return;
  }

  const columns = await dbAll("PRAGMA table_info(quiz_live_sessions)");
  const hasPhaseMode = columns.some((column) => column.name === "phase_mode");
  const hasPhaseEndsAt = columns.some((column) => column.name === "phase_ends_at");

  if (!hasPhaseMode) {
    await dbRun("ALTER TABLE quiz_live_sessions ADD COLUMN phase_mode TEXT");
  }

  if (!hasPhaseEndsAt) {
    await dbRun("ALTER TABLE quiz_live_sessions ADD COLUMN phase_ends_at TEXT");
  }
}

async function ensureUserAuthColumns() {
  if (USE_POSTGRES) {
    await dbRun("ALTER TABLE users ADD COLUMN IF NOT EXISTS supabase_auth_user_id UUID");
    await dbRun(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_supabase_auth_user_id ON users(supabase_auth_user_id)"
    );
    return;
  }

  const columns = await dbAll("PRAGMA table_info(users)");
  const hasSupabaseAuthUserId = columns.some(
    (column) => column.name === "supabase_auth_user_id"
  );

  if (!hasSupabaseAuthUserId) {
    await dbRun("ALTER TABLE users ADD COLUMN supabase_auth_user_id TEXT");
  }

  await dbRun(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_supabase_auth_user_id ON users(supabase_auth_user_id)"
  );
}

async function ensureKuizzoshQuizCodes() {
  if (USE_POSTGRES) {
    return;
  }

  const columns = await dbAll("PRAGMA table_info(kuizzosh_items)");
  const hasQuizCodeColumn = columns.some((column) => column.name === "quiz_code");

  if (!hasQuizCodeColumn) {
    await dbRun("ALTER TABLE kuizzosh_items ADD COLUMN quiz_code TEXT");
  }

  const existingItems = await dbAll(
    "SELECT id, quiz_code FROM kuizzosh_items ORDER BY id ASC"
  );
  const usedCodes = new Set();

  for (const item of existingItems) {
    const hasValidCode =
      /^\d{6}$/.test(String(item.quiz_code || "")) && !usedCodes.has(item.quiz_code);

    if (hasValidCode) {
      usedCodes.add(item.quiz_code);
      continue;
    }

    const quizCode = await generateUniqueQuizCode(usedCodes);
    await dbRun("UPDATE kuizzosh_items SET quiz_code = ? WHERE id = ?", [
      quizCode,
      item.id
    ]);
  }

  await dbRun(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_kuizzosh_items_quiz_code ON kuizzosh_items(quiz_code)"
  );
}

async function getOwnedKuizzoshItem(userId, itemId) {
  return dbGet(
    `
      SELECT id, user_id, title, start_date, end_date, visibility, quiz_code
      FROM kuizzosh_items
      WHERE id = ? AND user_id = ?
    `,
    [itemId, userId]
  );
}

async function getOwnedModuleItem(userId, moduleType, itemId) {
  return dbGet(
    `
      SELECT id, user_id, module_type, title, start_date, end_date, visibility, quiz_code
      FROM module_items
      WHERE id = ? AND user_id = ? AND module_type = ?
    `,
    [itemId, userId, moduleType]
  );
}

function toSessionUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email
  };
}

function renderAuthPage(res, view, options = {}) {
  res.render(view, {
    title: options.title,
    error: options.error || "",
    success: options.success || "",
    formData: options.formData || {}
  });
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    res.redirect("/login");
    return;
  }

  next();
}

function requireGuest(req, res, next) {
  if (req.session.user) {
    res.redirect("/dashboard");
    return;
  }

  next();
}

async function initializeDatabase() {
  if (USE_POSTGRES) {
    await dbRun(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL DEFAULT '',
        supabase_auth_user_id UUID UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await dbRun(`
      CREATE TABLE IF NOT EXISTS kuizzosh_items (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        visibility TEXT NOT NULL CHECK (visibility IN ('private', 'public')),
        quiz_code TEXT UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await dbRun(`
      CREATE TABLE IF NOT EXISTS module_items (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        module_type TEXT NOT NULL CHECK (module_type IN ('quiz', 'poll', 'ranking')),
        title TEXT NOT NULL,
        start_date TEXT,
        end_date TEXT,
        visibility TEXT,
        quiz_code TEXT UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await dbRun(`
      CREATE TABLE IF NOT EXISTS quiz_settings (
        id SERIAL PRIMARY KEY,
        module_item_id INTEGER NOT NULL UNIQUE REFERENCES module_items (id) ON DELETE CASCADE,
        leaderboard_enabled INTEGER NOT NULL DEFAULT 1,
        speed_bonus_enabled INTEGER NOT NULL DEFAULT 1,
        show_correct_answer INTEGER NOT NULL DEFAULT 1,
        randomize_questions INTEGER NOT NULL DEFAULT 0,
        randomize_choices INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await dbRun(`
      CREATE TABLE IF NOT EXISTS quiz_sections (
        id SERIAL PRIMARY KEY,
        module_item_id INTEGER NOT NULL REFERENCES module_items (id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        position INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await dbRun(`
      CREATE TABLE IF NOT EXISTS quiz_questions (
        id SERIAL PRIMARY KEY,
        section_id INTEGER NOT NULL REFERENCES quiz_sections (id) ON DELETE CASCADE,
        prompt TEXT NOT NULL,
        image_url TEXT NOT NULL DEFAULT '',
        question_type TEXT NOT NULL CHECK (question_type IN ('single_choice', 'multiple_choice', 'true_false')),
        points INTEGER NOT NULL DEFAULT 100,
        time_limit INTEGER NOT NULL DEFAULT 20,
        show_leaderboard INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await dbRun(`
      CREATE TABLE IF NOT EXISTS quiz_choices (
        id SERIAL PRIMARY KEY,
        question_id INTEGER NOT NULL REFERENCES quiz_questions (id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        is_correct INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await dbRun(`
      CREATE TABLE IF NOT EXISTS quiz_live_sessions (
        id SERIAL PRIMARY KEY,
        module_item_id INTEGER NOT NULL REFERENCES module_items (id) ON DELETE CASCADE,
        host_user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('lobby', 'question', 'leaderboard', 'ended')),
        phase_mode TEXT,
        current_question_index INTEGER NOT NULL DEFAULT 0,
        question_started_at TIMESTAMPTZ,
        phase_ends_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        started_at TIMESTAMPTZ,
        ended_at TIMESTAMPTZ
      )
    `);

    await dbRun(`
      CREATE TABLE IF NOT EXISTS quiz_live_participants (
        id SERIAL PRIMARY KEY,
        session_id INTEGER NOT NULL REFERENCES quiz_live_sessions (id) ON DELETE CASCADE,
        display_name TEXT NOT NULL,
        join_token TEXT NOT NULL UNIQUE,
        joined_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await dbRun(`
      CREATE TABLE IF NOT EXISTS quiz_live_answers (
        id SERIAL PRIMARY KEY,
        session_id INTEGER NOT NULL REFERENCES quiz_live_sessions (id) ON DELETE CASCADE,
        participant_id INTEGER NOT NULL REFERENCES quiz_live_participants (id) ON DELETE CASCADE,
        question_id INTEGER NOT NULL REFERENCES quiz_questions (id) ON DELETE CASCADE,
        selected_choice_ids TEXT NOT NULL,
        is_correct INTEGER NOT NULL DEFAULT 0,
        response_time_ms INTEGER NOT NULL DEFAULT 0,
        submitted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await dbRun(
      "CREATE INDEX IF NOT EXISTS idx_kuizzosh_items_user_id ON kuizzosh_items(user_id)"
    );
    await dbRun(
      "CREATE INDEX IF NOT EXISTS idx_module_items_user_type ON module_items(user_id, module_type)"
    );
    await dbRun(
      "CREATE INDEX IF NOT EXISTS idx_quiz_sections_module_item ON quiz_sections(module_item_id, position)"
    );
    await dbRun(
      "CREATE INDEX IF NOT EXISTS idx_quiz_questions_section ON quiz_questions(section_id, position)"
    );
    await dbRun(
      "CREATE INDEX IF NOT EXISTS idx_quiz_choices_question ON quiz_choices(question_id, position)"
    );
    await dbRun(
      "CREATE INDEX IF NOT EXISTS idx_quiz_live_sessions_module ON quiz_live_sessions(module_item_id, created_at)"
    );
    await dbRun(
      "CREATE INDEX IF NOT EXISTS idx_quiz_live_participants_session ON quiz_live_participants(session_id, joined_at)"
    );
    await dbRun(
      "CREATE INDEX IF NOT EXISTS idx_quiz_live_answers_session_question ON quiz_live_answers(session_id, question_id)"
    );
    await dbRun(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_quiz_live_answers_unique ON quiz_live_answers(session_id, participant_id, question_id)"
    );

    await ensureQuizQuestionColumns();
    await ensureQuizLiveSessionColumns();
    await ensureUserAuthColumns();

    return;
  }

  await dbRun(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL DEFAULT '',
      supabase_auth_user_id TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS kuizzosh_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      visibility TEXT NOT NULL CHECK (visibility IN ('private', 'public')),
      quiz_code TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id)
    )
  `);

  await ensureKuizzoshQuizCodes();

  await dbRun(`
    CREATE TABLE IF NOT EXISTS module_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      module_type TEXT NOT NULL CHECK (module_type IN ('quiz', 'poll', 'ranking')),
      title TEXT NOT NULL,
      start_date TEXT,
      end_date TEXT,
      visibility TEXT,
      quiz_code TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id)
    )
  `);

  await ensureModuleItemColumns();
  await ensureModuleQuizCodes();

  await dbRun(`
    CREATE TABLE IF NOT EXISTS quiz_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      module_item_id INTEGER NOT NULL UNIQUE,
      leaderboard_enabled INTEGER NOT NULL DEFAULT 1,
      speed_bonus_enabled INTEGER NOT NULL DEFAULT 1,
      show_correct_answer INTEGER NOT NULL DEFAULT 1,
      randomize_questions INTEGER NOT NULL DEFAULT 0,
      randomize_choices INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (module_item_id) REFERENCES module_items (id)
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS quiz_sections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      module_item_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      position INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (module_item_id) REFERENCES module_items (id)
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS quiz_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      section_id INTEGER NOT NULL,
      prompt TEXT NOT NULL,
      image_url TEXT NOT NULL DEFAULT '',
      question_type TEXT NOT NULL CHECK (question_type IN ('single_choice', 'multiple_choice', 'true_false')),
      points INTEGER NOT NULL DEFAULT 100,
      time_limit INTEGER NOT NULL DEFAULT 20,
      show_leaderboard INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (section_id) REFERENCES quiz_sections (id)
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS quiz_choices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id INTEGER NOT NULL,
      label TEXT NOT NULL,
      is_correct INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (question_id) REFERENCES quiz_questions (id)
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS quiz_live_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      module_item_id INTEGER NOT NULL,
      host_user_id INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('lobby', 'question', 'leaderboard', 'ended')),
      phase_mode TEXT,
      current_question_index INTEGER NOT NULL DEFAULT 0,
      question_started_at TEXT,
      phase_ends_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      started_at TEXT,
      ended_at TEXT,
      FOREIGN KEY (module_item_id) REFERENCES module_items (id),
      FOREIGN KEY (host_user_id) REFERENCES users (id)
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS quiz_live_participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      display_name TEXT NOT NULL,
      join_token TEXT NOT NULL UNIQUE,
      joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES quiz_live_sessions (id)
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS quiz_live_answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      participant_id INTEGER NOT NULL,
      question_id INTEGER NOT NULL,
      selected_choice_ids TEXT NOT NULL,
      is_correct INTEGER NOT NULL DEFAULT 0,
      response_time_ms INTEGER NOT NULL DEFAULT 0,
      submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES quiz_live_sessions (id),
      FOREIGN KEY (participant_id) REFERENCES quiz_live_participants (id),
      FOREIGN KEY (question_id) REFERENCES quiz_questions (id)
    )
  `);

  await dbRun(
    "CREATE INDEX IF NOT EXISTS idx_quiz_live_sessions_module ON quiz_live_sessions(module_item_id, created_at)"
  );
  await dbRun(
    "CREATE INDEX IF NOT EXISTS idx_quiz_live_participants_session ON quiz_live_participants(session_id, joined_at)"
  );
  await dbRun(
    "CREATE INDEX IF NOT EXISTS idx_quiz_live_answers_session_question ON quiz_live_answers(session_id, question_id)"
  );
  await dbRun(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_quiz_live_answers_unique ON quiz_live_answers(session_id, participant_id, question_id)"
  );

  await ensureQuizQuestionColumns();
  await ensureQuizLiveSessionColumns();
  await ensureUserAuthColumns();
}

async function buildDashboardViewModel(userId, options = {}) {
  const user = await dbGet(
    "SELECT id, name, email, created_at FROM users WHERE id = ?",
    [userId]
  );

  if (!user) {
    return null;
  }

  const kuizzoshItems = await dbAll(
    `
      SELECT id, title, start_date, end_date, visibility, created_at, quiz_code
      FROM kuizzosh_items
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 8
    `,
    [userId]
  );
  const currentDate = getCurrentDateInTimeZone("Asia/Kuala_Lumpur");
  const normalizedKuizzoshItems = kuizzoshItems.map((item) => ({
    ...item,
    owner_name: user.name,
    duration_label: buildDurationLabel(item.start_date, item.end_date),
    status: getKuizzoshStatus(item.start_date, item.end_date, currentDate)
  }));

  return {
    title: "Dashboard",
    user,
    kuizzoshItems: normalizedKuizzoshItems,
    dashboardError: options.error || "",
    dashboardSuccess: options.success || "",
    openCreateModal: Boolean(options.openCreateModal),
    createFormData: {
      title: options.formData?.title || "",
      startDate: options.formData?.startDate || "",
      endDate: options.formData?.endDate || "",
      visibility: options.formData?.visibility || "private"
    }
  };
}

async function renderDashboardPage(req, res, options = {}) {
  const viewModel = await buildDashboardViewModel(req.session.user.id, options);

  if (!viewModel) {
    req.session.destroy(() => {
      res.redirect("/login");
    });
    return;
  }

  res.status(options.statusCode || 200).render("dashboard", viewModel);
}

async function buildModulePageViewModel(userId, pageKey, options = {}) {
  const config = MODULE_PAGE_CONFIG[pageKey];

  if (!config) {
    return null;
  }

  const user = await dbGet(
    "SELECT id, name, email, created_at FROM users WHERE id = ?",
    [userId]
  );

  if (!user) {
    return null;
  }

  const items = await dbAll(
    `
      SELECT id, title, start_date, end_date, visibility, created_at, quiz_code
      FROM module_items
      WHERE user_id = ? AND module_type = ?
      ORDER BY created_at DESC
      LIMIT 20
    `,
    [userId, config.dbType]
  );
  const currentDate = getCurrentDateInTimeZone("Asia/Kuala_Lumpur");
  const normalizedItems = items.map((item) => ({
    ...item,
    owner_name: user.name,
    duration_label: buildDurationLabel(item.start_date, item.end_date),
    status: getKuizzoshStatus(item.start_date, item.end_date, currentDate)
  }));

  return {
    title: config.pageTitle,
    user,
    pageKey,
    pageTitle: config.pageTitle,
    pageDescription: config.description,
    singular: config.singular,
    items: normalizedItems,
    flashSuccess: options.success || "",
    flashError: options.error || "",
    openCreateModal: Boolean(options.openCreateModal),
    createFormData: {
      title: options.formData?.title || "",
      startDate: options.formData?.startDate || "",
      endDate: options.formData?.endDate || "",
      visibility: options.formData?.visibility || "private"
    }
  };
}

async function renderModulePage(req, res, pageKey, options = {}) {
  const viewModel = await buildModulePageViewModel(req.session.user.id, pageKey, options);

  if (!viewModel) {
    req.session.destroy(() => {
      res.redirect("/login");
    });
    return;
  }

  res.status(options.statusCode || 200).render("module-page", viewModel);
}

async function loadQuizSettings(moduleItemId) {
  const row = await dbGet(
    `
      SELECT
        leaderboard_enabled,
        speed_bonus_enabled,
        show_correct_answer,
        randomize_questions,
        randomize_choices
      FROM quiz_settings
      WHERE module_item_id = ?
    `,
    [moduleItemId]
  );

  if (!row) {
    return createDefaultQuizSettings();
  }

  return {
    leaderboardEnabled: Boolean(row.leaderboard_enabled),
    speedBonusEnabled: Boolean(row.speed_bonus_enabled),
    showCorrectAnswer: Boolean(row.show_correct_answer),
    randomizeQuestions: Boolean(row.randomize_questions),
    randomizeChoices: Boolean(row.randomize_choices)
  };
}

async function loadQuizBuilderState(moduleItemId) {
  const sections = await dbAll(
    `
      SELECT id, title, position
      FROM quiz_sections
      WHERE module_item_id = ?
      ORDER BY position ASC, id ASC
    `,
    [moduleItemId]
  );

  if (!sections.length) {
    return createDefaultQuizBuilderState();
  }

  const nestedSections = [];

  for (const section of sections) {
    const questions = await dbAll(
      `
        SELECT id, prompt, image_url, question_type, points, time_limit, show_leaderboard, position
        FROM quiz_questions
        WHERE section_id = ?
        ORDER BY position ASC, id ASC
      `,
      [section.id]
    );

    const nestedQuestions = [];

    for (const question of questions) {
      const choices = await dbAll(
        `
          SELECT id, label, is_correct, position
          FROM quiz_choices
          WHERE question_id = ?
          ORDER BY position ASC, id ASC
        `,
        [question.id]
      );

      nestedQuestions.push({
        id: question.id,
        prompt: question.prompt,
        imageUrl: normalizeQuizQuestionImage(question.image_url),
        questionType: question.question_type,
        points: question.points,
        timeLimit: question.time_limit,
        showLeaderboard: Boolean(question.show_leaderboard),
        choices: choices.length
          ? choices.map((choice) => ({
              id: choice.id,
              label: choice.label,
              isCorrect: Boolean(choice.is_correct)
            }))
          : createDefaultQuizQuestion(1).choices
      });
    }

    nestedSections.push({
      id: section.id,
      title: section.title,
      questions: nestedQuestions.length ? nestedQuestions : [createDefaultQuizQuestion(1)]
    });
  }

  return {
    sections: nestedSections
  };
}

async function clearQuizBuilder(moduleItemId, executor = null) {
  await dbRun(
    `
      DELETE FROM quiz_choices
      WHERE question_id IN (
        SELECT q.id
        FROM quiz_questions q
        JOIN quiz_sections s ON s.id = q.section_id
        WHERE s.module_item_id = ?
      )
    `,
    [moduleItemId],
    executor
  );

  await dbRun(
    `
      DELETE FROM quiz_questions
      WHERE section_id IN (
        SELECT id
        FROM quiz_sections
        WHERE module_item_id = ?
      )
    `,
    [moduleItemId],
    executor
  );

  await dbRun("DELETE FROM quiz_sections WHERE module_item_id = ?", [moduleItemId], executor);
  await dbRun("DELETE FROM quiz_settings WHERE module_item_id = ?", [moduleItemId], executor);
}

async function saveQuizBuilder(moduleItemId, settings, builderState) {
  await withTransaction(async (executor) => {
    await clearQuizBuilder(moduleItemId, executor);

    await dbRun(
      `
        INSERT INTO quiz_settings (
          module_item_id,
          leaderboard_enabled,
          speed_bonus_enabled,
          show_correct_answer,
          randomize_questions,
          randomize_choices,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `,
      [
        moduleItemId,
        settings.leaderboardEnabled ? 1 : 0,
        settings.speedBonusEnabled ? 1 : 0,
        settings.showCorrectAnswer ? 1 : 0,
        settings.randomizeQuestions ? 1 : 0,
        settings.randomizeChoices ? 1 : 0
      ],
      executor
    );

    for (let sectionIndex = 0; sectionIndex < builderState.sections.length; sectionIndex += 1) {
      const section = builderState.sections[sectionIndex];
      const sectionResult = await dbRun(
        `
          INSERT INTO quiz_sections (module_item_id, title, position)
          VALUES (?, ?, ?)
        `,
        [moduleItemId, section.title, sectionIndex + 1],
        executor
      );

      for (let questionIndex = 0; questionIndex < section.questions.length; questionIndex += 1) {
        const question = section.questions[questionIndex];
        const questionResult = await dbRun(
          `
            INSERT INTO quiz_questions (
              section_id,
              prompt,
              image_url,
              question_type,
              points,
              time_limit,
              show_leaderboard,
              position
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            sectionResult.lastID,
            question.prompt,
            normalizeQuizQuestionImage(question.imageUrl),
            question.questionType,
            question.points,
            question.timeLimit,
            question.showLeaderboard ? 1 : 0,
            questionIndex + 1
          ],
          executor
        );

        for (let choiceIndex = 0; choiceIndex < question.choices.length; choiceIndex += 1) {
          const choice = question.choices[choiceIndex];
          await dbRun(
            `
              INSERT INTO quiz_choices (question_id, label, is_correct, position)
              VALUES (?, ?, ?, ?)
            `,
            [questionResult.lastID, choice.label, choice.isCorrect ? 1 : 0, choiceIndex + 1],
            executor
          );
        }
      }
    }    
  });
}

async function buildQuizSetupViewModel(userId, itemId, options = {}) {
  const user = await dbGet(
    "SELECT id, name, email, created_at FROM users WHERE id = ?",
    [userId]
  );

  if (!user) {
    return null;
  }

  const item = await getOwnedModuleItem(userId, "quiz", itemId);

  if (!item) {
    return null;
  }

  const currentDate = getCurrentDateInTimeZone("Asia/Kuala_Lumpur");
  const flash = options.flash || null;
  const settings = options.settings || (await loadQuizSettings(item.id));
  const builderState = options.builderState || (await loadQuizBuilderState(item.id));
  const sectionCount = builderState.sections.length || 1;
  const requestedSectionIndex = normalizeInteger(options.initialSectionIndex, 0, 0, sectionCount - 1);
  const questionCount = builderState.sections[requestedSectionIndex]?.questions.length || 1;
  const requestedQuestionIndex = normalizeInteger(
    options.initialQuestionIndex,
    0,
    0,
    questionCount - 1
  );

  return {
    title: `${item.title} Setup`,
    user,
    item: {
      ...item,
      duration_label: buildDurationLabel(item.start_date, item.end_date),
      status: getKuizzoshStatus(item.start_date, item.end_date, currentDate)
    },
    flashSuccess: flash?.type === "success" ? flash.message : "",
    flashError: flash?.type === "error" ? flash.message : options.error || "",
    quizSettings: settings,
    builderState,
    initialActiveSectionIndex: requestedSectionIndex,
    initialActiveQuestionIndex: requestedQuestionIndex,
    serializedBuilderState: JSON.stringify(builderState).replace(/</g, "\\u003c")
  };
}

async function renderQuizSetupPage(req, res, itemId, options = {}) {
  const viewModel = await buildQuizSetupViewModel(req.session.user.id, itemId, options);

  if (!viewModel) {
    res.redirect("/quizzes");
    return;
  }

  res.status(options.statusCode || 200).render("quiz-setup", viewModel);
}

async function getQuizItemWithOwnerById(itemId) {
  return dbGet(
    `
      SELECT
        m.id,
        m.user_id,
        m.title,
        m.start_date,
        m.end_date,
        m.visibility,
        m.quiz_code,
        u.name AS owner_name
      FROM module_items m
      JOIN users u ON u.id = m.user_id
      WHERE m.id = ? AND m.module_type = 'quiz'
    `,
    [itemId]
  );
}

async function getQuizItemWithOwnerByCode(quizCode) {
  return dbGet(
    `
      SELECT
        m.id,
        m.user_id,
        m.title,
        m.start_date,
        m.end_date,
        m.visibility,
        m.quiz_code,
        u.name AS owner_name
      FROM module_items m
      JOIN users u ON u.id = m.user_id
      WHERE m.quiz_code = ? AND m.module_type = 'quiz'
    `,
    [quizCode]
  );
}

async function loadQuizLiveQuestions(moduleItemId) {
  const builderState = await loadQuizBuilderState(moduleItemId);
  const flatQuestions = [];

  builderState.sections.forEach((section, sectionIndex) => {
    section.questions.forEach((question, questionIndex) => {
      flatQuestions.push({
        id: question.id || null,
        prompt: question.prompt,
        imageUrl: normalizeQuizQuestionImage(question.imageUrl),
        questionType: question.questionType,
        timeLimit: question.timeLimit,
        showLeaderboard: Boolean(question.showLeaderboard),
        sectionTitle: section.title,
        sectionIndex,
        questionIndex,
        choices: Array.isArray(question.choices)
          ? question.choices.map((choice) => ({
              id: choice.id || null,
              label: choice.label,
              isCorrect: Boolean(choice.isCorrect)
            }))
          : []
      });
    });
  });

  return flatQuestions;
}

async function getActiveQuizLiveSession(moduleItemId) {
  return dbGet(
    `
      SELECT *
      FROM quiz_live_sessions
      WHERE module_item_id = ? AND status != ?
      ORDER BY id DESC
      LIMIT 1
    `,
    [moduleItemId, QUIZ_LIVE_STATUSES.ENDED]
  );
}

async function getLatestQuizLiveSession(moduleItemId) {
  return dbGet(
    `
      SELECT *
      FROM quiz_live_sessions
      WHERE module_item_id = ?
      ORDER BY id DESC
      LIMIT 1
    `,
    [moduleItemId]
  );
}

async function getQuizLiveSessionById(sessionId) {
  return dbGet("SELECT * FROM quiz_live_sessions WHERE id = ?", [sessionId]);
}

async function getOwnedQuizLiveSession(userId, moduleItemId, sessionId) {
  return dbGet(
    `
      SELECT *
      FROM quiz_live_sessions
      WHERE id = ? AND module_item_id = ? AND host_user_id = ?
    `,
    [sessionId, moduleItemId, userId]
  );
}

async function createQuizLiveSession(moduleItemId, hostUserId) {
  const result = await dbRun(
    `
      INSERT INTO quiz_live_sessions (
        module_item_id,
        host_user_id,
        status,
        phase_mode,
        current_question_index,
        phase_ends_at,
        updated_at
      )
      VALUES (?, ?, ?, NULL, 0, NULL, CURRENT_TIMESTAMP)
    `,
    [moduleItemId, hostUserId, QUIZ_LIVE_STATUSES.LOBBY]
  );

  return getQuizLiveSessionById(result.lastID);
}

async function ensureQuizLiveSession(moduleItemId, hostUserId, options = {}) {
  if (options.forceNew) {
    return createQuizLiveSession(moduleItemId, hostUserId);
  }

  const activeSession = await getActiveQuizLiveSession(moduleItemId);

  if (activeSession) {
    return activeSession;
  }

  const latestSession = await getLatestQuizLiveSession(moduleItemId);

  if (latestSession) {
    return latestSession;
  }

  return createQuizLiveSession(moduleItemId, hostUserId);
}

async function getQuizLiveParticipants(sessionId) {
  return dbAll(
    `
      SELECT id, display_name, join_token, joined_at, last_seen_at
      FROM quiz_live_participants
      WHERE session_id = ?
      ORDER BY joined_at ASC, id ASC
    `,
    [sessionId]
  );
}

async function touchQuizParticipant(participantId) {
  await dbRun(
    "UPDATE quiz_live_participants SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?",
    [participantId]
  );
}

async function clearQuizLiveResults(moduleItemId, executor = null) {
  await dbRun(
    `
      DELETE FROM quiz_live_answers
      WHERE session_id IN (
        SELECT id
        FROM quiz_live_sessions
        WHERE module_item_id = ?
      )
    `,
    [moduleItemId],
    executor
  );

  await dbRun(
    `
      DELETE FROM quiz_live_participants
      WHERE session_id IN (
        SELECT id
        FROM quiz_live_sessions
        WHERE module_item_id = ?
      )
    `,
    [moduleItemId],
    executor
  );

  await dbRun(
    "DELETE FROM quiz_live_sessions WHERE module_item_id = ?",
    [moduleItemId],
    executor
  );
}

async function updateQuizLiveSessionState(sessionId, changes) {
  const assignments = [];
  const params = [];

  if (Object.prototype.hasOwnProperty.call(changes, "status")) {
    assignments.push("status = ?");
    params.push(changes.status);
  }

  if (Object.prototype.hasOwnProperty.call(changes, "phaseMode")) {
    assignments.push("phase_mode = ?");
    params.push(changes.phaseMode);
  }

  if (Object.prototype.hasOwnProperty.call(changes, "currentQuestionIndex")) {
    assignments.push("current_question_index = ?");
    params.push(changes.currentQuestionIndex);
  }

  if (Object.prototype.hasOwnProperty.call(changes, "questionStartedAt")) {
    assignments.push("question_started_at = ?");
    params.push(changes.questionStartedAt);
  }

  if (Object.prototype.hasOwnProperty.call(changes, "phaseEndsAt")) {
    assignments.push("phase_ends_at = ?");
    params.push(changes.phaseEndsAt);
  }

  if (Object.prototype.hasOwnProperty.call(changes, "startedAt")) {
    assignments.push("started_at = ?");
    params.push(changes.startedAt);
  }

  if (Object.prototype.hasOwnProperty.call(changes, "endedAt")) {
    assignments.push("ended_at = ?");
    params.push(changes.endedAt);
  }

  assignments.push("updated_at = CURRENT_TIMESTAMP");
  params.push(sessionId);

  await dbRun(
    `
      UPDATE quiz_live_sessions
      SET ${assignments.join(", ")}
      WHERE id = ?
    `,
    params
  );

  return getQuizLiveSessionById(sessionId);
}

async function buildQuizLeaderboard(sessionId, questions, upToQuestionIndex) {
  const participants = await getQuizLiveParticipants(sessionId);

  if (!participants.length) {
    return [];
  }

  const visibleQuestions =
    typeof upToQuestionIndex === "number" && upToQuestionIndex >= 0
      ? questions.slice(0, upToQuestionIndex + 1)
      : [];
  const visibleQuestionIds = new Set(
    visibleQuestions.map((question) => question.id).filter((questionId) => questionId)
  );

  if (!visibleQuestionIds.size) {
    return participants.map((participant, index) => ({
      rank: index + 1,
      participantId: participant.id,
      displayName: participant.display_name,
      correctCount: 0,
      answeredCount: 0,
      totalResponseTimeMs: 0,
      totalResponseTimeLabel: "0.0s",
      answerSummaryLabel: "0/0",
      lastSubmissionAt: "",
      joinedAt: toIsoString(participant.joined_at)
    }));
  }

  const answers = await dbAll(
    `
      SELECT participant_id, question_id, is_correct, response_time_ms, submitted_at
      FROM quiz_live_answers
      WHERE session_id = ?
      ORDER BY submitted_at ASC, id ASC
    `,
    [sessionId]
  );

  const leaderboardRows = participants.map((participant) => {
    const participantAnswers = answers.filter(
      (answer) =>
        answer.participant_id === participant.id && visibleQuestionIds.has(answer.question_id)
    );
    const correctAnswers = participantAnswers.filter((answer) => Boolean(answer.is_correct));
    const totalResponseTimeMs = participantAnswers.reduce(
      (total, answer) => total + Number(answer.response_time_ms || 0),
      0
    );
    const lastSubmission = participantAnswers[participantAnswers.length - 1];

    return {
      participantId: participant.id,
      displayName: participant.display_name,
      correctCount: correctAnswers.length,
      answeredCount: participantAnswers.length,
      totalResponseTimeMs,
      totalResponseTimeLabel: formatMillisecondsAsSeconds(totalResponseTimeMs),
      answerSummaryLabel: `${correctAnswers.length}/${participantAnswers.length}`,
      lastSubmissionAt: toIsoString(lastSubmission?.submitted_at || ""),
      joinedAt: toIsoString(participant.joined_at)
    };
  });

  leaderboardRows.sort((left, right) => {
    if (right.correctCount !== left.correctCount) {
      return right.correctCount - left.correctCount;
    }

    if (right.answeredCount !== left.answeredCount) {
      return right.answeredCount - left.answeredCount;
    }

    if (left.totalResponseTimeMs !== right.totalResponseTimeMs) {
      return left.totalResponseTimeMs - right.totalResponseTimeMs;
    }

    if (left.lastSubmissionAt && right.lastSubmissionAt && left.lastSubmissionAt !== right.lastSubmissionAt) {
      return left.lastSubmissionAt.localeCompare(right.lastSubmissionAt);
    }

    return left.joinedAt.localeCompare(right.joinedAt);
  });

  return leaderboardRows.map((row, index) => ({
    rank: index + 1,
    ...row
  }));
}

async function buildQuizLiveSnapshot(session, options = {}) {
  const item =
    options.item ||
    (await getQuizItemWithOwnerById(session.module_item_id));

  if (!item) {
    return null;
  }

  const settings = options.settings || (await loadQuizSettings(item.id));
  const questions = await loadQuizLiveQuestions(item.id);
  const rawQuestionIndex = Number.isFinite(Number(session.current_question_index))
    ? Number(session.current_question_index)
    : 0;
  const safeQuestionIndex = questions.length
    ? Math.max(0, Math.min(rawQuestionIndex, questions.length - 1))
    : 0;
  const currentQuestion = questions[safeQuestionIndex] || null;
  const participants = await getQuizLiveParticipants(session.id);
  const isChartPhase =
    session.status === QUIZ_LIVE_STATUSES.LEADERBOARD &&
    session.phase_mode === QUIZ_LIVE_PHASES.CHART;
  const isCountdownPhase =
    session.status === QUIZ_LIVE_STATUSES.LEADERBOARD &&
    session.phase_mode === QUIZ_LIVE_PHASES.COUNTDOWN;
  const shouldExposeCurrentQuestion =
    session.status !== QUIZ_LIVE_STATUSES.LOBBY &&
    session.status !== QUIZ_LIVE_STATUSES.ENDED &&
    !isCountdownPhase;
  const revealAnswersToClient =
    Boolean(options.forHost) ||
    isChartPhase ||
    session.status === QUIZ_LIVE_STATUSES.ENDED;
  const leaderboardQuestionIndex =
    session.status === QUIZ_LIVE_STATUSES.LOBBY
      ? -1
      : session.status === QUIZ_LIVE_STATUSES.QUESTION
        ? safeQuestionIndex - 1
        : isCountdownPhase && rawQuestionIndex < 0
          ? -1
          : safeQuestionIndex;
  const currentQuestionAnswers = currentQuestion?.id
    ? await dbAll(
        `
          SELECT participant_id, selected_choice_ids, is_correct, response_time_ms, submitted_at
          FROM quiz_live_answers
          WHERE session_id = ? AND question_id = ?
          ORDER BY submitted_at ASC, id ASC
        `,
        [session.id, currentQuestion.id]
      )
    : [];
  const answeredCount = currentQuestionAnswers.length;
  const selectedCountByChoiceId = new Map();

  currentQuestionAnswers.forEach((answer) => {
    parseChoiceIdList(answer.selected_choice_ids).forEach((choiceId) => {
      selectedCountByChoiceId.set(choiceId, (selectedCountByChoiceId.get(choiceId) || 0) + 1);
    });
  });

  const answeredPercentage = participants.length
    ? Math.round((answeredCount / participants.length) * 100)
    : 0;
  const leaderboard =
    leaderboardQuestionIndex >= 0
      ? await buildQuizLeaderboard(session.id, questions, leaderboardQuestionIndex)
      : [];
  const participantId = options.participantId || null;
  const participantAnswer =
    participantId && currentQuestion?.id
      ? currentQuestionAnswers.find((answer) => answer.participant_id === participantId) || null
      : null;
  const questionStartedAt = toIsoString(session.question_started_at);
  const phaseEndsAt = toIsoString(session.phase_ends_at);
  const questionDeadlineAt =
    session.status === QUIZ_LIVE_STATUSES.QUESTION ? phaseEndsAt : "";
  const currentParticipantRank = participantId
    ? leaderboard.find((entry) => entry.participantId === participantId)?.rank || null
    : null;

  return {
    sessionId: session.id,
    serverNow: new Date().toISOString(),
    status: session.status,
    phaseMode: String(session.phase_mode || ""),
    currentQuestionIndex: rawQuestionIndex,
    totalQuestions: questions.length,
    nextQuestionPosition:
      isCountdownPhase && rawQuestionIndex + 1 < questions.length
        ? rawQuestionIndex + 2
        : null,
    questionStartedAt,
    phaseEndsAt,
    questionDeadlineAt,
    quiz: {
      id: item.id,
      title: item.title,
      quizCode: item.quiz_code,
      ownerName: item.owner_name,
      visibility: item.visibility,
      durationLabel: buildDurationLabel(item.start_date, item.end_date),
      joinUrl: `/quizzes/join/${item.quiz_code}`,
      presentUrl: `/quizzes/${item.id}/present`
    },
    settings: {
      leaderboardEnabled: Boolean(settings.leaderboardEnabled),
      showCorrectAnswer: Boolean(settings.showCorrectAnswer)
    },
    participantCount: participants.length,
    participants: participants.map((participant) => ({
      id: participant.id,
      displayName: participant.display_name,
      joinedAt: toIsoString(participant.joined_at),
      lastSeenAt: toIsoString(participant.last_seen_at)
    })),
    answeredCount,
    unansweredCount: Math.max(0, participants.length - answeredCount),
    answeredPercentage,
    currentQuestion: shouldExposeCurrentQuestion && currentQuestion
        ? {
          id: currentQuestion.id,
          prompt: currentQuestion.prompt,
          imageUrl: normalizeQuizQuestionImage(currentQuestion.imageUrl),
          questionType: currentQuestion.questionType,
          timeLimit: currentQuestion.timeLimit,
          showLeaderboard: Boolean(currentQuestion.showLeaderboard),
          position: safeQuestionIndex + 1,
          sectionTitle: currentQuestion.sectionTitle,
          choices: currentQuestion.choices.map((choice) => ({
            id: choice.id,
            label: choice.label,
            isCorrect: revealAnswersToClient ? Boolean(choice.isCorrect) : false,
            selectedCount: selectedCountByChoiceId.get(choice.id) || 0,
            selectedPercent: participants.length
              ? Math.round(((selectedCountByChoiceId.get(choice.id) || 0) / participants.length) * 100)
              : 0
          }))
        }
      : null,
    leaderboard,
    participant: participantId
      ? {
          id: participantId,
          hasAnsweredCurrentQuestion: Boolean(participantAnswer),
          selectedChoiceIds: parseChoiceIdList(participantAnswer?.selected_choice_ids || ""),
          lastAnswerCorrect: participantAnswer ? Boolean(participantAnswer.is_correct) : null,
          lastResponseTimeMs: participantAnswer
            ? Number(participantAnswer.response_time_ms || 0)
            : null,
          rank: currentParticipantRank
        }
      : null,
    canGoLive: questions.some((question) => question.id)
  };
}

async function buildQuizStartViewModel(userId, itemId, options = {}) {
  const user = await dbGet(
    "SELECT id, name, email, created_at FROM users WHERE id = ?",
    [userId]
  );

  if (!user) {
    return null;
  }

  const item = await getOwnedModuleItem(userId, "quiz", itemId);

  if (!item) {
    return null;
  }

  const liveQuestions = await loadQuizLiveQuestions(itemId);
  const itemWithOwner = await getQuizItemWithOwnerById(itemId);
  const liveSession =
    liveQuestions.some((question) => question.id)
      ? await ensureQuizLiveSession(itemId, userId, { forceNew: Boolean(options.forceNew) })
      : null;
  const syncedSession =
    liveSession && itemWithOwner
      ? await syncQuizLiveSession(liveSession, await loadQuizSettings(itemId), liveQuestions)
      : liveSession;
  const initialSnapshot =
    syncedSession && itemWithOwner
      ? await buildQuizLiveSnapshot(syncedSession, { item: itemWithOwner, forHost: true })
      : null;

  return {
    title: `Start ${item.title}`,
    user,
    item: {
      ...item,
      owner_name: user.name,
      duration_label: buildDurationLabel(item.start_date, item.end_date),
      status: getKuizzoshStatus(
        item.start_date,
        item.end_date,
        getCurrentDateInTimeZone("Asia/Kuala_Lumpur")
      ),
      join_url: `/quizzes/join/${item.quiz_code}`
    },
    canGoLive: liveQuestions.some((question) => question.id),
    initialSnapshot,
    serializedLiveSnapshot: JSON.stringify(initialSnapshot || {}).replace(/</g, "\\u003c")
  };
}

async function renderQuizStartPage(req, res, itemId, options = {}) {
  const viewModel = await buildQuizStartViewModel(req.session.user.id, itemId, options);

  if (!viewModel) {
    res.redirect("/quizzes");
    return;
  }

  res.status(options.statusCode || 200).render("quiz-start", viewModel);
}

async function renderQuizPresentPage(req, res, itemId, options = {}) {
  const viewModel = await buildQuizStartViewModel(req.session.user.id, itemId, options);

  if (!viewModel) {
    res.redirect("/quizzes");
    return;
  }

  res.status(options.statusCode || 200).render("quiz-present", viewModel);
}

async function buildQuizJoinViewModel(req, quizCode, options = {}) {
  const item = await getQuizItemWithOwnerByCode(quizCode);

  if (!item) {
    return null;
  }

  const participantEntry = getQuizParticipantEntry(req, quizCode);
  const activeSession = await getActiveQuizLiveSession(item.id);
  const settings = await loadQuizSettings(item.id);
  const liveQuestions = await loadQuizLiveQuestions(item.id);
  let liveSession = activeSession;

  if (participantEntry?.sessionId) {
    const storedSession = await getQuizLiveSessionById(participantEntry.sessionId);

    if (storedSession && storedSession.module_item_id === item.id) {
      if (activeSession && activeSession.id !== storedSession.id && activeSession.status !== QUIZ_LIVE_STATUSES.ENDED) {
        clearQuizParticipantEntry(req, quizCode);
      } else {
        liveSession = storedSession;
      }
    } else if (participantEntry) {
      clearQuizParticipantEntry(req, quizCode);
    }
  }

  const nextParticipantEntry = getQuizParticipantEntry(req, quizCode);
  const participant =
    liveSession && nextParticipantEntry?.participantId
      ? await dbGet(
          `
            SELECT id, display_name, join_token
            FROM quiz_live_participants
            WHERE id = ? AND session_id = ?
          `,
          [nextParticipantEntry.participantId, liveSession.id]
        )
      : null;

  if (!participant && nextParticipantEntry) {
    clearQuizParticipantEntry(req, quizCode);
  }

  if (participant?.id) {
    await touchQuizParticipant(participant.id);
  }

  if (liveSession) {
    liveSession = await syncQuizLiveSession(liveSession, settings, liveQuestions);
  }

  const snapshot =
    liveSession
      ? await buildQuizLiveSnapshot(liveSession, {
          item,
          settings,
          participantId: participant?.id || null
        })
      : null;
  const joinState = participant?.id
    ? "joined"
    : liveSession?.status === QUIZ_LIVE_STATUSES.LOBBY
      ? "lobby"
      : liveSession && liveSession.status !== QUIZ_LIVE_STATUSES.ENDED
        ? "late"
        : "waiting";

  return {
    title: item.title,
    item: {
      ...item,
      duration_label: buildDurationLabel(item.start_date, item.end_date)
    },
    liveSnapshot: snapshot,
    serializedLiveSnapshot: JSON.stringify(snapshot || {}).replace(/</g, "\\u003c"),
    activeSession: joinState === "lobby",
    joinState,
    participantCount: snapshot?.participantCount || 0,
    participant,
    joinError: options.error || ""
  };
}

async function renderQuizJoinPage(req, res, quizCode, options = {}) {
  const viewModel = await buildQuizJoinViewModel(req, quizCode, options);

  if (!viewModel) {
    res.status(404).render("error", {
      title: "Not Found",
      message: "That quiz could not be found."
    });
    return;
  }

  res.status(options.statusCode || 200).render("quiz-join", viewModel);
}

async function moveQuizLiveSessionToQuestion(session, questionIndex, question) {
  const now = new Date();
  const phaseEndsAt = new Date(now.getTime() + question.timeLimit * 1000).toISOString();
  const changes = {
    status: QUIZ_LIVE_STATUSES.QUESTION,
    phaseMode: null,
    currentQuestionIndex: questionIndex,
    questionStartedAt: now.toISOString(),
    phaseEndsAt,
    endedAt: null
  };

  if (!session.started_at) {
    changes.startedAt = now.toISOString();
  }

  return updateQuizLiveSessionState(session.id, changes);
}

async function fillMissingQuizLiveAnswers(session, question) {
  if (!session?.id || !question?.id) {
    return;
  }

  const participants = await getQuizLiveParticipants(session.id);

  if (!participants.length) {
    return;
  }

  const existingAnswers = await dbAll(
    `
      SELECT participant_id
      FROM quiz_live_answers
      WHERE session_id = ? AND question_id = ?
    `,
    [session.id, question.id]
  );
  const answeredParticipantIds = new Set(
    existingAnswers.map((answer) => Number(answer.participant_id)).filter((participantId) => Number.isInteger(participantId))
  );
  const fallbackResponseTimeMs = Math.max(0, Number(question.timeLimit || 0) * 1000);

  for (const participant of participants) {
    if (answeredParticipantIds.has(Number(participant.id))) {
      continue;
    }

    await dbRun(
      `
        INSERT INTO quiz_live_answers (
          session_id,
          participant_id,
          question_id,
          selected_choice_ids,
          is_correct,
          response_time_ms
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      [session.id, participant.id, question.id, serializeChoiceIdList([]), 0, fallbackResponseTimeMs]
    );
  }
}

async function moveQuizLiveSessionToChart(session, question = null) {
  await fillMissingQuizLiveAnswers(session, question);
  const now = new Date();
  const phaseEndsAt = new Date(now.getTime() + QUIZ_CHART_DURATION_MS).toISOString();

  return updateQuizLiveSessionState(session.id, {
    status: QUIZ_LIVE_STATUSES.LEADERBOARD,
    phaseMode: QUIZ_LIVE_PHASES.CHART,
    phaseEndsAt
  });
}

async function moveQuizLiveSessionToLeaderboard(session) {
  const now = new Date();
  const phaseEndsAt = new Date(now.getTime() + QUIZ_LEADERBOARD_DURATION_MS).toISOString();

  return updateQuizLiveSessionState(session.id, {
    status: QUIZ_LIVE_STATUSES.LEADERBOARD,
    phaseMode: QUIZ_LIVE_PHASES.LEADERBOARD,
    phaseEndsAt
  });
}

async function moveQuizLiveSessionToCountdown(session, options = {}) {
  const now = new Date();
  const phaseEndsAt = new Date(now.getTime() + QUIZ_COUNTDOWN_DURATION_MS).toISOString();
  const changes = {
    status: QUIZ_LIVE_STATUSES.LEADERBOARD,
    phaseMode: QUIZ_LIVE_PHASES.COUNTDOWN,
    phaseEndsAt
  };

  if (Object.prototype.hasOwnProperty.call(options, "currentQuestionIndex")) {
    changes.currentQuestionIndex = options.currentQuestionIndex;
  }

  if (options.markStarted && !session.started_at) {
    changes.startedAt = now.toISOString();
  }

  return updateQuizLiveSessionState(session.id, changes);
}

function shouldShowQuestionLeaderboard(question, settings) {
  return Boolean(settings?.leaderboardEnabled) && Boolean(question?.showLeaderboard);
}

async function moveQuizLiveSessionAfterChart(session, settings, questions) {
  const currentQuestionIndex = Number(session.current_question_index || 0);
  const currentQuestion = questions[currentQuestionIndex] || null;

  if (shouldShowQuestionLeaderboard(currentQuestion, settings)) {
    return moveQuizLiveSessionToLeaderboard(session);
  }

  const hasNextQuestion = Boolean(questions[currentQuestionIndex + 1]?.id);

  if (hasNextQuestion) {
    return moveQuizLiveSessionToCountdown(session);
  }

  return endQuizLiveSession(session.id);
}

async function endQuizLiveSession(sessionId) {
  return updateQuizLiveSessionState(sessionId, {
    status: QUIZ_LIVE_STATUSES.ENDED,
    phaseMode: null,
    questionStartedAt: null,
    phaseEndsAt: null,
    endedAt: new Date().toISOString()
  });
}

async function moveQuizLiveSessionToNextQuestionOrEnd(session, questions) {
  const nextQuestionIndex = Number(session.current_question_index || 0) + 1;
  const nextQuestion = questions[nextQuestionIndex] || null;

  if (nextQuestion?.id) {
    return moveQuizLiveSessionToQuestion(session, nextQuestionIndex, nextQuestion);
  }

  return endQuizLiveSession(session.id);
}

async function startQuizLiveSession(session, questions) {
  const firstQuestion = questions[0] || null;

  if (!firstQuestion?.id) {
    throw new Error("Save the quiz before starting a live session.");
  }

  return moveQuizLiveSessionToCountdown(session, {
    currentQuestionIndex: -1,
    markStarted: true
  });
}

async function syncQuizLiveSession(session, settings, questions) {
  let currentSession = session;

  for (let step = 0; step < 8; step += 1) {
    if (
      !currentSession ||
      currentSession.status === QUIZ_LIVE_STATUSES.LOBBY ||
      currentSession.status === QUIZ_LIVE_STATUSES.ENDED
    ) {
      return currentSession;
    }

    const phaseEndsAt = currentSession.phase_ends_at
      ? new Date(currentSession.phase_ends_at).getTime()
      : 0;

    if (!phaseEndsAt || Date.now() < phaseEndsAt) {
      return currentSession;
    }

    const currentQuestion = questions[currentSession.current_question_index] || null;

    if (currentSession.status === QUIZ_LIVE_STATUSES.QUESTION) {
      if (currentQuestion?.id) {
        currentSession = await moveQuizLiveSessionToChart(currentSession, currentQuestion);
        continue;
      }

      currentSession = await moveQuizLiveSessionToNextQuestionOrEnd(currentSession, questions);
      continue;
    }

    if (
      currentSession.status === QUIZ_LIVE_STATUSES.LEADERBOARD &&
      currentSession.phase_mode === QUIZ_LIVE_PHASES.CHART
    ) {
      currentSession = await moveQuizLiveSessionAfterChart(currentSession, settings, questions);
      continue;
    }

    if (
      currentSession.status === QUIZ_LIVE_STATUSES.LEADERBOARD &&
      currentSession.phase_mode === QUIZ_LIVE_PHASES.LEADERBOARD
    ) {
      const hasNextQuestion = Boolean(questions[Number(currentSession.current_question_index || 0) + 1]?.id);

      if (hasNextQuestion) {
        currentSession = await moveQuizLiveSessionToCountdown(currentSession);
        continue;
      }

      currentSession = await endQuizLiveSession(currentSession.id);
      continue;
    }

    if (
      currentSession.status === QUIZ_LIVE_STATUSES.LEADERBOARD &&
      currentSession.phase_mode === QUIZ_LIVE_PHASES.COUNTDOWN
    ) {
      currentSession = await moveQuizLiveSessionToNextQuestionOrEnd(currentSession, questions);
      continue;
    }
  }

  return currentSession;
}

async function buildUniqueParticipantName(sessionId, requestedName) {
  const baseName = String(requestedName || "").trim().slice(0, 32) || "Player";
  const existingRows = await dbAll(
    `
      SELECT display_name
      FROM quiz_live_participants
      WHERE session_id = ?
    `,
    [sessionId]
  );
  const existingNames = new Set(
    existingRows.map((row) => String(row.display_name || "").toLowerCase())
  );

  if (!existingNames.has(baseName.toLowerCase())) {
    return baseName;
  }

  for (let index = 2; index <= 999; index += 1) {
    const nextName = `${baseName} ${index}`;
    if (!existingNames.has(nextName.toLowerCase())) {
      return nextName;
    }
  }

  return `${baseName} ${Date.now()}`;
}

async function createQuizLiveParticipant(sessionId, requestedName) {
  const displayName = await buildUniqueParticipantName(sessionId, requestedName);
  const joinToken = createRandomToken();
  const result = await dbRun(
    `
      INSERT INTO quiz_live_participants (session_id, display_name, join_token, last_seen_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    `,
    [sessionId, displayName, joinToken]
  );

  return dbGet(
    `
      SELECT id, display_name, join_token
      FROM quiz_live_participants
      WHERE id = ?
    `,
    [result.lastID]
  );
}

function areChoiceSetsEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

async function buildModuleSetupViewModel(userId, pageKey, itemId, options = {}) {
  const config = MODULE_PAGE_CONFIG[pageKey];

  if (!config) {
    return null;
  }

  const user = await dbGet(
    "SELECT id, name, email, created_at FROM users WHERE id = ?",
    [userId]
  );

  if (!user) {
    return null;
  }

  const item = await getOwnedModuleItem(userId, config.dbType, itemId);

  if (!item) {
    return null;
  }

  const currentDate = getCurrentDateInTimeZone("Asia/Kuala_Lumpur");

  return {
    title: `${item.title} Setup`,
    user,
    pageKey,
    pageTitle: config.pageTitle,
    singular: config.singular,
    item: {
      ...item,
      owner_name: user.name,
      duration_label: buildDurationLabel(item.start_date, item.end_date),
      status: getKuizzoshStatus(item.start_date, item.end_date, currentDate)
    }
  };
}

async function renderModuleSetupPage(req, res, pageKey, itemId, options = {}) {
  const viewModel = await buildModuleSetupViewModel(req.session.user.id, pageKey, itemId, options);

  if (!viewModel) {
    res.redirect(`/${pageKey}`);
    return;
  }

  res.status(options.statusCode || 200).render("module-setup", viewModel);
}

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

const isProduction = process.env.NODE_ENV === "production";
const isVercelDeployment = Boolean(process.env.VERCEL);

if (isProduction || isVercelDeployment) {
  app.set("trust proxy", 1);
}

app.use(express.urlencoded({ extended: true, limit: "12mb" }));
app.use(express.json({ limit: "12mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use(
  session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET || "kuizzosh-dev-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction || isVercelDeployment,
      maxAge: 1000 * 60 * 60 * 24
    }
  })
);

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.currentPath = req.path;
  next();
});

app.get("/", (req, res) => {
  if (req.session.user) {
    res.redirect("/dashboard");
    return;
  }

  res.redirect("/login");
});

app.get("/login", requireGuest, (req, res) => {
  renderAuthPage(res, "login", {
    title: "Login"
  });
});

app.post("/login", requireGuest, async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || "");

  if (!email || !password) {
    renderAuthPage(res, "login", {
      title: "Login",
      error: "Email and password are required.",
      formData: { email }
    });
    return;
  }

  try {
    let user = null;

    if (USE_SUPABASE_AUTH) {
      try {
        const authUser = await signInWithSupabase(email, password);
        user = await syncLocalUserWithSupabaseAuthUser(authUser);
      } catch (error) {
        console.error("Supabase login failed:", error);
        renderAuthPage(res, "login", {
          title: "Login",
          error: "Incorrect email or password.",
          formData: { email }
        });
        return;
      }
    } else {
      user = await getUserByEmail(email);

      if (!user) {
        renderAuthPage(res, "login", {
          title: "Login",
          error: "No account found for that email.",
          formData: { email }
        });
        return;
      }

      const isMatch = await bcrypt.compare(password, user.password_hash);

      if (!isMatch) {
        renderAuthPage(res, "login", {
          title: "Login",
          error: "Incorrect password.",
          formData: { email }
        });
        return;
      }
    }

    req.session.user = toSessionUser(user);
    req.session.save(() => {
      res.redirect("/dashboard");
    });
  } catch (error) {
    console.error("Login failed:", error);
    renderAuthPage(res, "login", {
      title: "Login",
      error: "Unable to log in right now. Please try again.",
      formData: { email }
    });
  }
});

app.get("/register", requireGuest, (req, res) => {
  renderAuthPage(res, "register", {
    title: "Register"
  });
});

app.post("/register", requireGuest, async (req, res) => {
  const name = String(req.body.name || "").trim();
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || "");
  const confirmPassword = String(req.body.confirmPassword || "");

  if (!name || !email || !password || !confirmPassword) {
    renderAuthPage(res, "register", {
      title: "Register",
      error: "Please complete every field.",
      formData: { name, email }
    });
    return;
  }

  if (!isValidEmail(email)) {
    renderAuthPage(res, "register", {
      title: "Register",
      error: "Please enter a valid email address.",
      formData: { name, email }
    });
    return;
  }

  if (password.length < 8) {
    renderAuthPage(res, "register", {
      title: "Register",
      error: "Password must be at least 8 characters.",
      formData: { name, email }
    });
    return;
  }

  if (password !== confirmPassword) {
    renderAuthPage(res, "register", {
      title: "Register",
      error: "Passwords do not match.",
      formData: { name, email }
    });
    return;
  }

  try {
    const existingUser = await getUserByEmail(email);

    if (existingUser) {
      renderAuthPage(res, "register", {
        title: "Register",
        error: "That email is already registered.",
        formData: { name, email }
      });
      return;
    }

    let newUser = null;

    if (USE_SUPABASE_AUTH) {
      let authUser = null;

      try {
        authUser = await registerWithSupabase({ name, email, password });
        newUser = await syncLocalUserWithSupabaseAuthUser(authUser);
      } catch (error) {
        if (authUser?.id) {
          try {
            const supabaseAdmin = await getSupabaseAdminClient();
            await supabaseAdmin.auth.admin.deleteUser(authUser.id);
          } catch (cleanupError) {
            console.error("Supabase registration cleanup failed:", cleanupError);
          }
        }

        if (isSupabaseEmailAlreadyRegisteredError(error)) {
          renderAuthPage(res, "register", {
            title: "Register",
            error: "That email is already registered.",
            formData: { name, email }
          });
          return;
        }

        throw error;
      }
    } else {
      const passwordHash = await bcrypt.hash(password, 10);
      const insertResult = await dbRun(
        "INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)",
        [name, email, passwordHash]
      );
      newUser = await getUserById(insertResult.lastID);
    }

    req.session.user = toSessionUser(newUser);
    req.session.save(() => {
      res.redirect("/dashboard");
    });
  } catch (error) {
    console.error("Registration failed:", error);
    renderAuthPage(res, "register", {
      title: "Register",
      error: "Unable to create your account right now. Please try again.",
      formData: { name, email }
    });
  }
});

app.get("/dashboard", requireAuth, async (req, res) => {
  try {
    const flash = req.session.dashboardFlash || null;
    delete req.session.dashboardFlash;

    await renderDashboardPage(req, res, {
      success: flash?.type === "success" ? flash.message : "",
      error: flash?.type === "error" ? flash.message : ""
    });
  } catch (error) {
    console.error("Dashboard failed:", error);
    res.status(500).render("error", {
      title: "Server Error",
      message: "The dashboard could not be loaded."
    });
  }
});

for (const pageKey of Object.keys(MODULE_PAGE_CONFIG)) {
  const config = MODULE_PAGE_CONFIG[pageKey];

  app.get(`/${pageKey}`, requireAuth, async (req, res) => {
    try {
      const flashKey = getModuleFlashKey(pageKey);
      const flash = req.session[flashKey] || null;
      delete req.session[flashKey];

      await renderModulePage(req, res, pageKey, {
        success: flash?.type === "success" ? flash.message : "",
        error: flash?.type === "error" ? flash.message : ""
      });
    } catch (error) {
      console.error(`${pageKey} page failed:`, error);
      res.status(500).render("error", {
        title: "Server Error",
        message: `The ${pageKey} page could not be loaded.`
      });
    }
  });

  app.get(`/${pageKey}/:id/setup`, requireAuth, async (req, res) => {
    const itemId = parseItemId(req.params.id);

    if (!itemId) {
      res.redirect(`/${pageKey}`);
      return;
    }

    try {
      if (pageKey === "quizzes") {
        const flash =
          req.session.quizSetupFlash?.itemId === itemId ? req.session.quizSetupFlash : null;
        const initialSectionIndex = normalizeInteger(req.query.section, 1, 1, 999) - 1;
        const initialQuestionIndex = normalizeInteger(req.query.question, 1, 1, 999) - 1;

        if (flash) {
          delete req.session.quizSetupFlash;
        }

        await renderQuizSetupPage(req, res, itemId, {
          flash,
          initialSectionIndex,
          initialQuestionIndex
        });
        return;
      }

      await renderModuleSetupPage(req, res, pageKey, itemId);
    } catch (error) {
      console.error(`${pageKey} setup page failed:`, error);
      res.status(500).render("error", {
        title: "Server Error",
        message: `The ${config.singular.toLowerCase()} setup page could not be loaded.`
      });
    }
  });

  if (pageKey === "quizzes") {
    app.get(`/${pageKey}/:id/start`, requireAuth, async (req, res) => {
      const itemId = parseItemId(req.params.id);

      if (!itemId) {
        res.redirect("/quizzes");
        return;
      }

      try {
        await renderQuizStartPage(req, res, itemId, {
          forceNew: req.query.new === "1"
        });
      } catch (error) {
        console.error("Quiz start page failed:", error);
        res.status(500).render("error", {
          title: "Server Error",
          message: "The quiz start page could not be loaded."
        });
      }
    });

    app.get(`/${pageKey}/:id/present`, requireAuth, async (req, res) => {
      const itemId = parseItemId(req.params.id);

      if (!itemId) {
        res.redirect("/quizzes");
        return;
      }

      try {
        await renderQuizPresentPage(req, res, itemId, {
          forceNew: req.query.new === "1"
        });
      } catch (error) {
        console.error("Quiz present page failed:", error);
        res.status(500).render("error", {
          title: "Server Error",
          message: "The present mode page could not be loaded."
        });
      }
    });
  }

  app.post(`/${pageKey}/create`, requireAuth, async (req, res) => {
    const title = String(req.body.title || "").trim();
    const startDate = String(req.body.startDate || "").trim();
    const endDate = String(req.body.endDate || "").trim();
    const visibility = normalizeVisibility(req.body.visibility);
    const formData = {
      title,
      startDate,
      endDate,
      visibility
    };

    if (!title || !startDate || !endDate) {
      await renderModulePage(req, res, pageKey, {
        error: "Please fill in title, start date, and end date.",
        formData,
        openCreateModal: true,
        statusCode: 422
      });
      return;
    }

    if (title.length > 120) {
      await renderModulePage(req, res, pageKey, {
        error: "Title must be 120 characters or fewer.",
        formData,
        openCreateModal: true,
        statusCode: 422
      });
      return;
    }

    if (!isValidDateInput(startDate) || !isValidDateInput(endDate)) {
      await renderModulePage(req, res, pageKey, {
        error: "Please choose valid start and end dates.",
        formData,
        openCreateModal: true,
        statusCode: 422
      });
      return;
    }

    if (endDate < startDate) {
      await renderModulePage(req, res, pageKey, {
        error: "End date must be the same day or after the start date.",
        formData,
        openCreateModal: true,
        statusCode: 422
      });
      return;
    }

    try {
      const quizCode = config.dbType === "quiz" ? await generateUniqueModuleQuizCode() : null;

      await dbRun(
        `
          INSERT INTO module_items (user_id, module_type, title, start_date, end_date, visibility, quiz_code)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [req.session.user.id, config.dbType, title, startDate, endDate, visibility, quizCode]
      );

      req.session[getModuleFlashKey(pageKey)] = {
        type: "success",
        message: `${config.singular} "${title}" created successfully.`
      };

      req.session.save(() => {
        res.redirect(`/${pageKey}`);
      });
    } catch (error) {
      console.error(`Create ${config.singular} failed:`, error);
      await renderModulePage(req, res, pageKey, {
        error: `Unable to create the ${config.singular.toLowerCase()} right now.`,
        formData,
        openCreateModal: true,
        statusCode: 500
      });
    }
  });

  if (pageKey === "quizzes") {
    app.post(`/${pageKey}/:id/setup`, requireAuth, async (req, res) => {
      const itemId = parseItemId(req.params.id);
      let quizSettings = createDefaultQuizSettings();
      let rawBuilderState = createDefaultQuizBuilderState();
      const activeSectionIndex = normalizeInteger(req.body.activeSectionIndex, 0, 0, 999);
      const activeQuestionIndex = normalizeInteger(req.body.activeQuestionIndex, 0, 0, 999);

      if (!itemId) {
        res.redirect("/quizzes");
        return;
      }

      try {
        const item = await getOwnedModuleItem(req.session.user.id, config.dbType, itemId);

        if (!item) {
          res.redirect("/quizzes");
          return;
        }

        quizSettings = {
          leaderboardEnabled: parseBooleanFlag(req.body.leaderboardEnabled, true),
          speedBonusEnabled: parseBooleanFlag(req.body.speedBonusEnabled, true),
          showCorrectAnswer: parseBooleanFlag(req.body.showCorrectAnswer, true),
          randomizeQuestions: parseBooleanFlag(req.body.randomizeQuestions, false),
          randomizeChoices: parseBooleanFlag(req.body.randomizeChoices, false)
        };

        try {
          rawBuilderState = JSON.parse(String(req.body.builderState || "{}"));
        } catch (error) {
          await renderQuizSetupPage(req, res, itemId, {
            error: "The quiz builder data could not be read. Please try again.",
            builderState: await loadQuizBuilderState(itemId),
            settings: quizSettings,
            initialSectionIndex: activeSectionIndex,
            initialQuestionIndex: activeQuestionIndex,
            statusCode: 422
          });
          return;
        }

        const validationResult = validateQuizBuilderState(rawBuilderState);

        if (validationResult.error) {
          await renderQuizSetupPage(req, res, itemId, {
            error: validationResult.error,
            builderState: validationResult.builderState,
            settings: quizSettings,
            initialSectionIndex: activeSectionIndex,
            initialQuestionIndex: activeQuestionIndex,
            statusCode: 422
          });
          return;
        }

        await saveQuizBuilder(itemId, quizSettings, validationResult.builderState);

        req.session.quizSetupFlash = {
          itemId,
          type: "success",
          message: `Quiz "${item.title}" saved successfully.`
        };

        req.session.save(() => {
          const params = new URLSearchParams({
            section: String(activeSectionIndex + 1),
            question: String(activeQuestionIndex + 1)
          });
          res.redirect(`/quizzes/${itemId}/setup?${params.toString()}`);
        });
      } catch (error) {
        console.error("Quiz setup save failed:", error);
        await renderQuizSetupPage(req, res, itemId, {
          error: "Unable to save the quiz right now.",
          builderState: normalizeQuizBuilderState(rawBuilderState),
          settings: quizSettings,
          initialSectionIndex: activeSectionIndex,
          initialQuestionIndex: activeQuestionIndex,
          statusCode: 500
        });
      }
    });
  }

  app.post(`/${pageKey}/:id/duplicate`, requireAuth, async (req, res) => {
    const itemId = parseItemId(req.params.id);

    if (!itemId) {
      req.session[getModuleFlashKey(pageKey)] = {
        type: "error",
        message: `Invalid ${config.singular.toLowerCase()} selected.`
      };
      req.session.save(() => {
        res.redirect(`/${pageKey}`);
      });
      return;
    }

    try {
      const existingItem = await getOwnedModuleItem(req.session.user.id, config.dbType, itemId);

      if (!existingItem) {
        req.session[getModuleFlashKey(pageKey)] = {
          type: "error",
          message: `${config.singular} not found.`
        };
        req.session.save(() => {
          res.redirect(`/${pageKey}`);
        });
        return;
      }

      const duplicateTitle = buildDuplicateTitle(existingItem.title);
      const quizCode =
        config.dbType === "quiz" ? await generateUniqueModuleQuizCode() : existingItem.quiz_code || null;
      const quizSettings =
        config.dbType === "quiz" ? await loadQuizSettings(itemId) : createDefaultQuizSettings();
      const quizBuilderState =
        config.dbType === "quiz" ? await loadQuizBuilderState(itemId) : createDefaultQuizBuilderState();

      const insertResult = await dbRun(
        `
          INSERT INTO module_items (user_id, module_type, title, start_date, end_date, visibility, quiz_code)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [
          req.session.user.id,
          config.dbType,
          duplicateTitle,
          existingItem.start_date,
          existingItem.end_date,
          existingItem.visibility,
          quizCode
        ]
      );

      if (config.dbType === "quiz") {
        await saveQuizBuilder(insertResult.lastID, quizSettings, quizBuilderState);
      }

      req.session[getModuleFlashKey(pageKey)] = {
        type: "success",
        message: `${config.singular} "${duplicateTitle}" duplicated successfully.`
      };
      req.session.save(() => {
        res.redirect(`/${pageKey}`);
      });
    } catch (error) {
      console.error(`Duplicate ${config.singular} failed:`, error);
      req.session[getModuleFlashKey(pageKey)] = {
        type: "error",
        message: `Unable to duplicate the ${config.singular.toLowerCase()} right now.`
      };
      req.session.save(() => {
        res.redirect(`/${pageKey}`);
      });
    }
  });

  app.post(`/${pageKey}/:id/delete`, requireAuth, async (req, res) => {
    const itemId = parseItemId(req.params.id);

    if (!itemId) {
      req.session[getModuleFlashKey(pageKey)] = {
        type: "error",
        message: `Invalid ${config.singular.toLowerCase()} selected.`
      };
      req.session.save(() => {
        res.redirect(`/${pageKey}`);
      });
      return;
    }

    try {
      const existingItem = await getOwnedModuleItem(req.session.user.id, config.dbType, itemId);

      if (!existingItem) {
        req.session[getModuleFlashKey(pageKey)] = {
          type: "error",
          message: `${config.singular} not found.`
        };
        req.session.save(() => {
          res.redirect(`/${pageKey}`);
        });
        return;
      }

      if (config.dbType === "quiz") {
        await clearQuizBuilder(itemId);
        await clearQuizLiveResults(itemId);
      }

      await dbRun(
        "DELETE FROM module_items WHERE id = ? AND user_id = ? AND module_type = ?",
        [itemId, req.session.user.id, config.dbType]
      );

      req.session[getModuleFlashKey(pageKey)] = {
        type: "success",
        message: `${config.singular} "${existingItem.title}" deleted successfully.`
      };
      req.session.save(() => {
        res.redirect(`/${pageKey}`);
      });
    } catch (error) {
      console.error(`Delete ${config.singular} failed:`, error);
      req.session[getModuleFlashKey(pageKey)] = {
        type: "error",
        message: `Unable to delete the ${config.singular.toLowerCase()} right now.`
      };
      req.session.save(() => {
        res.redirect(`/${pageKey}`);
      });
    }
  });
}

app.get("/api/quizzes/:id/live/:sessionId", requireAuth, async (req, res) => {
  const itemId = parseItemId(req.params.id);
  const sessionId = parseItemId(req.params.sessionId);

  if (!itemId || !sessionId) {
    res.status(404).json({ error: "Live session not found." });
    return;
  }

  try {
    let liveSession = await getOwnedQuizLiveSession(req.session.user.id, itemId, sessionId);

    if (!liveSession) {
      res.status(404).json({ error: "Live session not found." });
      return;
    }

    const settings = await loadQuizSettings(itemId);
    const questions = await loadQuizLiveQuestions(itemId);
    liveSession = await syncQuizLiveSession(liveSession, settings, questions);
    const snapshot = await buildQuizLiveSnapshot(liveSession, {
      settings,
      forHost: true
    });
    res.json({ snapshot });
  } catch (error) {
    console.error("Load quiz live state failed:", error);
    res.status(500).json({ error: "Unable to load the live quiz right now." });
  }
});

app.post("/api/quizzes/:id/live/:sessionId/advance", requireAuth, async (req, res) => {
  const itemId = parseItemId(req.params.id);
  const sessionId = parseItemId(req.params.sessionId);

  if (!itemId || !sessionId) {
    res.status(404).json({ error: "Live session not found." });
    return;
  }

  try {
    let liveSession = await getOwnedQuizLiveSession(req.session.user.id, itemId, sessionId);

    if (!liveSession) {
      res.status(404).json({ error: "Live session not found." });
      return;
    }

    const settings = await loadQuizSettings(itemId);
    const questions = await loadQuizLiveQuestions(itemId);
    liveSession = await syncQuizLiveSession(liveSession, settings, questions);

    let updatedSession = liveSession;

    if (liveSession.status === QUIZ_LIVE_STATUSES.LOBBY) {
      updatedSession = await startQuizLiveSession(liveSession, questions);
    } else if (liveSession.status === QUIZ_LIVE_STATUSES.QUESTION) {
      updatedSession = await moveQuizLiveSessionToChart(
        liveSession,
        questions[Number(liveSession.current_question_index || 0)] || null
      );
    } else if (
      liveSession.status === QUIZ_LIVE_STATUSES.LEADERBOARD &&
      liveSession.phase_mode === QUIZ_LIVE_PHASES.CHART
    ) {
      updatedSession = await moveQuizLiveSessionAfterChart(liveSession, settings, questions);
    } else if (
      liveSession.status === QUIZ_LIVE_STATUSES.LEADERBOARD &&
      liveSession.phase_mode === QUIZ_LIVE_PHASES.LEADERBOARD
    ) {
      const hasNextQuestion = Boolean(questions[Number(liveSession.current_question_index || 0) + 1]?.id);
      updatedSession = hasNextQuestion
        ? await moveQuizLiveSessionToCountdown(liveSession)
        : await endQuizLiveSession(liveSession.id);
    } else if (
      liveSession.status === QUIZ_LIVE_STATUSES.LEADERBOARD &&
      liveSession.phase_mode === QUIZ_LIVE_PHASES.COUNTDOWN
    ) {
      updatedSession = await moveQuizLiveSessionToNextQuestionOrEnd(liveSession, questions);
    }

    const snapshot = await buildQuizLiveSnapshot(updatedSession, {
      settings,
      forHost: true
    });

    res.json({ snapshot });
  } catch (error) {
    console.error("Advance quiz live session failed:", error);
    res.status(422).json({ error: error.message || "Unable to advance the live quiz right now." });
  }
});

app.post("/api/quizzes/:id/live/:sessionId/end", requireAuth, async (req, res) => {
  const itemId = parseItemId(req.params.id);
  const sessionId = parseItemId(req.params.sessionId);

  if (!itemId || !sessionId) {
    res.status(404).json({ error: "Live session not found." });
    return;
  }

  try {
    const liveSession = await getOwnedQuizLiveSession(req.session.user.id, itemId, sessionId);

    if (!liveSession) {
      res.status(404).json({ error: "Live session not found." });
      return;
    }

    const updatedSession = await endQuizLiveSession(liveSession.id);
    const snapshot = await buildQuizLiveSnapshot(updatedSession, {
      settings: await loadQuizSettings(itemId),
      forHost: true
    });

    res.json({ snapshot });
  } catch (error) {
    console.error("End quiz live session failed:", error);
    res.status(500).json({ error: "Unable to end the live quiz right now." });
  }
});

app.post("/quizzes/:id/live/reset", requireAuth, async (req, res) => {
  const itemId = parseItemId(req.params.id);

  if (!itemId) {
    res.redirect("/quizzes");
    return;
  }

  try {
    const item = await getOwnedModuleItem(req.session.user.id, "quiz", itemId);

    if (!item) {
      res.redirect("/quizzes");
      return;
    }

    await withTransaction(async (executor) => {
      await clearQuizLiveResults(itemId, executor);
    });

    req.session.quizSetupFlash = {
      itemId,
      type: "success",
      message: `Leaderboard history for "${item.title}" has been reset.`
    };

    req.session.save(() => {
      res.redirect(`/quizzes/${itemId}/setup`);
    });
  } catch (error) {
    console.error("Reset quiz leaderboard failed:", error);
    req.session.quizSetupFlash = {
      itemId,
      type: "error",
      message: "Unable to reset the leaderboard right now."
    };
    req.session.save(() => {
      res.redirect(`/quizzes/${itemId}/setup`);
    });
  }
});

app.get("/join/:quizCode", async (req, res) => {
  const quizCode = String(req.params.quizCode || "").trim();

  if (!/^\d{6}$/.test(quizCode)) {
    res.status(404).render("error", {
      title: "Not Found",
      message: "That Kuizzosh link is invalid."
    });
    return;
  }

  try {
    const item = await dbGet(
      `
        SELECT k.id, k.title, k.start_date, k.end_date, k.visibility, k.quiz_code, u.name AS owner_name
        FROM kuizzosh_items k
        JOIN users u ON u.id = k.user_id
        WHERE k.quiz_code = ?
      `,
      [quizCode]
    );

    if (!item) {
      res.status(404).render("error", {
        title: "Not Found",
        message: "That Kuizzosh could not be found."
      });
      return;
    }

    res.render("join", {
      title: item.title,
      joinLabel: "Kuizzosh Link",
      joinMessage: "This shared Kuizzosh page is live and ready for the next participant experience.",
      item: {
        ...item,
        duration_label: buildDurationLabel(item.start_date, item.end_date)
      }
    });
  } catch (error) {
    console.error("Join page failed:", error);
    res.status(500).render("error", {
      title: "Server Error",
      message: "The Kuizzosh link could not be opened."
    });
  }
});

app.get("/quizzes/join/:quizCode", async (req, res) => {
  const quizCode = String(req.params.quizCode || "").trim();

  if (!/^\d{6}$/.test(quizCode)) {
    res.status(404).render("error", {
      title: "Not Found",
      message: "That quiz code is invalid."
    });
    return;
  }

  try {
    await renderQuizJoinPage(req, res, quizCode);
  } catch (error) {
    console.error("Quiz join page failed:", error);
    res.status(500).render("error", {
      title: "Server Error",
      message: "The quiz join page could not be opened."
    });
  }
});

app.post("/quizzes/join/:quizCode/join", async (req, res) => {
  const quizCode = String(req.params.quizCode || "").trim();
  const displayName = String(req.body.displayName || "").trim().slice(0, 32);

  if (!/^\d{6}$/.test(quizCode)) {
    res.status(404).render("error", {
      title: "Not Found",
      message: "That quiz code is invalid."
    });
    return;
  }

  if (!displayName) {
    await renderQuizJoinPage(req, res, quizCode, {
      error: "Enter a nickname to join the live quiz.",
      statusCode: 422
    });
    return;
  }

  try {
    const item = await getQuizItemWithOwnerByCode(quizCode);

    if (!item) {
      res.status(404).render("error", {
        title: "Not Found",
        message: "That quiz could not be found."
      });
      return;
    }

    let activeSession = await getActiveQuizLiveSession(item.id);

    if (!activeSession) {
      await renderQuizJoinPage(req, res, quizCode, {
        error: "The host has not started this quiz yet.",
        statusCode: 409
      });
      return;
    }

    activeSession = await syncQuizLiveSession(
      activeSession,
      await loadQuizSettings(item.id),
      await loadQuizLiveQuestions(item.id)
    );

    if (!activeSession || activeSession.status === QUIZ_LIVE_STATUSES.ENDED) {
      await renderQuizJoinPage(req, res, quizCode, {
        error: "This quiz session has already ended.",
        statusCode: 409
      });
      return;
    }

    const existingEntry = getQuizParticipantEntry(req, quizCode);

    if (existingEntry?.sessionId === activeSession.id && existingEntry?.participantId) {
      res.redirect(`/quizzes/join/${quizCode}`);
      return;
    }

    if (activeSession.status !== QUIZ_LIVE_STATUSES.LOBBY) {
      await renderQuizJoinPage(req, res, quizCode, {
        statusCode: 409
      });
      return;
    }

    const participant = await createQuizLiveParticipant(activeSession.id, displayName);

    setQuizParticipantEntry(req, quizCode, {
      sessionId: activeSession.id,
      participantId: participant.id,
      joinToken: participant.join_token
    });

    req.session.save(() => {
      res.redirect(`/quizzes/join/${quizCode}`);
    });
  } catch (error) {
    console.error("Quiz live join failed:", error);
    await renderQuizJoinPage(req, res, quizCode, {
      error: "Unable to join the live quiz right now.",
      statusCode: 500
    });
  }
});

app.get("/api/quizzes/join/:quizCode/state", async (req, res) => {
  const quizCode = String(req.params.quizCode || "").trim();

  if (!/^\d{6}$/.test(quizCode)) {
    res.status(404).json({ error: "That quiz code is invalid." });
    return;
  }

  try {
    const viewModel = await buildQuizJoinViewModel(req, quizCode);

    if (!viewModel) {
      res.status(404).json({ error: "That quiz could not be found." });
      return;
    }

    res.json({
      snapshot: viewModel.liveSnapshot,
      participant: viewModel.participant
        ? {
            id: viewModel.participant.id,
            displayName: viewModel.participant.display_name
          }
        : null,
      joinState: viewModel.joinState,
      activeSession: viewModel.activeSession,
      participantCount: viewModel.participantCount || 0
    });
  } catch (error) {
    console.error("Load quiz participant state failed:", error);
    res.status(500).json({ error: "Unable to load the live quiz state right now." });
  }
});

app.post("/api/quizzes/join/:quizCode/answer", async (req, res) => {
  const quizCode = String(req.params.quizCode || "").trim();

  if (!/^\d{6}$/.test(quizCode)) {
    res.status(404).json({ error: "That quiz code is invalid." });
    return;
  }

  try {
    const item = await getQuizItemWithOwnerByCode(quizCode);

    if (!item) {
      res.status(404).json({ error: "That quiz could not be found." });
      return;
    }

    const participantEntry = getQuizParticipantEntry(req, quizCode);

    if (!participantEntry?.sessionId || !participantEntry?.participantId) {
      res.status(401).json({ error: "Join the quiz before submitting an answer." });
      return;
    }

    let liveSession = await getQuizLiveSessionById(participantEntry.sessionId);

    if (!liveSession || liveSession.module_item_id !== item.id) {
      clearQuizParticipantEntry(req, quizCode);
      res.status(409).json({ error: "This live quiz session is no longer available." });
      return;
    }

    const participant = await dbGet(
      `
        SELECT id, display_name, join_token
        FROM quiz_live_participants
        WHERE id = ? AND session_id = ?
      `,
      [participantEntry.participantId, liveSession.id]
    );

    if (!participant || participant.join_token !== participantEntry.joinToken) {
      clearQuizParticipantEntry(req, quizCode);
      res.status(401).json({ error: "This participant session is no longer valid." });
      return;
    }

    const settings = await loadQuizSettings(item.id);
    const questions = await loadQuizLiveQuestions(item.id);
    liveSession = await syncQuizLiveSession(liveSession, settings, questions);

    if (liveSession.status !== QUIZ_LIVE_STATUSES.QUESTION) {
      res.status(409).json({ error: "Answers are closed for this question." });
      return;
    }

    const currentQuestion = questions[liveSession.current_question_index] || null;

    if (!currentQuestion?.id) {
      res.status(422).json({ error: "Save the quiz before running it live." });
      return;
    }

    const existingAnswer = await dbGet(
      `
        SELECT id
        FROM quiz_live_answers
        WHERE session_id = ? AND participant_id = ? AND question_id = ?
      `,
      [liveSession.id, participant.id, currentQuestion.id]
    );

    if (existingAnswer) {
      const snapshot = await buildQuizLiveSnapshot(liveSession, {
        item,
        settings,
        participantId: participant.id
      });
      res.json({ snapshot });
      return;
    }

    const allowedChoiceIds = new Set(
      currentQuestion.choices.map((choice) => choice.id).filter((choiceId) => choiceId)
    );
    const selectedChoiceIds = parseChoiceIdList(req.body.choiceIds).filter((choiceId) =>
      allowedChoiceIds.has(choiceId)
    );

    if (!selectedChoiceIds.length) {
      res.status(422).json({ error: "Choose at least one answer." });
      return;
    }

    const normalizedChoiceIds =
      currentQuestion.questionType === "multiple_choice"
        ? selectedChoiceIds
        : selectedChoiceIds.slice(0, 1);
    const correctChoiceIds = currentQuestion.choices
      .filter((choice) => choice.isCorrect)
      .map((choice) => choice.id)
      .filter((choiceId) => choiceId)
      .sort((left, right) => left - right);
    const questionStartedAt = new Date(liveSession.question_started_at || Date.now()).getTime();
    const responseTimeMs = Math.max(0, Date.now() - questionStartedAt);
    const phaseEndsAt = liveSession.phase_ends_at
      ? new Date(liveSession.phase_ends_at).getTime()
      : questionStartedAt + currentQuestion.timeLimit * 1000;

    if (Date.now() > phaseEndsAt) {
      res.status(422).json({ error: "Time is up for this question." });
      return;
    }

    const isCorrect = areChoiceSetsEqual(normalizedChoiceIds, correctChoiceIds);

    await dbRun(
      `
        INSERT INTO quiz_live_answers (
          session_id,
          participant_id,
          question_id,
          selected_choice_ids,
          is_correct,
          response_time_ms
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      [
        liveSession.id,
        participant.id,
        currentQuestion.id,
        serializeChoiceIdList(normalizedChoiceIds),
        isCorrect ? 1 : 0,
        responseTimeMs
      ]
    );

    await touchQuizParticipant(participant.id);

    const snapshot = await buildQuizLiveSnapshot(liveSession, {
      item,
      settings,
      participantId: participant.id
    });

    res.json({ snapshot });
  } catch (error) {
    console.error("Submit quiz live answer failed:", error);
    res.status(500).json({ error: "Unable to submit the answer right now." });
  }
});

app.post("/kuizzosh/create", requireAuth, async (req, res) => {
  const title = String(req.body.title || "").trim();
  const startDate = String(req.body.startDate || "").trim();
  const endDate = String(req.body.endDate || "").trim();
  const visibility = normalizeVisibility(req.body.visibility);
  const formData = {
    title,
    startDate,
    endDate,
    visibility
  };

  if (!title || !startDate || !endDate) {
    await renderDashboardPage(req, res, {
      error: "Please fill in title, start date, and end date.",
      formData,
      openCreateModal: true,
      statusCode: 422
    });
    return;
  }

  if (title.length > 120) {
    await renderDashboardPage(req, res, {
      error: "Title must be 120 characters or fewer.",
      formData,
      openCreateModal: true,
      statusCode: 422
    });
    return;
  }

  if (!isValidDateInput(startDate) || !isValidDateInput(endDate)) {
    await renderDashboardPage(req, res, {
      error: "Please choose valid start and end dates.",
      formData,
      openCreateModal: true,
      statusCode: 422
    });
    return;
  }

  if (endDate < startDate) {
    await renderDashboardPage(req, res, {
      error: "End date must be the same day or after the start date.",
      formData,
      openCreateModal: true,
      statusCode: 422
    });
    return;
  }

  try {
    const quizCode = await generateUniqueQuizCode();

    await dbRun(
      `
        INSERT INTO kuizzosh_items (user_id, title, start_date, end_date, visibility, quiz_code)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      [req.session.user.id, title, startDate, endDate, visibility, quizCode]
    );

    req.session.dashboardFlash = {
      type: "success",
      message: `Kuizzosh "${title}" created successfully.`
    };

    req.session.save(() => {
      res.redirect("/dashboard");
    });
  } catch (error) {
    console.error("Create Kuizzosh failed:", error);

    await renderDashboardPage(req, res, {
      error: "Unable to create the Kuizzosh right now. Please try again.",
      formData,
      openCreateModal: true,
      statusCode: 500
    });
  }
});

app.post("/kuizzosh/:id/transfer", requireAuth, async (req, res) => {
  const itemId = parseItemId(req.params.id);
  const recipientEmail = normalizeEmail(req.body.recipientEmail);

  if (!itemId) {
    req.session.dashboardFlash = {
      type: "error",
      message: "Invalid Kuizzosh selected."
    };
    req.session.save(() => {
      res.redirect("/dashboard");
    });
    return;
  }

  if (!recipientEmail || !isValidEmail(recipientEmail)) {
    req.session.dashboardFlash = {
      type: "error",
      message: "Please enter a valid recipient email."
    };
    req.session.save(() => {
      res.redirect("/dashboard");
    });
    return;
  }

  try {
    const existingItem = await getOwnedKuizzoshItem(req.session.user.id, itemId);

    if (!existingItem) {
      req.session.dashboardFlash = {
        type: "error",
        message: "Kuizzosh not found."
      };
      req.session.save(() => {
        res.redirect("/dashboard");
      });
      return;
    }

    const recipientUser = await dbGet(
      "SELECT id, name, email FROM users WHERE email = ?",
      [recipientEmail]
    );

    if (!recipientUser) {
      req.session.dashboardFlash = {
        type: "error",
        message: "That recipient account does not exist yet."
      };
      req.session.save(() => {
        res.redirect("/dashboard");
      });
      return;
    }

    if (recipientUser.id === req.session.user.id) {
      req.session.dashboardFlash = {
        type: "error",
        message: "You already own this Kuizzosh."
      };
      req.session.save(() => {
        res.redirect("/dashboard");
      });
      return;
    }

    await dbRun(
      "UPDATE kuizzosh_items SET user_id = ? WHERE id = ? AND user_id = ?",
      [recipientUser.id, itemId, req.session.user.id]
    );

    req.session.dashboardFlash = {
      type: "success",
      message: `Kuizzosh "${existingItem.title}" transferred to ${recipientUser.email}.`
    };
    req.session.save(() => {
      res.redirect("/dashboard");
    });
  } catch (error) {
    console.error("Transfer Kuizzosh failed:", error);
    req.session.dashboardFlash = {
      type: "error",
      message: "Unable to transfer the Kuizzosh right now."
    };
    req.session.save(() => {
      res.redirect("/dashboard");
    });
  }
});

app.post("/kuizzosh/:id/duplicate", requireAuth, async (req, res) => {
  const itemId = parseItemId(req.params.id);

  if (!itemId) {
    req.session.dashboardFlash = {
      type: "error",
      message: "Invalid Kuizzosh selected."
    };
    req.session.save(() => {
      res.redirect("/dashboard");
    });
    return;
  }

  try {
    const existingItem = await getOwnedKuizzoshItem(req.session.user.id, itemId);

    if (!existingItem) {
      req.session.dashboardFlash = {
        type: "error",
        message: "Kuizzosh not found."
      };
      req.session.save(() => {
        res.redirect("/dashboard");
      });
      return;
    }

    const duplicateTitle = buildDuplicateTitle(existingItem.title);
    const quizCode = await generateUniqueQuizCode();

    await dbRun(
      `
        INSERT INTO kuizzosh_items (user_id, title, start_date, end_date, visibility, quiz_code)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      [
        req.session.user.id,
        duplicateTitle,
        existingItem.start_date,
        existingItem.end_date,
        existingItem.visibility,
        quizCode
      ]
    );

    req.session.dashboardFlash = {
      type: "success",
      message: `Kuizzosh "${duplicateTitle}" duplicated successfully.`
    };
    req.session.save(() => {
      res.redirect("/dashboard");
    });
  } catch (error) {
    console.error("Duplicate Kuizzosh failed:", error);
    req.session.dashboardFlash = {
      type: "error",
      message: "Unable to duplicate the Kuizzosh right now."
    };
    req.session.save(() => {
      res.redirect("/dashboard");
    });
  }
});

app.post("/kuizzosh/:id/delete", requireAuth, async (req, res) => {
  const itemId = parseItemId(req.params.id);

  if (!itemId) {
    req.session.dashboardFlash = {
      type: "error",
      message: "Invalid Kuizzosh selected."
    };
    req.session.save(() => {
      res.redirect("/dashboard");
    });
    return;
  }

  try {
    const existingItem = await getOwnedKuizzoshItem(req.session.user.id, itemId);

    if (!existingItem) {
      req.session.dashboardFlash = {
        type: "error",
        message: "Kuizzosh not found."
      };
      req.session.save(() => {
        res.redirect("/dashboard");
      });
      return;
    }

    await dbRun(
      "DELETE FROM kuizzosh_items WHERE id = ? AND user_id = ?",
      [itemId, req.session.user.id]
    );

    req.session.dashboardFlash = {
      type: "success",
      message: `Kuizzosh "${existingItem.title}" deleted successfully.`
    };
    req.session.save(() => {
      res.redirect("/dashboard");
    });
  } catch (error) {
    console.error("Delete Kuizzosh failed:", error);
    req.session.dashboardFlash = {
      type: "error",
      message: "Unable to delete the Kuizzosh right now."
    };
    req.session.save(() => {
      res.redirect("/dashboard");
    });
  }
});

app.post("/logout", requireAuth, (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      console.error("Logout failed:", error);
      res.status(500).render("error", {
        title: "Logout Error",
        message: "Your session could not be ended."
      });
      return;
    }

    res.clearCookie("connect.sid");
    res.redirect("/login");
  });
});

initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Kuizzosh is running at http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize the application:", error);
    process.exit(1);
  });
