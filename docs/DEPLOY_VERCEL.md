# Deploying to Vercel

This app is an Astro SSR project using a remote Hostinger MySQL database
(Prisma 6), Better Auth, and Dodo Payments. This guide lists every environment
variable to configure on Vercel and the production gotchas that will otherwise
silently break login, payments, or the database connection.

## Environment variables

Set these under **Vercel → Project → Settings → Environment Variables**, scoped
to **Production** (and **Preview** if you want preview deploys to work).

### Copy as-is (same values as local `.env`)

| Variable | Notes |
|---|---|
| `DATABASE_URL` | `mysql://USER:PASSWORD@srv1498.hstgr.io:3306/DBNAME` — the password's `+` must be URL-encoded as `%2B`. |
| `BETTER_AUTH_SECRET` | Auth signing secret. Keep stable; rotating it invalidates all sessions. |
| `EMAIL_FROM` | e.g. `Prakash <prakash@hiver.com.np>` |
| `SMTP_HOST` | `smtp.hostinger.com` |
| `SMTP_PORT` | `465` |
| `SMTP_SECURE` | `true` |
| `SMTP_USER` | SMTP login. |
| `SMTP_PASS` | SMTP password. |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID. |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret. |
| `SUPERADMIN_EMAIL` | The account that auto-becomes superadmin on signup. |

> `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` are optional — leave them unset
> unless you enable GitHub login.

### Must point at the real domain

Replace `https://your-app.vercel.app` with your actual production URL.

| Variable | Production value |
|---|---|
| `BETTER_AUTH_URL` | `https://your-app.vercel.app` |
| `PUBLIC_BETTER_AUTH_URL` | `https://your-app.vercel.app` |
| `PUBLIC_APP_URL` | `https://your-app.vercel.app` |

### Dodo Payments — test vs live

Keep `test_mode` until you are ready to take real payments, then switch all three
together.

| Variable | Value |
|---|---|
| `DODO_PAYMENTS_ENVIRONMENT` | `test_mode` or `live_mode` |
| `DODO_PAYMENTS_API_KEY` | Test key for test_mode; **live** key for live_mode. |
| `DODO_PAYMENTS_WEBHOOK_KEY` | Signing secret for the matching webhook endpoint. |

## Production gotchas

1. **`PUBLIC_*` vars are baked in at build time.** Changing the domain later
   requires a **redeploy**, not just a var edit.

2. **Google OAuth redirect URI.** In Google Cloud Console, add
   `https://your-app.vercel.app/api/auth/callback/google` to the authorized
   redirect URIs, or Google login fails with `redirect_uri_mismatch`.

3. **Dodo webhook URL.** Point the Dodo dashboard webhook at
   `https://your-app.vercel.app/api/payments/webhook` and use that endpoint's
   signing secret for `DODO_PAYMENTS_WEBHOOK_KEY`.

4. **Hostinger Remote MySQL whitelist.** Vercel serverless functions use
   rotating outbound IPs. Hostinger's *Remote MySQL* whitelists by IP, so allow
   `%` (any host) for the DB user or connections from Vercel will be refused.

5. **Serverless connection limits.** Shared MySQL has a low `max_connections`
   cap. Each serverless invocation can open a new Prisma connection; under load
   this can exhaust the pool. Consider a connection limit in `DATABASE_URL`
   (e.g. `?connection_limit=3`) or an external pooler if you hit
   "too many connections" errors.

## Superadmin bootstrap

No script is needed. Better Auth's user-create hook auto-assigns the
`superadmin` role (and marks the email verified) to whoever signs up with the
`SUPERADMIN_EMAIL` address. After the first deploy, sign up with that email once.

## Database schema

The schema is applied with Prisma. Against the remote DB:

```sh
npx prisma db push        # sync schema (additive)
```

Run this from a machine whose IP is whitelisted in Hostinger Remote MySQL, not
from Vercel. On Windows, stop the dev server before `prisma generate` — a running
Node process locks the query-engine DLL (`EPERM`).
