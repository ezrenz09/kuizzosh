# Kuizzosh

Kuizzosh is a quiz, poll, and ranking web app built with Express, EJS, PostgreSQL, and Supabase Auth.

## Install

```bash
npm install
```

## Environment

Create `.env` from `.env.example`.

For a fresh Supabase setup, configure:

```env
DATABASE_URL=postgresql://postgres:URL_ENCODED_PASSWORD@db.PROJECT_REF.supabase.co:5432/postgres
SUPABASE_DATABASE_URL=postgresql://postgres:URL_ENCODED_PASSWORD@db.PROJECT_REF.supabase.co:5432/postgres
SUPABASE_URL=https://PROJECT_REF.supabase.co
SUPABASE_ANON_KEY=your-supabase-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key
SESSION_SECRET=replace-with-a-long-random-secret
PORT=3000
```

Important:

- If your database password contains characters like `:`, `@`, `/`, `?`, or `#`, URL-encode it in the connection string.
- Keep `SUPABASE_SERVICE_ROLE_KEY` server-side only.
- `DATABASE_URL` should point to your Supabase Postgres database for normal app runtime.

## Run

Development:

```bash
npm run dev
```

Production-style:

```bash
npm start
```

The server listens on:

```text
http://localhost:3000
```

## Fresh Start

This repo is now set up to start fresh on Supabase:

- new signups are created in Supabase Auth
- the app keeps its own local `users` table for ownership and app data
- on first signup or login, the app links the local user record to the Supabase auth user

To start fresh, just run the app and create a new account from the register page.

## Deploy To Vercel

This app can be deployed to Vercel, but production must use PostgreSQL.

Do not deploy with local SQLite on Vercel because the local filesystem is not suitable for persistent app data or sessions.

Required environment variables on Vercel:

```env
DATABASE_URL=postgresql://postgres:URL_ENCODED_PASSWORD@db.PROJECT_REF.supabase.co:5432/postgres
SUPABASE_URL=https://PROJECT_REF.supabase.co
SUPABASE_ANON_KEY=your-supabase-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key
SESSION_SECRET=replace-with-a-long-random-secret
```

Notes:

- `DATABASE_URL` is the runtime database connection used by the app.
- `SUPABASE_DATABASE_URL` is optional for this repo and is not used by the app runtime.
- `PORT` is not needed on Vercel.
- If your database password contains special characters such as `:`, `@`, `/`, `?`, `#`, or `%`, URL-encode it inside `DATABASE_URL`.

Deploy flow:

1. Push this repo to GitHub.
2. Import the repo into Vercel.
3. Add the required environment variables in Vercel Project Settings.
4. Redeploy.
