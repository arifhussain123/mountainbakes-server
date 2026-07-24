# Deploying the Mountain Bakes API

This folder deploys as its **own** Heroku app, independent of `../frontend/`.

```
Browser ──HTTPS──▶ Next.js web app ──┐
                                     ├──HTTPS──▶ this API ──▶ Supabase (Postgres)
Web app SSR ─────────────────────────┘
```

The browser calls this API directly and cross-origin, so **`CORS_ORIGINS` is
required** — it is what permits the web app's requests.

## Prerequisites

- Heroku CLI installed, `heroku login` done.
- A Supabase project, with its URL and **secret** service-role key to hand
  (Supabase dashboard → Project Settings → API). Never commit the key.
- `pnpm-lock.yaml` committed — builds install from it.

## Deploy

This folder is its own git repository, so pushes come from here:

```bash
cd server
heroku create <api-app> --remote heroku
heroku config:set -a <api-app> \
  SUPABASE_URL=https://<project-ref>.supabase.co \
  SUPABASE_SERVICE_ROLE_KEY=<secret-service-role-key> \
  NODE_ENV=production \
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
| `SUPABASE_SERVICE_ROLE_KEY` | **Required** | The **secret** service-role key, not the anon/publishable one. Grants full admin access — keep it server-side only |
| `CORS_ORIGINS` | **Required** | The web app's exact origin: scheme + host, no path, no trailing slash. Comma-separate multiple |
| `NODE_ENV` | Recommended | `production` |

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

- **Database migrations** live in `supabase/migrations/*.sql` and are applied with
  the Supabase CLI (`supabase db push`), not by the dyno at boot. Apply pending
  migrations before or alongside a deploy that depends on them.
- **Scheduled jobs** (2 AM Karachi closing + price activation) run in this dyno via
  `node-cron`. They only fire while the dyno is awake — avoid a sleeping tier if you
  rely on the exact 2 AM run. This dyno sees less traffic than the web app, so it is
  likelier to idle.
- **Keep it at one dyno** (`heroku ps:scale web=1`). The jobs are idempotent, but
  their locks assume a single instance — running them on multiple dynos concurrently
  is untested.
