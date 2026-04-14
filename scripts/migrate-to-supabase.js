const fs = require("fs");
const path = require("path");

try {
  require("dotenv").config();
} catch (error) {
  // dotenv is optional
}

const sqlite3 = require("sqlite3").verbose();
const { Client } = require("pg");

const SOURCE_DATABASE_URL = String(process.env.SOURCE_DATABASE_URL || "").trim();
const DEFAULT_DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
const TARGET_DATABASE_URL = String(process.env.SUPABASE_DATABASE_URL || "").trim();
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").trim();
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const SQLITE_PATH =
  process.env.SOURCE_SQLITE_PATH ||
  process.env.SQLITE_PATH ||
  path.join(__dirname, "..", "data", "kuizzosh.sqlite");

if (!TARGET_DATABASE_URL) {
  console.error("SUPABASE_DATABASE_URL is required.");
  process.exit(1);
}

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(1);
}

function getSslConfig(connectionString) {
  return connectionString.includes("localhost")
    ? false
    : {
        rejectUnauthorized: false
      };
}

async function loadSupabaseModule() {
  return import("@supabase/supabase-js");
}

async function createSourceAdapter() {
  if (SOURCE_DATABASE_URL) {
    if (SOURCE_DATABASE_URL === TARGET_DATABASE_URL) {
      throw new Error(
        "SOURCE_DATABASE_URL and SUPABASE_DATABASE_URL cannot point to the same database."
      );
    }

    const client = new Client({
      connectionString: SOURCE_DATABASE_URL,
      ssl: getSslConfig(SOURCE_DATABASE_URL)
    });

    await client.connect();

    return {
      type: "postgres",
      async all(sql, params = []) {
        const result = await client.query(sql, params);
        return result.rows;
      },
      async hasTable(tableName) {
        const result = await client.query(
          `
            SELECT EXISTS (
              SELECT 1
              FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = $1
            ) AS exists
          `,
          [tableName]
        );
        return Boolean(result.rows[0]?.exists);
      },
      async close() {
        await client.end();
      }
    };
  }

  if (DEFAULT_DATABASE_URL && DEFAULT_DATABASE_URL !== TARGET_DATABASE_URL) {
    const client = new Client({
      connectionString: DEFAULT_DATABASE_URL,
      ssl: getSslConfig(DEFAULT_DATABASE_URL)
    });

    await client.connect();

    return {
      type: "postgres",
      async all(sql, params = []) {
        const result = await client.query(sql, params);
        return result.rows;
      },
      async hasTable(tableName) {
        const result = await client.query(
          `
            SELECT EXISTS (
              SELECT 1
              FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = $1
            ) AS exists
          `,
          [tableName]
        );
        return Boolean(result.rows[0]?.exists);
      },
      async close() {
        await client.end();
      }
    };
  }

  if (!fs.existsSync(SQLITE_PATH)) {
    throw new Error(
      "No source database found. Set SOURCE_DATABASE_URL or provide a SQLite source file."
    );
  }

  const sqlite = new sqlite3.Database(SQLITE_PATH);

  return {
    type: "sqlite",
    all(sql, params = []) {
      return new Promise((resolve, reject) => {
        sqlite.all(sql, params, (error, rows) => {
          if (error) {
            reject(error);
            return;
          }

          resolve(rows);
        });
      });
    },
    async hasTable(tableName) {
      const rows = await this.all(
        `
          SELECT name
          FROM sqlite_master
          WHERE type = 'table' AND name = ?
        `,
        [tableName]
      );
      return rows.length > 0;
    },
    close() {
      return new Promise((resolve, reject) => {
        sqlite.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
  };
}

async function readTableRows(source, tableName) {
  if (!(await source.hasTable(tableName))) {
    return [];
  }

  return source.all(`SELECT * FROM ${tableName} ORDER BY id ASC`);
}

async function ensureTargetSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL DEFAULT '',
      supabase_auth_user_id UUID UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await client.query(`
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

  await client.query(`
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

  await client.query(`
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

  await client.query(`
    CREATE TABLE IF NOT EXISTS quiz_sections (
      id SERIAL PRIMARY KEY,
      module_item_id INTEGER NOT NULL REFERENCES module_items (id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      position INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS quiz_questions (
      id SERIAL PRIMARY KEY,
      section_id INTEGER NOT NULL REFERENCES quiz_sections (id) ON DELETE CASCADE,
      prompt TEXT NOT NULL,
      question_type TEXT NOT NULL CHECK (question_type IN ('single_choice', 'multiple_choice', 'true_false')),
      points INTEGER NOT NULL DEFAULT 100,
      time_limit INTEGER NOT NULL DEFAULT 20,
      show_leaderboard INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS quiz_choices (
      id SERIAL PRIMARY KEY,
      question_id INTEGER NOT NULL REFERENCES quiz_questions (id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      is_correct INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await client.query(`
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

  await client.query(`
    CREATE TABLE IF NOT EXISTS quiz_live_participants (
      id SERIAL PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES quiz_live_sessions (id) ON DELETE CASCADE,
      display_name TEXT NOT NULL,
      join_token TEXT NOT NULL UNIQUE,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await client.query(`
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

  await client.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_supabase_auth_user_id ON users(supabase_auth_user_id)"
  );
  await client.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_kuizzosh_items_quiz_code ON kuizzosh_items(quiz_code)"
  );
  await client.query(
    "CREATE INDEX IF NOT EXISTS idx_kuizzosh_items_user_id ON kuizzosh_items(user_id)"
  );
  await client.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_module_items_quiz_code ON module_items(quiz_code)"
  );
  await client.query(
    "CREATE INDEX IF NOT EXISTS idx_module_items_user_type ON module_items(user_id, module_type)"
  );
  await client.query(
    "CREATE INDEX IF NOT EXISTS idx_quiz_sections_module_item ON quiz_sections(module_item_id, position)"
  );
  await client.query(
    "CREATE INDEX IF NOT EXISTS idx_quiz_questions_section ON quiz_questions(section_id, position)"
  );
  await client.query(
    "CREATE INDEX IF NOT EXISTS idx_quiz_choices_question ON quiz_choices(question_id, position)"
  );
  await client.query(
    "CREATE INDEX IF NOT EXISTS idx_quiz_live_sessions_module ON quiz_live_sessions(module_item_id, created_at)"
  );
  await client.query(
    "CREATE INDEX IF NOT EXISTS idx_quiz_live_participants_session ON quiz_live_participants(session_id, joined_at)"
  );
  await client.query(
    "CREATE INDEX IF NOT EXISTS idx_quiz_live_answers_session_question ON quiz_live_answers(session_id, question_id)"
  );
  await client.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_quiz_live_answers_unique ON quiz_live_answers(session_id, participant_id, question_id)"
  );
}

async function resetSequence(client, tableName) {
  await client.query(
    `
      SELECT setval(
        pg_get_serial_sequence($1, 'id'),
        COALESCE((SELECT MAX(id) FROM ${tableName}), 1),
        COALESCE((SELECT MAX(id) FROM ${tableName}), 0) > 0
      )
    `,
    [tableName]
  );
}

async function findExistingAuthUserId(client, email) {
  const result = await client.query(
    `
      SELECT id::text AS id
      FROM auth.users
      WHERE LOWER(email) = LOWER($1)
      LIMIT 1
    `,
    [email]
  );

  return result.rows[0]?.id || null;
}

async function ensureAuthUser(client, supabaseAdmin, userRow) {
  const existingAuthUserId = await findExistingAuthUserId(client, userRow.email);

  if (existingAuthUserId) {
    return existingAuthUserId;
  }

  const passwordHash = String(userRow.password_hash || "").trim();

  if (!passwordHash) {
    throw new Error(
      `User ${userRow.email} is missing password_hash, so the password cannot be migrated automatically.`
    );
  }

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email: userRow.email,
    email_confirm: true,
    password_hash: passwordHash,
    user_metadata: {
      full_name: userRow.name,
      name: userRow.name,
      legacy_user_id: userRow.id
    }
  });

  if (error) {
    const authUserIdAfterFailure = await findExistingAuthUserId(client, userRow.email);

    if (authUserIdAfterFailure) {
      return authUserIdAfterFailure;
    }

    throw error;
  }

  if (!data.user?.id) {
    throw new Error(`Supabase Auth did not return a user id for ${userRow.email}.`);
  }

  return data.user.id;
}

async function main() {
  const source = await createSourceAdapter();
  const target = new Client({
    connectionString: TARGET_DATABASE_URL,
    ssl: getSslConfig(TARGET_DATABASE_URL)
  });

  try {
    const { createClient } = await loadSupabaseModule();
    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false
      }
    });

    await target.connect();
    await ensureTargetSchema(target);

    const users = await readTableRows(source, "users");
    const kuizzoshItems = await readTableRows(source, "kuizzosh_items");
    const moduleItems = await readTableRows(source, "module_items");
    const quizSettings = await readTableRows(source, "quiz_settings");
    const quizSections = await readTableRows(source, "quiz_sections");
    const quizQuestions = await readTableRows(source, "quiz_questions");
    const quizChoices = await readTableRows(source, "quiz_choices");
    const quizLiveSessions = await readTableRows(source, "quiz_live_sessions");
    const quizLiveParticipants = await readTableRows(source, "quiz_live_participants");
    const quizLiveAnswers = await readTableRows(source, "quiz_live_answers");

    const authUserIdsByLegacyId = new Map();

    for (const userRow of users) {
      const authUserId = await ensureAuthUser(target, supabaseAdmin, userRow);
      authUserIdsByLegacyId.set(userRow.id, authUserId);
    }

    await target.query("BEGIN");

    try {
      await target.query(`
        TRUNCATE TABLE
          quiz_live_answers,
          quiz_live_participants,
          quiz_live_sessions,
          quiz_choices,
          quiz_questions,
          quiz_sections,
          quiz_settings,
          module_items,
          kuizzosh_items,
          users
        RESTART IDENTITY CASCADE
      `);

      for (const row of users) {
        await target.query(
          `
            INSERT INTO users (id, name, email, password_hash, supabase_auth_user_id, created_at)
            VALUES ($1, $2, $3, $4, $5, $6)
          `,
          [
            row.id,
            row.name,
            row.email,
            row.password_hash || "",
            authUserIdsByLegacyId.get(row.id) || null,
            row.created_at
          ]
        );
      }

      for (const row of kuizzoshItems) {
        await target.query(
          `
            INSERT INTO kuizzosh_items (
              id, user_id, title, start_date, end_date, visibility, quiz_code, created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          `,
          [
            row.id,
            row.user_id,
            row.title,
            row.start_date,
            row.end_date,
            row.visibility,
            row.quiz_code || null,
            row.created_at
          ]
        );
      }

      for (const row of moduleItems) {
        await target.query(
          `
            INSERT INTO module_items (
              id, user_id, module_type, title, start_date, end_date, visibility, quiz_code, created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          `,
          [
            row.id,
            row.user_id,
            row.module_type,
            row.title,
            row.start_date || null,
            row.end_date || null,
            row.visibility || null,
            row.quiz_code || null,
            row.created_at
          ]
        );
      }

      for (const row of quizSettings) {
        await target.query(
          `
            INSERT INTO quiz_settings (
              id,
              module_item_id,
              leaderboard_enabled,
              speed_bonus_enabled,
              show_correct_answer,
              randomize_questions,
              randomize_choices,
              created_at,
              updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          `,
          [
            row.id,
            row.module_item_id,
            row.leaderboard_enabled,
            row.speed_bonus_enabled,
            row.show_correct_answer,
            row.randomize_questions,
            row.randomize_choices,
            row.created_at,
            row.updated_at
          ]
        );
      }

      for (const row of quizSections) {
        await target.query(
          `
            INSERT INTO quiz_sections (id, module_item_id, title, position, created_at)
            VALUES ($1, $2, $3, $4, $5)
          `,
          [row.id, row.module_item_id, row.title, row.position, row.created_at]
        );
      }

      for (const row of quizQuestions) {
        await target.query(
          `
            INSERT INTO quiz_questions (
              id,
              section_id,
              prompt,
              question_type,
              points,
              time_limit,
              show_leaderboard,
              position,
              created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          `,
          [
            row.id,
            row.section_id,
            row.prompt,
            row.question_type,
            row.points,
            row.time_limit,
            row.show_leaderboard || 0,
            row.position,
            row.created_at
          ]
        );
      }

      for (const row of quizChoices) {
        await target.query(
          `
            INSERT INTO quiz_choices (id, question_id, label, is_correct, position, created_at)
            VALUES ($1, $2, $3, $4, $5, $6)
          `,
          [row.id, row.question_id, row.label, row.is_correct, row.position, row.created_at]
        );
      }

      for (const row of quizLiveSessions) {
        await target.query(
          `
            INSERT INTO quiz_live_sessions (
              id,
              module_item_id,
              host_user_id,
              status,
              phase_mode,
              current_question_index,
              question_started_at,
              phase_ends_at,
              created_at,
              updated_at,
              started_at,
              ended_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          `,
          [
            row.id,
            row.module_item_id,
            row.host_user_id,
            row.status,
            row.phase_mode || null,
            row.current_question_index || 0,
            row.question_started_at || null,
            row.phase_ends_at || null,
            row.created_at,
            row.updated_at,
            row.started_at || null,
            row.ended_at || null
          ]
        );
      }

      for (const row of quizLiveParticipants) {
        await target.query(
          `
            INSERT INTO quiz_live_participants (
              id,
              session_id,
              display_name,
              join_token,
              joined_at,
              last_seen_at
            )
            VALUES ($1, $2, $3, $4, $5, $6)
          `,
          [
            row.id,
            row.session_id,
            row.display_name,
            row.join_token,
            row.joined_at,
            row.last_seen_at
          ]
        );
      }

      for (const row of quizLiveAnswers) {
        await target.query(
          `
            INSERT INTO quiz_live_answers (
              id,
              session_id,
              participant_id,
              question_id,
              selected_choice_ids,
              is_correct,
              response_time_ms,
              submitted_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          `,
          [
            row.id,
            row.session_id,
            row.participant_id,
            row.question_id,
            row.selected_choice_ids,
            row.is_correct,
            row.response_time_ms || 0,
            row.submitted_at
          ]
        );
      }

      await resetSequence(target, "users");
      await resetSequence(target, "kuizzosh_items");
      await resetSequence(target, "module_items");
      await resetSequence(target, "quiz_settings");
      await resetSequence(target, "quiz_sections");
      await resetSequence(target, "quiz_questions");
      await resetSequence(target, "quiz_choices");
      await resetSequence(target, "quiz_live_sessions");
      await resetSequence(target, "quiz_live_participants");
      await resetSequence(target, "quiz_live_answers");

      await target.query("COMMIT");

      console.log("Migration to Supabase completed.");
      console.log(
        JSON.stringify(
          {
            sourceType: source.type,
            users: users.length,
            kuizzoshItems: kuizzoshItems.length,
            moduleItems: moduleItems.length,
            quizSettings: quizSettings.length,
            quizSections: quizSections.length,
            quizQuestions: quizQuestions.length,
            quizChoices: quizChoices.length,
            quizLiveSessions: quizLiveSessions.length,
            quizLiveParticipants: quizLiveParticipants.length,
            quizLiveAnswers: quizLiveAnswers.length
          },
          null,
          2
        )
      );
    } catch (error) {
      await target.query("ROLLBACK");
      throw error;
    }
  } finally {
    await target.end().catch(() => {});
    await source.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error("Supabase migration failed:", error);
  process.exit(1);
});
