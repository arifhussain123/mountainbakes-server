# Mountain Bakes API

The Express REST API for Mountain Bakes ERP. Talks to Firebase (Firestore, Auth,
Storage) via the Admin SDK and owns every database write — the web client never
touches Firestore directly for privileged collections.

This folder is a **standalone project**. Its sibling `../frontend/` is the Next.js
web client, deployed separately. Neither depends on any file above this directory.

```
server/
├── server.ts             # entry: loads env, listens, starts schedulers
├── src/
│   ├── app.ts            # the configured Express app (helmet, CORS, routes)
│   ├── config/           # firebase.ts — Firebase Admin init
│   ├── routes/           # 17 route modules
│   ├── services/         # business logic (stock, pricing, exports, push…)
│   ├── middleware/       # auth, requireRole, validate, business-day guard
│   ├── scheduler/        # node-cron: 2 AM closing, price activation
│   ├── scripts/          # seed, purge-price-history
│   └── shared/           # schemas/types (mirrored in frontend/src/shared)
├── credentials/          # service-account key — GITIGNORED, never commit
└── Procfile              # web: pnpm start
```

## Local development

```bash
pnpm install
cp .env.example .env          # then fill it in
pnpm dev                      # http://localhost:3001
```

Requires Node 24.x and pnpm 11.12.0 (both pinned in `package.json`).

The Firebase service account is read from `FIREBASE_SERVICE_ACCOUNT_PATH`,
resolved relative to this folder — it defaults to `./credentials/serviceAccount.json`.
In production there is no file on disk; set `FIREBASE_SERVICE_ACCOUNT` to the raw
JSON instead (see [DEPLOY.md](DEPLOY.md)).

To run the full stack, start the web client in a second terminal:

```bash
cd ../frontend && pnpm dev    # http://localhost:3000
```

There is no longer a single command that starts both — they are independent
projects by design.

## Authentication

Requests carry a **Supabase** access-token JWT as `Authorization: Bearer <jwt>`,
verified in `src/middleware/auth.ts` via `supabaseAdmin.auth.getUser(token)`. Role
and branch come from the user's Supabase `app_metadata`.

There is no session cookie on this side; the `mb_session` cookie belongs to the web
app and stays on its own origin. This is why the two apps can live on different
hosts.

Browser origins allowed to call this API come from `CORS_ORIGINS` (comma-separated).
localhost and 127.0.0.1 are always permitted. A mismatch fails **silently** in the
API logs — the browser blocks it — so compare the request's `Origin` header against
the `[cors] Allowed origins:` line printed at boot.

## Firestore rules and indexes

The Firebase CLI config (`firebase.json`, `.firebaserc`, `firestore.rules`,
`firestore.indexes.json`, `storage.rules`) has been **removed from this repo** as
part of the migration away from Firebase.

The rules and indexes remain **deployed and active** in the `mountain-bakes`
Firebase project — deleting the local files did not undeploy them. But they are no
longer version-controlled here, so to change them you must either edit them in the
Firebase Console or restore the files from git history.

This matters while the web client still reads Firestore directly for notifications,
chat, and presence: those reads are governed by the deployed `firestore.rules`.

## Scheduled jobs

`src/scheduler/` arms two node-cron jobs at 2:00 AM Asia/Karachi: the daily closing
and future-dated price activation. They only fire while this dyno is awake, so avoid
a sleeping tier if you depend on the exact 2 AM run. Keep the API at one dyno
(`heroku ps:scale web=1`) — the jobs are written to be idempotent but have not been
exercised with multiple concurrent dynos.

## Maintenance scripts

```bash
pnpm purge:price-history              # dry run — counts, deletes nothing
pnpm purge:price-history -- --confirm # permanently delete
node scripts/seed.js                  # seed baseline data + super admin
node scripts/enable-email-auth.mjs    # toggle email/password sign-in
```
