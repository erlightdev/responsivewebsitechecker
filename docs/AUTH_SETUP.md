# Auth setup — Viewport

Authentication is powered by **Better Auth** + **Prisma** (MySQL) + **Nodemailer**.
Plugins in use: `emailOTP` (6-digit codes, 60s expiry) and `admin` (roles, bans).

## 1. Database
- DB: `lightresponsivechecker` on local MySQL (`root`, empty password). Already created.
- Connection string lives in `.env` as `DATABASE_URL`. Swap it for a hosted URL later.
- Prisma is pinned to **v6** (v7 mandates driver adapters / a config file — unnecessary here).
- Apply schema changes after editing `prisma/schema.prisma`:
  ```
  npx prisma db push      # sync tables   (alias: npm run db:push)
  npx prisma generate     # regenerate the client
  npx prisma studio       # browse data   (alias: npm run db:studio)
  ```

## 2. The superadmin
- The email in `.env` `SUPERADMIN_EMAIL` (currently `prakash@hiver.com.np`) is **auto-granted the `superadmin` role and auto-verified** the first time it signs up (via a `databaseHooks.user.create.before` hook in `src/lib/auth.ts`).
- Go to `/signup`, register with that email (email → OTP → optional password). You land in the app as superadmin: the **Admin** tab appears in the account nav and `/admin` becomes accessible.

## 3. Email (already configured)
- Nodemailer uses the Hostinger SMTP creds in `.env` (`SMTP_*`, `EMAIL_FROM`). OTP codes and password-reset links are sent from there. Tested working.
- Templates live in `src/lib/mailer.ts` (branded verification-code email + reset-link email).

## 4. GitHub OAuth
1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**.
2. Homepage URL: `http://localhost:4321`
3. Authorization callback URL: **`http://localhost:4321/api/auth/callback/github`**
4. Create the app, copy the **Client ID**, generate a **Client secret**.
5. Put them in `.env`:
   ```
   GITHUB_CLIENT_ID=...
   GITHUB_CLIENT_SECRET=...
   ```
6. Restart `npm run dev`. The "Continue with GitHub" button appears automatically.

## 5. Google OAuth
1. [Google Cloud Console](https://console.cloud.google.com/) → create/select a project.
2. **APIs & Services → OAuth consent screen** → External → add your email as a test user.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID → Web application**.
4. Authorized JavaScript origin: `http://localhost:4321`
5. Authorized redirect URI: **`http://localhost:4321/api/auth/callback/google`**
6. Copy the client ID + secret into `.env`:
   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   ```
7. Restart `npm run dev`. The "Continue with Google" button appears automatically.

> Social buttons are hidden until the matching env pair is filled in, and the dev server must be **restarted** after editing `.env` (env is read at boot). The OAuth `redirect_uri` is derived from `BETTER_AUTH_URL`, so run the app on port **4321**.

## 6. Auth flows

**Signup** (`/signup`) — passwordless first:
1. Enter email → a 6-digit OTP is sent (`type: sign-in`).
2. Verify the code → the account is **created and verified**, and a session is issued.
3. **Set a password** step (optional — "Skip for now" keeps it passwordless). Setting one calls `POST /api/set-password` (Better Auth's server-only `setPassword`, requires the fresh session) and creates a `credential` account so password login works later.
4. Redirect to the dashboard with a welcome toast.

**Login** (`/login`) — explicit method choice:
- **Continue with password** / **Log in with OTP** / **Google** / **GitHub**.
- Before sending an OTP or advancing to the password field, the page checks the email via `POST /api/auth-method` (returns only `{exists, verified, methods}` for that one email — never other users). Unknown email → *"No account found, please sign up"*, **no code sent**.
- Social login is **sign-in only**: providers set `disableImplicitSignUp: true`, so logging in with an unregistered Google/GitHub account does **not** create one — it bounces back to `/login?error=signup_disabled`. The signup page passes `requestSignUp: true` to allow creation.

**Forgot password** (`/forgot-password`) → emailed reset link → `/reset-password?token=…`.

**Account** (`/account`) — change/set password (current + new, or just new for passwordless accounts), update name, and delete account (confirmation modal → clears local data → sign out → `/login`).

**Sign out** — checker dropdown + account-nav button: ends the server session, clears all `vp-*` localStorage keys, shows a spinner, routes to `/login`.

## 7. Going to production
- Set `BETTER_AUTH_URL` / `PUBLIC_BETTER_AUTH_URL` to your https domain (enables secure cookies automatically).
- Add production callback URLs to the GitHub/Google apps (`https://yourdomain/api/auth/callback/<provider>`).
- Point `DATABASE_URL` at the hosted MySQL and run `npx prisma db push`.
- Generate a fresh `BETTER_AUTH_SECRET` (`openssl rand -base64 32`).

## What's enforced
- Whole app is gated (`/checker`, `/captures`, `/workspaces`, `/social`, `/activity`, `/account`, `/billing`, `/settings`, `/admin`); landing + auth pages are public. See `src/middleware.ts` (`sequence(proxy, authGate)`).
- Email verification is required (6-digit OTP, 60s expiry; only the newest code is valid).
- Superadmin `/admin`: ban/unban accounts, promote/demote roles, and toggle per-resource access (checker / captures / workspaces / social). Bans block login; resource toggles redirect the user away from that area — all enforced server-side.
- Security: HTTP-only SameSite cookies (secure in prod), scrypt password hashing, Better Auth rate limiting + CSRF/origin checks, secrets only in `.env` (git-ignored).
