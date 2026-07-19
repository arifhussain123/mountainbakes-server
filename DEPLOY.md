# Deploying the Mountain Bakes API

This folder deploys as its **own** Heroku app, independent of `../frontend/`.

```
Browser ──HTTPS──▶ Next.js web app ──┐
                                     ├──HTTPS──▶ this API ──▶ Firebase
Web app SSR ─────────────────────────┘
```

The browser calls this API directly and cross-origin, so **`CORS_ORIGINS` is
required** — it is what permits the web app's requests.

## Prerequisites

- Heroku CLI installed, `heroku login` done.
- A Firebase service-account JSON (Firebase Console → ⚙ Project settings →
  Service accounts → Generate new private key). Never commit it.
- `pnpm-lock.yaml` committed — builds install from it.

## Deploy

This folder is its own git repository, so pushes come from here:

```bash
cd server
heroku create <api-app> --remote heroku
heroku config:set -a <api-app> \
  FIREBASE_SERVICE_ACCOUNT="$(cat credentials/serviceAccount.json)" \
  NODE_ENV=production \
  NEXT_PUBLIC_FIREBASE_PROJECT_ID=mountain-bakes \
  NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=mountain-bakes.firebasestorage.app \
  CORS_ORIGINS=https://<web-host>

git push heroku HEAD:main
curl https://<api-host>/health          # → {"status":"ok","service":"mountain-bakes-api"}
```

Heroku's Node buildpack reads `package.json`; the `Procfile` runs `pnpm start`.
Heroku injects `PORT`, which `server.ts` reads before falling back to `API_PORT`,
and binds `0.0.0.0`.

| Variable | When | Value |
| --- | --- | --- |
| `SUPABASE_URL` | **Required** | `https://<project-ref>.supabase.co` — auth verification fails without it and every request 401s |
| `SUPABASE_SERVICE_ROLE_KEY` | **Required** | The **secret** service-role key, not the anon/publishable one |
| `FIREBASE_SERVICE_ACCOUNT` | **Required** | Raw service-account JSON (or `…_BASE64`). Still needed — Firestore/Storage remain the data layer. There is no file in a dyno, so `FIREBASE_SERVICE_ACCOUNT_PATH` is local-dev only |
| `CORS_ORIGINS` | **Required** | The web app's exact origin: scheme + host, no path, no trailing slash. Comma-separate multiple |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | **Required** | `mountain-bakes` |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | **Required** | `mountain-bakes.firebasestorage.app` |
| `NODE_ENV` | Recommended | `production` |

> **Migration in progress.** Auth is Supabase; data, storage, and messaging are still
> Firebase. Both sets of credentials are required until the data-layer phase lands.

## Runtime pinning

`package.json` pins `"engines": { "node": "24.x" }` and
`"packageManager": "pnpm@11.12.0"`. **Do not loosen the engine to an open range
like `>=20`.** Heroku resolves a range to the *highest* available Node, and
Corepack — which puts `pnpm` on `PATH` for the `Procfile` — was unbundled from
Node at v25. An open range can resolve to a Node with no Corepack and break both
the build and the dyno boot.

## Order of operations

Deploy this API **before** the web app, because the web app needs this API's URL
baked into its build:

1. Set `CORS_ORIGINS` here to the web app's origin.
2. Push this app; confirm `/health`.
3. Set `NEXT_PUBLIC_API_URL` on the web app to this API's URL.
4. Push the web app.

## Verify

```bash
heroku run "node --version" -a <api-app>    # => v24.x.x
heroku run "pnpm --version" -a <api-app>    # => 11.12.0
heroku ps -a <api-app>                      # web.1 up, no crash loop
heroku logs --tail -a <api-app>
```

At boot the API logs `[cors] Allowed origins: …`. If the web app reports
`Could not reach the API`, compare that line against the exact `Origin` header in
the browser's Network tab — **a CORS mismatch produces no API-side error at all**,
because `src/app.ts` deliberately omits the headers rather than throwing.

## Notes

- **Scheduled jobs** (2 AM Karachi closing + price activation) run in this dyno via
  `node-cron`. They only fire while the dyno is awake — avoid a sleeping tier if you
  rely on the exact 2 AM run. This dyno sees less traffic than the web app, so it is
  likelier to idle.
- **Keep it at one dyno** (`heroku ps:scale web=1`). The jobs are written to be
  idempotent, but running them on multiple dynos concurrently is untested.
- **Firestore rules/indexes are no longer managed here.** The Firebase CLI config
  was removed during the Supabase migration; the rules stay deployed and active in
  the `mountain-bakes` project, but must now be edited via the Firebase Console.
