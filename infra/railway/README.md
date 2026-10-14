# Moving Mountain Bakes off Supabase

The code in this repository no longer uses Supabase for anything: the API signs
people in itself, talks to Postgres directly and keeps files in S3. What is left
is to put that code, and the data, into service. Both happen in one maintenance
window, described here.

## What runs where, afterwards

| Was on Supabase | Afterwards | Notes |
|---|---|---|
| Postgres 17 | Railway Postgres 18 | The application's two schemas (`public`, `app`), copied and verified table by table |
| Auth (GoTrue) | the API (`/api/auth/*`) | Accounts are rows in `users`; password hashes are in `user_credentials` (carried over by migration 149) |
| REST API (PostgREST) | the API's own query layer (`src/db`) on Prisma's connection | |
| Row-level security | none | The API is the only client and authorises every request itself |
| Storage | S3 | `pnpm files:copy` |
| Realtime | none | The web app polls `GET /api/notifications` |

```
web / mobile ──► API (Heroku) ──► Postgres (Railway), as role mb_api
                      └─ S3 (files, backups)
```

## Why it is one window and not several

The backend, the web app and the Android app change together:

- The new API accepts only its own sign-in tokens. The web and Android builds
  in use today hold Supabase tokens, so from the moment the new API is live
  they stop working until they are replaced.
- The new web and Android builds sign in through `/api/auth/login`, which the
  API in service today does not have.

So the API, the web app and the data go over in the same hour, and phones need
the new build before they work again. There is no period in which old and new
run side by side.

## What was rehearsed, and what was not

Rehearsed, against a local Postgres 18 and against a copy on Railway:

- `railway:migrate` copies the database (about 70 seconds from Supabase, three
  and a half minutes into Railway from a backup archive). `railway:verify` then
  finds every table, column, constraint, index, sequence, function, trigger and
  enum identical, every table's contents hashing the same, every numeric column
  summing to the same total, and all 18 access checks passing.
- The API, started with no Supabase setting in its environment and connected as
  `mb_api` to a copy of the Railway data: sign-in as an administrator, a branch
  manager, a production user and a finance user; 24 screens' worth of reads;
  token refresh; sign-out; photo URLs signed for S3.
- A POS sale through the API as `mb_api` (done before the Supabase fallbacks
  were taken out of the code; the query layer it ran on has not changed since):
  the order is written, branch stock drops, the stock ledger gains its row; the
  same request re-sent with the same Idempotency-Key makes no second sale; a
  sale of more than is in stock is refused and writes nothing.
- The backup's own `pg_dump` commands, run against Railway.
- A database built from nothing by `bootstrap.sql`, the Prisma baseline and
  `post-restore.sql` has the same structure as the copy.

NOT rehearsed:

- The new API on Heroku, the new web build on Firebase, or the new Android
  build on a phone, against Railway. Step 3 of "Before the night" is that.
- A return, a production review, a ledger posting or payroll on the copy.
- `pnpm files:copy` copying real files (it has only been read through).
- A reset email actually arriving.
- Speed. Every query travels Heroku → Railway.

## One thing that will look different afterwards

**Some lists may be ordered differently** where rows tie on their sort key —
events on the same date, returns on the same day. The rows are the same;
Postgres never promised an order among ties and a copied table stores them in a
different physical order. If one of these matters, give that query a second
sort column.

Separately, a database's **collation** decides how names sort. Supabase uses
ICU `en-US`. Railway's default database, `railway`, does not, and a database's
collation cannot be changed later. To sort exactly as today, put a different
database name at the end of `RAILWAY_DB_URL` (e.g. `…/mountainbakes`) and run
the first copy with `--create-database`, which creates it with Supabase's
collation. A copy into a database that sorts differently is refused unless
`--accept-collation` says the difference is understood.

## Settings

`backend/.env` on the machine the commands run from (all described in
`.env.example`):

| Variable | Value |
|---|---|
| `RAILWAY_DB_URL` | Railway's **public** connection string, user `postgres`. Deliberately not `DATABASE_URL`: the copy WIPES its target |
| `SUPABASE_DB_URL` | Supabase's session pooler (port 5432) — what the copy reads |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | what `files:copy` downloads with |
| `DATABASE_URL` | the Railway database (it is where `files:copy` reads rows and rewrites the logo URL) |
| `FILES_S3_BUCKET`, `FILES_S3_PREFIX`, `PUBLIC_API_URL`, `AWS_*` | where files go |

Heroku config vars for the new API. **With either of the first two missing the
server refuses to start and says which.** With `FILES_S3_BUCKET` or
`PUBLIC_API_URL` missing it starts and logs a warning, and screens that show
photos fail (see `server.ts`):

| Variable | Value |
|---|---|
| `DATABASE_URL` | the `mb_api` URL from `infra/railway/.secrets.env` |
| `JWT_SECRET` | 32+ random characters, e.g. `openssl rand -base64 48` |
| `FILES_S3_BUCKET` (+ `FILES_S3_PREFIX`) | the bucket files were copied to |
| `PUBLIC_API_URL` | the API's own public origin, no trailing slash |
| `BACKUP_DB_URL` | `RAILWAY_DB_URL` — the administrator URL, which is what backups dump |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | for password-reset email. Without them a reset link cannot be sent; temporary passwords still work |
| `PG_BIN_DIR` | `/app/.apt/usr/lib/postgresql/18/bin` (the `Aptfile` installs client 18) |

No longer read by the API, and removable from Heroku once the move has held:
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`, and any
`SUPABASE_*`, `AUTH_ACCEPT_SUPABASE`, `AUTH_GOTRUE_MIRROR`, `DB_BACKEND`,
`DB_SHADOW_MODULES`, `DB_SQL_MODULES`, `FILE_STORAGE_DRIVER`.

## Before the night — none of this touches the live system

All commands run from `backend/`.

1. **Copy the files**, days ahead if you like. Read the two warnings next to
   `FILES_S3_BUCKET` in `.env.example` (lifecycle rules, IAM policy) first.

       pnpm files:copy             # what would be copied
       pnpm files:copy --confirm   # copy

   It reads Supabase Storage and writes S3; nothing is deleted on either side,
   and it can be run again — it copies only what is new.
2. **Copy the data** and check it. Repeat as often as you like.

       pnpm railway:migrate --create-database    # first time, into a new database
       pnpm railway:migrate --reset-target       # every time after
       pnpm railway:verify
       pnpm railway:role                         # writes infra/railway/.secrets.env

   `railway:migrate` only ever reads Supabase. `railway:verify` exits non-zero
   if anything differs; between a rehearsal copy and the live database, the
   tables written to since will differ, and it says so. To load a backup
   archive instead of reading Supabase (the main `.dump` from S3):
   `pnpm railway:migrate --reset-target --from-dump <file>`.
3. **Use the new system against the copy.** Run the API locally as its own role:

       DATABASE_URL=<the mb_api URL from .secrets.env> pnpm dev

   and the web app locally against it (`frontend/`, with its API URL pointed at
   `http://localhost:3001`). Sign in with a real account. Ring up a sale, a
   return, a production review, an expense; open a photo; send a reset email.
   This is the step that covers what the list above says was not rehearsed.
4. **Have the builds ready**: the Android APK built from `mobile/`, and the
   people who need it told they will have to install it.

## The night

Pick a time the shops are closed. Budget two hours.

1. **Stop writes.** `heroku maintenance:on`. From here Supabase does not change,
   which is what makes the next steps exact.
2. `pnpm railway:migrate --reset-target`

   It refuses to start if any account's password in `user_credentials` differs
   from Supabase Auth's — a password was changed since migration 149 carried
   them over. Run the "Carry the existing passwords over" block at the end of
   `db/history/migrations/20261009000149_custom_auth.sql` in the Supabase SQL
   editor and try again.
3. `pnpm railway:verify` — must end `RESULT: PASS — the target holds exactly the
   same data`. (If the copy was made with `--accept-collation`, pass it here
   too; the difference is then noted instead of failed.) If it does not pass,
   stop: `heroku maintenance:off` and nothing has changed.
4. `pnpm railway:role`, then copy `DATABASE_URL` from `infra/railway/.secrets.env`.
5. `pnpm files:copy --confirm --rewrite-logo-url` — picks up files added since
   the first copy and points the logo at this API. `DATABASE_URL` in
   `backend/.env` must be the Railway database for this step.
6. **Heroku config vars**, from the table above.
7. **Deploy the API.** Watch the log: `[server] cannot start:` names a missing
   `DATABASE_URL` or `JWT_SECRET`, and `[server] file storage is not
   configured` names a missing `FILES_S3_BUCKET` or `PUBLIC_API_URL`.
8. **Deploy the web app** (`pnpm run deploy` in `frontend/`) and hand out the
   Android build.
9. `heroku maintenance:off`. Then check, in this order:
   - `GET /health` reports `database: connected`;
   - sign in on the web as an administrator, a branch manager and a finance
     user;
   - the logo shows on the login page and a production order's photo opens;
   - make one real sale and find it in the Railway database.
10. `pnpm railway:migrate --mark-live` — from now on the migrate script refuses
    to wipe this database.
11. Migration history, once:

        pnpm db:baseline
        DIRECT_DATABASE_URL="$RAILWAY_DB_URL" pnpm exec prisma migrate resolve --applied 0_baseline
        DIRECT_DATABASE_URL="$RAILWAY_DB_URL" pnpm exec prisma migrate deploy

    The last line applies `20261010000001_api_sessions_only`, which takes the
    last traces of Supabase Auth out of three database functions. Commit
    `prisma/migrations/`.
12. `pnpm backup:manual` (or wait for the nightly) and confirm it verifies.

### Going back

Supabase is exactly as it was at step 1, and the old API, web build and Android
build all still work against it. Until real work has been done on Railway:

- `heroku rollback` to the release before step 6 — a Heroku release carries its
  config vars, so the old code and the old settings come back together;
- roll the web app back in Firebase Hosting;
- phones that installed the new build need the old one back; phones that did
  not are already fine.

After real work has been done on Railway, going back loses that work, and any
password changed since is not known to Supabase. Decide at step 9, not the next
morning.

## Afterwards

- Leave the Supabase project alone for at least two weeks, then pause it before
  deleting it. It is the only rollback there is.
- In `backend/.env`, `DIRECT_DATABASE_URL` becomes the Railway administrator URL
  (it is what the Prisma CLI and `pnpm db:catalog` connect with). Run
  `pnpm prisma:pull` and `pnpm db:catalog` once so the generated files describe
  the database actually in service.
- **New migrations** are hand-written SQL in
  `prisma/migrations/<yyyymmddhhmmss>_<name>/migration.sql`, applied with
  `pnpm exec prisma migrate deploy`, followed by `pnpm prisma:pull` and
  `pnpm db:catalog`. Never `prisma migrate dev` or `prisma db push` — they would
  remove the functions and triggers (see `prisma.config.ts`). A migration that
  grants to `service_role` reaches the API, which is a member of it; one that
  grants to `anon` or `authenticated` applies and opens nothing.
- After any `--reset-target` the `mb_api` role and its password survive.
  `pnpm railway:role` re-applies the one on file if in doubt.
- When the Supabase project is closed, this folder's copy tools
  (`migrate-data.ts`, `verify-migration.ts`, `copy-files.ts`) and the
  "Moving off Supabase" block of `.env.example` have nothing left to read and
  can be deleted. `bootstrap.sql`, `post-restore.sql` and `api-role.ts` stay:
  they are how a database is built from nothing and how a backup is restored.

## The files here

| File | What it is |
|---|---|
| `migrate-data.ts` | `pnpm railway:migrate` — dump Supabase (or take a backup archive), restore into Railway |
| `bootstrap.sql` | Roles, schemas, extensions, time zone. Run before the restore |
| `post-restore.sql` | Grants, and the removal of what only Supabase needed. The whole access model |
| `verify-migration.ts` | `pnpm railway:verify` — source against target |
| `api-role.ts` | `pnpm railway:role` — the API's database login |
| `copy-files.ts` | `pnpm files:copy` — Supabase Storage to S3 |
| `db-baseline.ts` | `pnpm db:baseline` — the copied schema as the first Prisma migration |
| `.secrets.env` | Generated. Git-ignored. Never commit |
