# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository shape

This repo is **two independent standalone projects**, not a monorepo. There is no root
`package.json`, workspace, or shared build. Each folder installs, builds, lints, and
deploys on its own, and neither imports files above its own directory.

- `frontend/` — Next.js 16 (App Router, React 19) PWA web client. Package `@mb/web`.
- `server/` — Express REST API. Package `mountain-bakes-server`.

Run every command **from inside** `frontend/` or `server/`, never from the repo root.
Both pin Node `24.x` and `pnpm@11.12.0` (Corepack was unbundled at Node 25 — do not
loosen the engine range).

## Common commands

Both projects use the same script names:

```bash
pnpm install
pnpm dev          # frontend → :3000 (next dev) · server → :3001 (tsx watch server.ts)
pnpm build        # frontend → next build · server → tsc --noEmit (type-check ONLY, emits nothing)
pnpm typecheck    # tsc --noEmit
pnpm lint         # frontend → eslint (next config) · server → eslint src --ext .ts
```

Server-only:

```bash
pnpm start                            # tsx server.ts (production entry; no compile step — tsx runs TS directly)
pnpm purge:price-history              # dry run — counts, deletes nothing
pnpm purge:price-history -- --confirm # permanently delete price history
node scripts/seed.js                  # seed baseline data + super admin
node scripts/enable-email-auth.mjs    # toggle Supabase email/password sign-in (also disable-email-auth.mjs)
```

**There are no automated tests** — no test runner is installed in either project. Do not
invent a `pnpm test`. The server "build" is a type-check, not a compile; the app is run
directly from TypeScript via `tsx`.

Running the full stack means two terminals (`server` then `frontend`) — there is no
single command that starts both, by design.

## Auth & data layer — Firebase→Supabase migration in progress

The docs (both READMEs, `DEPLOY.md`, comments in `lib/api/client.ts`) predate an in-flight
migration and are partly stale. **Treat the code as the source of truth**, and expect a
hybrid Supabase + Firebase setup:

- **Auth = Supabase.** (Phase 1, done.) The browser holds a Supabase session; the
  access-token JWT is sent as `Authorization: Bearer <jwt>` to the API. Role / branch live
  in the user's Supabase `app_metadata` (server-controlled claims embedded in the JWT).
  Server verifies via `supabaseAdmin.auth.getUser(token)` (`server/src/config/supabase.ts`,
  `middleware/auth.ts`); frontend via `@/lib/supabase/client` (`AuthProvider`).
  `SUPABASE_SERVICE_ROLE_KEY` must be the **secret** key, not the anon/publishable one.
- **Data / Storage / Messaging = Firebase (still).** The API owns every privileged write
  through the Admin SDK (`server/src/config/firebase.ts` → `adminDb`, `adminStorage`).
  Firebase Auth is deprecated but Admin is retained for Firestore + Storage + FCM until
  later phases.
- **Client-side Firestore realtime is currently BROKEN.** `RealtimeProvider`
  (`frontend/src/providers/RealtimeProvider.tsx`) still opens Firestore `onSnapshot`
  streams (notifications, chats) that require a Firebase Auth session the app no longer
  creates. Chat, notification badges, and live queues won't update until the realtime
  phase lands. Don't "fix" it by re-adding Firebase Auth.

Roles: `super_admin`, `branch_manager`, `production_user`.

## Two separate session mechanisms (do not conflate)

1. **`mb_session` cookie** — a first-party, base64-JSON cookie (`{ role, uid,
   mustChangePassword }`) set by the frontend's **own** Next route handlers
   `src/app/api/login|logout/route.ts`. `frontend/middleware.ts` reads it to guard routes
   and do role-based redirects (`getRoleHome`), plus the forced-password-change gate. This
   cookie never leaves the web origin.
2. **Supabase JWT** — sent as the Bearer token to the Express API for actual data access.

`/api/login` and `/api/logout` are the web app's own routes; every **other** `/api/*` path
is proxied/called against the Express API. `middleware.ts` exempts all of `/api` so
unauthenticated API calls return JSON errors instead of an HTML `/login` redirect.

## Server request pipeline

Each route module (`server/src/routes/*.routes.ts`, wired in `routes/index.ts`) applies
`router.use(authenticate)`, then per-endpoint `requireRole(...)` and `validate(schema)`
(Zod, from `@mb/shared`). Because the Admin SDK **bypasses Firestore security rules**,
authorization is enforced in application code: e.g. branch managers are scoped to their own
`branchId` and production users to active order statuses inside the handlers, not by rules.
Business logic lives in `services/`; errors bubble to `middleware/errorHandler.ts`.

## Shared schemas are mirrored, not shared

`server/src/shared/` and `frontend/src/shared/` are **byte-identical copies** (Zod schemas
+ TS types + `utils/timezone.ts`, `utils/stock.ts`), each exposed via the `@mb/shared`
tsconfig path alias → `./src/shared/index.ts`. There is no shared package. **When you edit
a schema or type, make the identical change in both trees**, or the client and API drift
apart silently.

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
- **Schedulers** (`server/src/scheduler/`) arm two idempotent 2 AM Karachi node-cron jobs —
  daily closing (respects the `autoCloseBusiness` setting) and future-dated price activation
  — plus a startup catch-up for missed price activations. They only fire while the dyno is
  awake, and the idempotency locks assume **one dyno** (`web=1`). Keep it single-instance.

## Frontend data fetching

TanStack Query throughout. **Every query key comes from `src/lib/queryKeys.ts` (`qk`)** —
never hand-roll a key, or invalidations silently miss it. `AuthProvider`, `QueryProvider`,
`RealtimeProvider`, `ThemeProvider` are mounted once at the root; consume auth via
`useAuth()` and realtime via `useNotifications()` / `useChats()` rather than opening your
own listeners. The API client is `src/lib/api/client.ts` (`apiCall`), which attaches the
Bearer token and normalizes errors into `ApiError`.

## Deploy gotchas that bite

- **`NEXT_PUBLIC_*` is inlined at build time.** Setting `NEXT_PUBLIC_API_URL` (or the
  Firebase VAPID key) on a running host does nothing — it requires a rebuild. This is the
  most common deploy failure; symptom is pages that render but every table is empty.
- The six `NEXT_PUBLIC_FIREBASE_*` web-config values are **hardcoded** in
  `src/lib/firebase/client.ts` and again in `public/firebase-messaging-sw.js`; env vars for
  them are ignored (except `NEXT_PUBLIC_FIREBASE_VAPID_KEY`). Changing Firebase projects
  means editing both files.
- The API's CORS allowlist is `CORS_ORIGINS` (comma-separated) in `server/src/app.ts`; it
  must match the web origin exactly (scheme + host, no trailing slash). localhost/127.0.0.1
  are always allowed. A mismatch fails at the browser with no server-side error.
- Firebase Admin credentials load from `FIREBASE_SERVICE_ACCOUNT` (raw JSON) or
  `..._BASE64` in production, or `FIREBASE_SERVICE_ACCOUNT_PATH` (a gitignored file under
  `server/credentials/`) locally.

> Note: the server README references `pnpm deploy:rules|indexes|firebase` and
> `firebase.json` / `firestore.rules` — those scripts and files are **not present** in the
> repo. Ignore them unless they are re-added.

## Next.js version caveat

`frontend/AGENTS.md` (imported by `frontend/CLAUDE.md`) warns that this Next.js (16.2.x) has
breaking changes vs older training data — check `node_modules/next/dist/docs/` before
writing framework-level code.
