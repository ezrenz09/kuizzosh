const fs = require("fs");
const path = require("path");

try {
  require("dotenv").config();
} catch (error) {
  // dotenv is optional
}

const sqlite3 = require("sqlite3").verbose();
const { Client } = require("pg");

const SQLITE_PATH = process.env.SQLITE_PATH || path.join(__dirname, "..", "data", "kuizzosh.sqlite");
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();

if (!DATABASE_URL) {
  console.error("DATABASE_URL is required for PostgreSQL migration.");
  process.exit(1);
}

if (!fs.existsSync(SQLITE_PATH)) {
  console.error(`SQLite source file not found: ${SQLITE_PATH}`);
  process.exit(1);
}

const sqlite = new sqlite3.Database(SQLITE_PATH);

function sqliteAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    sqlite.all(sql, params, (error, rows) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(rows);
    });
  });
}

async function ensurePostgresSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
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

async function main() {
  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes("localhost")
      ? false
      : {
          rejectUnauthorized: false
        }
  });

  await client.connect();
  await ensurePostgresSchema(client);

  const users = await sqliteAll("SELECT * FROM users ORDER BY id ASC");
  const kuizzoshItems = await sqliteAll("SELECT * FROM kuizzosh_items ORDER BY id ASC");
  const moduleItems = await sqliteAll("SELECT * FROM module_items ORDER BY id ASC");
  const quizSettings = await sqliteAll("SELECT * FROM quiz_settings ORDER BY id ASC");
  const quizSections = await sqliteAll("SELECT * FROM quiz_sections ORDER BY id ASC");
  const quizQuestions = await sqliteAll("SELECT * FROM quiz_questions ORDER BY id ASC");
  const quizChoices = await sqliteAll("SELECT * FROM quiz_choices ORDER BY id ASC");

  await client.query("BEGIN");

  try {
    await client.query(`
      TRUNCATE TABLE
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
      await client.query(
        `
          INSERT INTO users (id, name, email, password_hash, created_at)
          VALUES ($1, $2, $3, $4, $5)
        `,
        [row.id, row.name, row.email, row.password_hash, row.created_at]
      );
    }

    for (const row of kuizzoshItems) {
      await client.query(
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
          row.quiz_code,
          row.created_at
        ]
      );
    }

    for (const row of moduleItems) {
      await client.query(
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
          row.start_date,
          row.end_date,
          row.visibility,
          row.quiz_code,
          row.created_at
        ]
      );
    }

    for (const row of quizSettings) {
      await client.query(
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
      await client.query(
        `
          INSERT INTO quiz_sections (id, module_item_id, title, position, created_at)
          VALUES ($1, $2, $3, $4, $5)
        `,
        [row.id, row.module_item_id, row.title, row.position, row.created_at]
      );
    }

    for (const row of quizQuestions) {
      await client.query(
        `
          INSERT INTO quiz_questions (
            id, section_id, prompt, question_type, points, time_limit, position, created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
        [
          row.id,
          row.section_id,
          row.prompt,
          row.question_type,
          row.points,
          row.time_limit,
          row.position,
          row.created_at
        ]
      );
    }

    for (const row of quizChoices) {
      await client.query(
        `
          INSERT INTO quiz_choices (id, question_id, label, is_correct, position, created_at)
          VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [row.id, row.question_id, row.label, row.is_correct, row.position, row.created_at]
      );
    }

    await resetSequence(client, "users");
    await resetSequence(client, "kuizzosh_items");
    await resetSequence(client, "module_items");
    await resetSequence(client, "quiz_settings");
    await resetSequence(client, "quiz_sections");
    await resetSequence(client, "quiz_questions");
    await resetSequence(client, "quiz_choices");

    await client.query("COMMIT");

    console.log("SQLite to PostgreSQL migration completed.");
    console.log(
      JSON.stringify(
        {
          users: users.length,
          kuizzoshItems: kuizzoshItems.length,
          moduleItems: moduleItems.length,
          quizSettings: quizSettings.length,
          quizSections: quizSections.length,
          quizQuestions: quizQuestions.length,
          quizChoices: quizChoices.length
        },
        null,
        2
      )
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
    sqlite.close();
  }
}

main().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
