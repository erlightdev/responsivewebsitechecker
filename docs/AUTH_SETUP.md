# Auth setup — Viewport

Authentication is powered by **Better Auth** + **Prisma** (MySQL) + **Nodemailer**.

## 1. Database
- DB: `lightresponsivechecker` on local MySQL (`root`, empty password). Already created.
- Connection string lives in `.env` as `DATABASE_URL`. Swap it for a hosted URL later.
- Apply schema changes after editing `prisma/schema.prisma`:
  ```
  npx prisma db push      # sync tables
  npx prisma generate     # regenerate the client
  npx prisma studio       # browse data (optional)
  ```

## 2. The superadmin
- The email in `.env` `SUPERADMIN_EMAIL` (currently `prakash@hiver.com.np`) is **auto-granted the `superadmin` role and auto-verified** the first time it signs up.
- Just go to `/signup`, register with that email + a password, and you land in the app as superadmin. The **Admin** tab appears in the account nav and `/admin` becomes accessible.

## 3. Email (already configured)
- Nodemailer uses the Hostinger SMTP creds in `.env` (`SMTP_*`, `EMAIL_FROM`). OTP codes and password-reset links are sent from there. Tested working.

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

> Social buttons are hidden until the matching env pair is filled in, so the app works fine without them.

## 6. Going to production
- Set `BETTER_AUTH_URL` / `PUBLIC_BETTER_AUTH_URL` to your https domain (enables secure cookies automatically).
- Add production callback URLs to the GitHub/Google apps (`https://yourdomain/api/auth/callback/<provider>`).
- Point `DATABASE_URL` at the hosted MySQL and run `npx prisma db push`.
- Generate a fresh `BETTER_AUTH_SECRET` (`openssl rand -base64 32`).

## What's enforced
- Whole app is gated (`/checker`, `/captures`, `/workspaces`, `/social`, `/activity`, `/account`, `/billing`, `/settings`, `/admin`). Landing + auth pages are public.
- Email/password requires a **verified email** (6-digit OTP, 60s expiry).
- Login also supports **email OTP** and **GitHub/Google**.
- Forgot password → emailed reset link → `/reset-password`.
- Superadmin `/admin`: ban/unban accounts, promote/demote, and toggle per-resource access (checker / captures / workspaces / social). Bans block login; resource toggles redirect the user away from that area. All enforced server-side in `src/middleware.ts`.
