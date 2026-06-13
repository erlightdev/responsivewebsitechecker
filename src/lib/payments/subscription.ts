// Subscription read/write helpers. The Subscription table mirrors Dodo and is
// the source we read for plan/feature gating across the app.
import type { Subscription } from '@prisma/client';
import { prisma } from '../prisma';
import { ACTIVE_STATUSES, type Interval, type PlanId } from './plans';
import { productToPlan } from './plan-store';
import { dodo } from './dodo';

export interface PlanState {
  plan: PlanId; // 'free' | 'pro'
  interval: Interval | null;
  status: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

const FREE: PlanState = {
  plan: 'free',
  interval: null,
  status: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
};

/** Effective plan for a user — 'pro' only while a subscription is in an active state. */
export async function getUserPlan(userId: string): Promise<PlanState> {
  const sub = await prisma.subscription.findFirst({
    where: { userId, status: { in: [...ACTIVE_STATUSES] } },
    orderBy: { updatedAt: 'desc' },
  });
  if (!sub) return FREE;
  return {
    plan: 'pro',
    interval: sub.interval as Interval,
    status: sub.status,
    currentPeriodEnd: sub.currentPeriodEnd,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
  };
}

export async function isProUser(userId: string): Promise<boolean> {
  return (await getUserPlan(userId)).plan === 'pro';
}

/** Upsert a subscription row from a verified webhook payload. */
export async function upsertSubscriptionFromWebhook(input: {
  userId: string;
  dodoSubscriptionId: string;
  dodoCustomerId?: string | null;
  productId?: string | null;
  status: string;
  cancelAtPeriodEnd?: boolean;
  currentPeriodEnd?: Date | null;
}) {
  const { plan, interval } = await productToPlan(input.productId);
  return prisma.subscription.upsert({
    where: { dodoSubscriptionId: input.dodoSubscriptionId },
    create: {
      userId: input.userId,
      dodoSubscriptionId: input.dodoSubscriptionId,
      dodoCustomerId: input.dodoCustomerId ?? null,
      productId: input.productId ?? null,
      plan,
      interval,
      status: input.status,
      cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? false,
      currentPeriodEnd: input.currentPeriodEnd ?? null,
    },
    update: {
      dodoCustomerId: input.dodoCustomerId ?? undefined,
      productId: input.productId ?? undefined,
      plan,
      interval,
      status: input.status,
      cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? undefined,
      currentPeriodEnd: input.currentPeriodEnd ?? undefined,
    },
  });
}

/** Most recent subscription row for a user (any status), for the details panel. */
export async function getActiveSubscription(userId: string): Promise<Subscription | null> {
  return prisma.subscription.findFirst({
    where: { userId, status: { in: [...ACTIVE_STATUSES] } },
    orderBy: { updatedAt: 'desc' },
  });
}

/**
 * Confirm a subscription when the user returns from hosted checkout. We DON'T
 * trust the query string — we fetch the subscription from Dodo, verify it
 * belongs to this user, then mirror it locally. This makes the plan update
 * immediately even when webhooks can't reach a local dev server.
 */
export async function confirmSubscriptionFromReturn(
  subscriptionId: string,
  user: { id: string; email: string },
): Promise<boolean> {
  try {
    const sub = await dodo.subscriptions.retrieve(subscriptionId);
    const customer = (sub.customer ?? {}) as { customer_id?: string; email?: string };
    const metaUserId = ((sub.metadata ?? {}) as Record<string, string>).userId;

    const owns = metaUserId
      ? metaUserId === user.id
      : !!customer.email && customer.email.toLowerCase() === user.email.toLowerCase();
    if (!owns) {
      console.warn('[payments] confirm: subscription %s does not belong to user', subscriptionId);
      return false;
    }

    await upsertSubscriptionFromWebhook({
      userId: user.id,
      dodoSubscriptionId: sub.subscription_id,
      dodoCustomerId: customer.customer_id ?? null,
      productId: sub.product_id ?? null,
      status: sub.status,
      cancelAtPeriodEnd: Boolean(sub.cancel_at_next_billing_date),
      currentPeriodEnd: sub.next_billing_date ? new Date(sub.next_billing_date) : null,
    });

    if (customer.customer_id) {
      await prisma.user
        .update({ where: { id: user.id }, data: { dodoCustomerId: customer.customer_id } })
        .catch(() => {/* unique race / already set */});
    }
    return true;
  } catch (err) {
    console.error('[payments] confirm failed:', err);
    return false;
  }
}

export interface Txn {
  id: string;
  date: Date;
  amount: number; // smallest denomination
  currency: string;
  status: string;
  cardLast4: string | null;
  cardNetwork: string | null;
  invoiceUrl: string | null;
}

/** Recent payments for a subscription, pulled live from Dodo for the history table. */
export async function listSubscriptionPayments(subscriptionId: string, limit = 10): Promise<Txn[]> {
  try {
    const page = await dodo.payments.list({ subscription_id: subscriptionId });
    const items = ((page as { items?: unknown[] }).items ?? []).slice(0, limit);
    return (items as Record<string, unknown>[]).map((p) => ({
      id: String(p.payment_id ?? ''),
      date: p.created_at ? new Date(String(p.created_at)) : new Date(0),
      amount: Number(p.total_amount ?? 0),
      currency: String(p.currency ?? 'USD'),
      status: String(p.status ?? 'succeeded'),
      cardLast4: (p.card_last_four as string | null) ?? null,
      cardNetwork: (p.card_network as string | null) ?? null,
      invoiceUrl: (p.invoice_url as string | null) ?? null,
    }));
  } catch (err) {
    console.error('[payments] list payments failed:', err);
    return [];
  }
}
