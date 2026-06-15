// POST /api/payments/webhook
// Receives Dodo Payments webhooks. Security & correctness:
//  - Verifies the Standard-Webhooks HMAC signature over the RAW body via
//    dodo.webhooks.unwrap(); an invalid/replayed signature is rejected (401).
//  - Idempotent: every event is keyed by the `webhook-id` header; a duplicate
//    delivery is acknowledged without re-processing.
//  - Never trusts client input — userId is read from the subscription metadata
//    we stamped at checkout, falling back to the stored Dodo customer id.
import type { APIRoute } from 'astro';
import { prisma } from '../../../lib/prisma';
import { dodo } from '../../../lib/payments/dodo';
import { upsertSubscriptionFromWebhook } from '../../../lib/payments/subscription';
import { consumeRedemption } from '../../../lib/payments/credits';

export const prerender = false;

// Map Dodo subscription event types → the status we store.
const STATUS_BY_EVENT: Record<string, string> = {
  'subscription.active': 'active',
  'subscription.renewed': 'active',
  'subscription.plan_changed': 'active',
  'subscription.on_hold': 'on_hold',
  'subscription.cancelled': 'cancelled',
  'subscription.expired': 'expired',
  'subscription.failed': 'failed',
};

function toDate(v: unknown): Date | null {
  if (!v || typeof v !== 'string') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const POST: APIRoute = async ({ request }) => {
  const webhookId = request.headers.get('webhook-id') ?? '';
  const raw = await request.text();

  // 1) Verify signature over the raw body.
  let event: { type?: string; data?: Record<string, unknown> };
  try {
    event = dodo.webhooks.unwrap(raw, {
      headers: {
        'webhook-id': webhookId,
        'webhook-signature': request.headers.get('webhook-signature') ?? '',
        'webhook-timestamp': request.headers.get('webhook-timestamp') ?? '',
      },
    }) as unknown as typeof event;
  } catch (err) {
    console.warn('[payments] webhook signature verification failed:', err);
    return new Response('invalid signature', { status: 401 });
  }

  // 2) Idempotency — skip if we've already processed this delivery.
  if (webhookId) {
    const seen = await prisma.webhookEvent.findUnique({ where: { id: webhookId } });
    if (seen) return new Response('ok (duplicate)', { status: 200 });
  }

  const type = event.type ?? '';
  const data = (event.data ?? {}) as Record<string, unknown>;

  try {
    if (type.startsWith('subscription.')) {
      const status = STATUS_BY_EVENT[type];
      if (status) {
        const subscriptionId = String(data.subscription_id ?? '');
        const customerId = String(
          (data.customer as { customer_id?: string } | undefined)?.customer_id ?? data.customer_id ?? '',
        ) || null;
        const metadata = (data.metadata ?? {}) as Record<string, string>;

        // Resolve the owning user: metadata first, then customer-id mapping.
        let userId = metadata.userId || '';
        if (!userId && customerId) {
          const u = await prisma.user.findFirst({
            where: { dodoCustomerId: customerId },
            select: { id: true },
          });
          userId = u?.id ?? '';
        }

        if (userId && subscriptionId) {
          await upsertSubscriptionFromWebhook({
            userId,
            dodoSubscriptionId: subscriptionId,
            dodoCustomerId: customerId,
            productId: (data.product_id as string | undefined) ?? null,
            status,
            cancelAtPeriodEnd: Boolean(data.cancel_at_next_billing_date ?? data.cancelled_at),
            currentPeriodEnd: toDate(data.next_billing_date) ?? toDate(data.expires_at),
          });
          // Cache the customer id on the user for future checkouts.
          if (customerId) {
            await prisma.user
              .update({ where: { id: userId }, data: { dodoCustomerId: customerId } })
              .catch(() => {/* unique race / already set — ignore */});
          }
          // Once active, spend any store credit that was applied at checkout.
          if (status === 'active' && metadata.redemptionId) {
            await consumeRedemption(metadata.redemptionId);
          }
        } else {
          console.warn('[payments] webhook %s missing userId/subscriptionId', type);
        }
      }
    }
    // payment.* events are acknowledged; subscription.* drives entitlement.

    // 3) Record as processed (after success) for idempotency.
    if (webhookId) {
      await prisma.webhookEvent
        .create({ data: { id: webhookId, type } })
        .catch(() => {/* concurrent duplicate — fine */});
    }
    return new Response('ok', { status: 200 });
  } catch (err) {
    console.error('[payments] webhook processing error:', err);
    // 500 → Dodo will retry the delivery.
    return new Response('processing error', { status: 500 });
  }
};
