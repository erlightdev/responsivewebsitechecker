// POST /api/payments/checkout
// Creates a Dodo Payments checkout session for the signed-in user and returns
// the hosted checkout URL. Security:
//  - Requires a valid Better Auth session (no anonymous checkout).
//  - Product ids come from server env only; the client only chooses the interval.
//  - userId is stamped into checkout metadata so the webhook can map the
//    resulting subscription back to this account (never trust client-sent ids).
import type { APIRoute } from 'astro';
import { auth } from '../../../lib/auth';
import { prisma } from '../../../lib/prisma';
import { dodo, isPaymentsConfigured } from '../../../lib/payments/dodo';
import { resolveProductId } from '../../../lib/payments/plan-store';
import { applyCreditToCheckout } from '../../../lib/payments/credits';
import type { Interval } from '../../../lib/payments/plans';

export const prerender = false;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

export const POST: APIRoute = async ({ request }) => {
  // 1) Authn
  const session = await auth.api.getSession({ headers: request.headers });
  const sessionUser = session?.user as { id: string; email: string; name?: string } | undefined;
  if (!sessionUser) return json({ error: 'unauthorized' }, 401);

  if (!isPaymentsConfigured) return json({ error: 'payments_not_configured' }, 503);

  // 2) Validate input — only the billing interval is client-controlled.
  let body: { interval?: string } = {};
  try {
    body = await request.json();
  } catch {
    /* empty body is fine; default below */
  }
  const interval: Interval = body.interval === 'yearly' ? 'yearly' : 'monthly';

  const productId = await resolveProductId('pro', interval);
  if (!productId) return json({ error: 'product_not_configured' }, 503);

  // Plan price drives the credit→percentage conversion (and is needed regardless).
  const planRow = await prisma.plan.findUnique({
    where: { interval },
    select: { priceCents: true },
  });

  // 3) Reuse an existing Dodo customer when we have one.
  const user = await prisma.user.findUnique({
    where: { id: sessionUser.id },
    select: { dodoCustomerId: true, email: true, name: true },
  });

  const baseUrl = import.meta.env.PUBLIC_APP_URL || new URL(request.url).origin;
  const returnUrl = `${baseUrl.replace(/\/$/, '')}/billing?status=success`;

  const customer = user?.dodoCustomerId
    ? { customer_id: user.dodoCustomerId }
    : { email: sessionUser.email, name: sessionUser.name || user?.name || sessionUser.email };

  // Spend store credit (invite & earn) as a one-time discount, if any is available.
  const credit = planRow
    ? await applyCreditToCheckout({
        userId: sessionUser.id,
        productId,
        priceCents: planRow.priceCents,
      })
    : null;

  const metadata: Record<string, string> = { userId: sessionUser.id, plan: 'pro', interval };
  if (credit) metadata.redemptionId = credit.redemptionId;

  try {
    const checkout = await dodo.checkoutSessions.create({
      product_cart: [{ product_id: productId, quantity: 1 }],
      customer,
      return_url: returnUrl,
      ...(credit ? { discount_code: credit.code } : {}),
      metadata,
    } as Parameters<typeof dodo.checkoutSessions.create>[0]);

    const url = (checkout as { checkout_url?: string; url?: string }).checkout_url
      ?? (checkout as { url?: string }).url;
    if (!url) return json({ error: 'no_checkout_url' }, 502);
    return json({ url });
  } catch (err) {
    console.error('[payments] checkout session failed:', err);
    return json({ error: 'checkout_failed' }, 502);
  }
};
