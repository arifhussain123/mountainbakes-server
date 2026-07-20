# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository shape

This is **one of two sibling repositories**, not a monorepo and not a two-folder repo.
Each is a standalone project with its own git remote, its own `package.json`, and its own
deploy; neither imports files outside its own tree.

```
~/Documents/GitHub/mountainbakes/
├── mountainbakes-server/     ← this repo. Express REST API. Package `mountain-bakes-server`.
└── mountainbakes-frontend/   ← Next.js 16 (App Router, React 19) PWA. Package `@mb/web`.
```

- This repo → `github.com/arifhussain123/mountainbakes-server`
- Frontend → `github.com/arifhussain123/mountainbakes-frontend`

Paths in this file are **relative to this repo's root** (`src/routes/…`, `server.ts`).
Frontend paths are written `../mountainbakes-frontend/src/…` — reaching them means
leaving this repo, and edits there are a separate commit in a separate remote.

Both pin Node `24.x` and `pnpm@11.12.0` (Corepack was unbundled at Node 25 — do not
loosen the engine range).

## Common commands

Both repos use the same script names, each run from **its own** repo root:

```bash
pnpm install
pnpm dev          # this repo → :3001 (tsx watch server.ts) · frontend → :3000 (next dev)
pnpm build        # this repo → tsc --noEmit (type-check ONLY, emits nothing) · frontend → next build
pnpm typecheck    # tsc --noEmit
pnpm lint         # this repo → eslint src --ext .ts · frontend → eslint (next config)
```

This repo only:

```bash
pnpm start                            # tsx server.ts (production entry; no compile step — tsx runs TS directly)
pnpm purge:price-history              # dry run — counts, deletes nothing
pnpm purge:price-history -- --confirm # permanently delete price history
node scripts/seed.js                  # seed baseline data + super admin
```

**There are no automated tests** — no test runner is installed in either project. Do not
invent a `pnpm test`. The server "build" is a type-check, not a compile; the app is run
directly from TypeScript via `tsx`.

Running the full stack means two terminals in two different repo checkouts (this repo
first, then `../mountainbakes-frontend`) — there is no single command that starts both,
and no workspace root that could provide one.

## Auth & data layer — Supabase

Everything runs on Supabase: Postgres for data, Supabase Auth for sessions, Supabase
Storage for files, Supabase Realtime for live updates. There is no other backend.

- **Auth = Supabase.** The browser holds a Supabase session; the access-token JWT is
  sent as `Authorization: Bearer <jwt>` to the API. Role / branch live in the user's
  Supabase `app_metadata` (server-controlled claims embedded in the JWT). Server
  verifies via `supabaseAdmin.auth.getUser(token)` (`src/config/supabase.ts`,
  `src/middleware/auth.ts`); frontend via `@/lib/supabase/client` (`AuthProvider`).
  `SUPABASE_SERVICE_ROLE_KEY` must be the **secret** key, not the anon/publishable one.
- **Data = Supabase / Postgres.** The schema is in `supabase/migrations/*.sql`. The
  server talks to it with the service-role client (`supabaseAdmin`), which **bypasses
  RLS** — so authorization is enforced in application code (`middleware/requireRole`
  plus per-handler branch/role scoping), not by RLS. Every route is live and wired in
  `src/routes/index.ts`; keep the `/api/products/price` registration before
  `/api/products`, since prefix order decides the match.

  Rows are **snake_case** in Postgres and **camelCase** in the API contract — convert
  at the boundary with `rowToApi` / `apiToRow` (`src/utils/case.ts`). Anything that
  must be atomic across multiple statements (POS sale, stock movements, production-order
  review, the daily-closing lock) lives in a **Postgres function** called via
  `supabaseAdmin.rpc(...)`: PostgREST gives each call its own transaction, so a read
  and its dependent write cannot be made atomic from the app layer.
- **Push-to-device is not implemented.** In-app notifications work fully (`notify()`
  writes a row to the `notifications` table); web push delivery is a deliberate no-op
  pending VAPID Web Push over the `push_subscriptions` table — see
  `services/push.service.ts`.
- **Realtime = Supabase Realtime.** The frontend subscribes to Postgres changes
  (notifications, chats, price/production updates) through `@/lib/supabase/client`;
  there is no separate realtime service.

Roles: `super_admin`, `branch_manager`, `production_user`.

## Two separate session mechanisms (do not conflate)

1. **`mb_session` cookie** — a first-party, base64-JSON cookie (`{ role, uid,
   mustChangePassword }`) set by the frontend's **own** Next route handlers
   `src/app/api/login|logout/route.ts`. The frontend's own `middleware.ts` reads it to guard routes
   and do role-based redirects (`getRoleHome`), plus the forced-password-change gate. This
   cookie never leaves the web origin.
2. **Supabase JWT** — sent as the Bearer token to the Express API for actual data access.

`/api/login` and `/api/logout` are the web app's own routes; every **other** `/api/*` path
is proxied/called against the Express API. `middleware.ts` exempts all of `/api` so
unauthenticated API calls return JSON errors instead of an HTML `/login` redirect.

## Server request pipeline

Each route module (`src/routes/*.routes.ts`, wired in `src/routes/index.ts`) applies
`router.use(authenticate)`, then per-endpoint `requireRole(...)` and `validate(schema)`
(Zod, from `@mb/shared`). Because the service-role client **bypasses RLS**,
authorization is enforced in application code: e.g. branch managers are scoped to their own
`branchId` and production users to active order statuses inside the handlers, not by RLS.
Business logic lives in `services/`; errors bubble to `middleware/errorHandler.ts`.

## Shared schemas are mirrored, not shared

`src/shared/` here and `../mountainbakes-frontend/src/shared/` are **byte-identical copies**
(Zod schemas + TS types + `utils/timezone.ts`, `utils/stock.ts`), each exposed via the
`@mb/shared` tsconfig path alias → `./src/shared/index.ts`. There is no shared package, and
because they live in **separate repos**, nothing mechanically enforces the mirror — not even
a failing build. **When you edit a schema or type, make the identical change in both trees**
(two commits, two remotes), or the client and API drift apart silently. To check:

```bash
diff -r src/shared ../mountainbakes-frontend/src/shared   # must print nothing
```

## Business-day model

The bakery runs 8:00 AM → 2:00 AM (next day), Asia/Karachi (fixed UTC+5, no DST). All of
this lives in `shared/utils/timezone.ts`:

- The business day **rolls over at 2:00 AM** — `BUSINESS_DAY_START_MINUTES = 120` is a
  hardcoded constant **on purpose** (changing it would reclassify which day the
  midnight–2 AM records belong to). Records from 00:00–01:59 belong to the *previous*
  business date. Use `businessDateStr()` / `businessDayBounds()` / `businessRange()` for
  anything day-scoped — do not reach for raw calendar dates.
- The order-entry **window** (`isWithinOrderWindow`) is settings-driven and may wrap past
  midnight; only the rollover boundary is fixed.
- **Stock and sales are derived, not stored per-transaction.** Balances persist and reports
  compute on read. The 2 AM daily closing's real job is to snapshot/archive + lock the day
  (`services/daily-closing.service.ts`), not to move numbers.
- **Schedulers are intentionally OFF right now.** `server.ts` has the two 2 AM Karachi
  node-cron jobs (daily closing + future-dated price activation) commented out on both their
  import and their call. The code is ported and ready — the daily-closing once-per-day lock
  is claimed atomically via `claim_business_day_closure` (migration `…000017`) — but the jobs
  stay disabled until their SQL functions are applied to the database and someone turns them
  back on. Re-enable each import together with its call. When on: the jobs only fire while the
  dyno is awake, and their idempotency locks assume **one dyno** (`web=1`) — keep it
  single-instance.

## Frontend data fetching

All paths in this section are inside `../mountainbakes-frontend/`.

TanStack Query throughout. **Every query key comes from `src/lib/queryKeys.ts` (`qk`)** —
never hand-roll a key, or invalidations silently miss it. `AuthProvider`, `QueryProvider`,
`RealtimeProvider`, `ThemeProvider` are mounted once at the root; consume auth via
`useAuth()` and realtime via `useNotifications()` / `useChats()` rather than opening your
own listeners. The API client is `src/lib/api/client.ts` (`apiCall`), which attaches the
Bearer token and normalizes errors into `ApiError`.

## Deploy gotchas that bite

The two repos deploy **separately** — there is no combined pipeline, so a change spanning
both ships as two deploys and they can be live at different versions. Frontend-side
gotchas below are in `../mountainbakes-frontend/`.

- **`NEXT_PUBLIC_*` is inlined at build time.** Setting `NEXT_PUBLIC_API_URL` (or the
  Supabase URL / anon key) on a running host does nothing — it requires a rebuild. This is
  the most common deploy failure; symptom is pages that render but every table is empty.
- The API's CORS allowlist is `CORS_ORIGINS` (comma-separated) in `src/app.ts`; it
  must match the web origin exactly (scheme + host, no trailing slash). localhost/127.0.0.1
  are always allowed. A mismatch fails at the browser with no server-side error.
- **Apply pending SQL migrations** (`supabase db push`) before or with any deploy that
  depends on new schema — the dyno does not run migrations at boot.

## Next.js version caveat

`../mountainbakes-frontend/AGENTS.md` (imported by that repo's `CLAUDE.md`) warns that this
Next.js (16.2.x) has breaking changes vs older training data — check
`node_modules/next/dist/docs/` **inside the frontend repo** before writing framework-level code.
