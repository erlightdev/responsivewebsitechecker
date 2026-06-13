# Dodo Payments setup

Subscription billing for the **Pro** plan is handled by [Dodo Payments](https://dodopayments.com)
(merchant of record). You can run fully in **test mode** now and flip to **live mode**
later by changing env vars only — no code changes.

## Architecture

```
src/lib/payments/
  dodo.ts          Dodo client singleton (test_mode / live_mode from env)
  plans.ts         shared types (PlanId, Interval) + active statuses
  plan-store.ts    DB-backed plan catalog; creates/updates Dodo products on save
  subscription.ts  read user plan / upsert subscription from webhooks

src/pages/admin/plans.astro     superadmin UI to author + sync the Pro plans
src/pages/api/admin/plans.ts    POST upsert+sync, GET list, DELETE archive (superadmin)
src/pages/api/payments/
  checkout.ts      POST – auth required; creates a checkout session, returns hosted URL
  webhook.ts       POST – verifies signature, idempotent, syncs Subscription table

prisma/schema.prisma
  Plan             superadmin-authored plan; holds the synced Dodo product id
  Subscription     mirror of Dodo subscriptions (source of truth for gating)
  WebhookEvent     idempotency ledger keyed by the `webhook-id` header
  User.dodoCustomerId  cached Dodo customer id for repeat checkouts
```

The **Subscription** table is the source we read for Pro gating (middleware
`/social` + `/captures`, and the billing page). Dodo remains the source of truth;
we only mirror it via verified webhooks.

## Security measures

- **Secret key is server-only.** `DODO_PAYMENTS_API_KEY` is read with
  `import.meta.env` and used only in server routes / libs. It is never a
  `PUBLIC_` var, so it is never shipped to the browser.
- **Webhooks are signature-verified.** `webhook.ts` calls
  `dodo.webhooks.unwrap()` over the **raw** request body using
  `DODO_PAYMENTS_WEBHOOK_KEY` (Standard Webhooks HMAC-SHA256). Bad/replayed
  signatures get `401`.
- **Idempotent webhooks.** Each delivery is recorded by its `webhook-id`;
  duplicates are acknowledged without re-processing.
- **No anonymous checkout.** `checkout.ts` requires a valid Better Auth session.
- **No trusting the client.** The client only picks the billing *interval*;
  product ids come from server env, and the owning `userId` is stamped into
  checkout metadata so the webhook maps the subscription to the right account.
- The payments routes are exempted from the auth-redirect middleware
  (`/api/payments/*`) because each handler enforces its own auth.

## Environment variables

Add these to `.env` (already scaffolded; see `.env.example`):

| Var | Description |
|-----|-------------|
| `DODO_PAYMENTS_ENVIRONMENT` | `test_mode` now, `live_mode` for production |
| `DODO_PAYMENTS_API_KEY` | Server secret API key (Dashboard → Developer → API Keys) |
| `DODO_PAYMENTS_WEBHOOK_KEY` | Webhook signing secret (Dashboard → Developer → Webhooks) |
| `PUBLIC_APP_URL` | Base URL used to build the checkout return URL |

> **Products are not configured via env.** A superadmin creates the Pro plans in
> the app at **/admin/plans**; each save creates/updates the matching product in
> Dodo via the Products API and stores its `product_id` on the `plan` row.
> Checkout resolves product ids from that table.

> Use the **test-mode** key + test products while developing. When ready,
> create live-mode products, swap the five Dodo vars to live values, set
> `DODO_PAYMENTS_ENVIRONMENT=live_mode`, and point a live webhook at your domain.

## One-time setup (test mode)

1. **API key:** Developer → API Keys → create a **test** key → `DODO_PAYMENTS_API_KEY`.
2. **Apply the DB schema** (see step 4 below) so the `plan` table exists.
3. **Create the plans in-app:** sign in as superadmin → **/admin → Manage
   subscription plans** (`/admin/plans`). Fill in the Pro Monthly and Pro Yearly
   prices and click *Save & sync* — this calls the Dodo Products API, creates the
   products, and stores their ids. No copy-pasting product ids.
4. **Webhook:** Developer → Webhooks → add endpoint
   `https://<your-host>/api/payments/webhook` → copy the signing secret into
   `DODO_PAYMENTS_WEBHOOK_KEY`. Subscribe to at least:
   `subscription.active`, `subscription.renewed`, `subscription.on_hold`,
   `subscription.cancelled`, `subscription.expired`, `subscription.failed`.
   - For local testing, expose your dev server (e.g. `ngrok http 4321`) and use
     the public URL for the webhook endpoint.
4. **Apply the DB schema** (creates `subscription`, `webhook_event`, and the
   `user.dodoCustomerId` column):
   ```sh
   npm run db:push
   ```

## Test flow

1. `npm run dev`, sign in, go to **/billing**.
2. Pick Monthly or Yearly, click **Upgrade to Pro** → you're redirected to the
   Dodo hosted checkout. Pay with a Dodo **test card**.
3. On return you'll see a "payment is being confirmed" note. When the
   `subscription.active` webhook arrives, the `Subscription` row is written and
   the banner flips to **Pro**; `/social` and `/captures` unlock.

## Going live

1. Recreate products in live mode; update the two product-id vars.
2. Set `DODO_PAYMENTS_ENVIRONMENT=live_mode` and use the live API + webhook keys.
3. Set `PUBLIC_APP_URL` to your production URL and register the production
   webhook endpoint.
