// Spending store credit at checkout. Dodo has no native account-credit and its
// discounts are percentage-only, so we convert the user's credit into a one-time
// percentage discount on the specific plan price (single billing cycle), then
// deduct the credit only once the subscription actually goes active.
import { prisma } from '../prisma';
import { dodo } from './dodo';

/** True when the user is still eligible to spend credit (no prior subscription). */
export async function isCreditEligible(userId: string): Promise<boolean> {
  const priorSubs = await prisma.subscription.count({ where: { userId } });
  return priorSubs === 0;
}

export interface AppliedCredit {
  redemptionId: string;
  code: string;
  amountCents: number; // credit consumed, in USD smallest unit
}

/**
 * Build a one-time Dodo discount worth the user's available credit (capped at the
 * plan price) and record a pending redemption. Returns null when there's no
 * credit to apply or the discount couldn't be created. The percentage is derived
 * from the plan price so the dollar value comes off pre-tax — credit isn't taxed.
 */
export async function applyCreditToCheckout(input: {
  userId: string;
  productId: string;
  priceCents: number;
}): Promise<AppliedCredit | null> {
  if (input.priceCents <= 0) return null;

  // Credit only applies to a *new* account's first upgrade. If this user has ever
  // had a subscription (active, cancelled, expired, …) they aren't eligible — this
  // blocks farming credit across repeated subscribe/cancel cycles.
  const priorSubs = await prisma.subscription.count({ where: { userId: input.userId } });
  if (priorSubs > 0) return null;

  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { creditCents: true },
  });
  const credit = user?.creditCents ?? 0;
  if (credit <= 0) return null;

  // Never discount more than the price; leftover credit stays on the balance.
  const amountCents = Math.min(credit, input.priceCents);
  // Basis points of the plan price (100% = 10000). Must be >= 1.
  const bps = Math.min(10000, Math.max(1, Math.round((amountCents / input.priceCents) * 10000)));

  try {
    const discount = await dodo.discounts.create({
      amount: bps,
      type: 'percentage',
      name: 'Account credit',
      usage_limit: 1,
      subscription_cycles: 1, // one-time: applies to the first billing cycle only
      restricted_to: [input.productId],
    } as Parameters<typeof dodo.discounts.create>[0]);

    const d = discount as { discount_id: string; code: string };
    const redemption = await prisma.creditRedemption.create({
      data: {
        userId: input.userId,
        discountId: d.discount_id,
        code: d.code,
        amountCents,
        status: 'pending',
      },
    });
    return { redemptionId: redemption.id, code: d.code, amountCents };
  } catch (err) {
    console.error('[payments] failed to create credit discount:', err);
    return null;
  }
}

/**
 * Mark a pending redemption applied and deduct the credit. Idempotent: only a
 * pending row does anything, so duplicate webhook + return-confirm calls are safe.
 */
export async function consumeRedemption(redemptionId: string): Promise<void> {
  if (!redemptionId) return;
  try {
    await prisma.$transaction(async (tx) => {
      const r = await tx.creditRedemption.findUnique({ where: { id: redemptionId } });
      if (!r || r.status !== 'pending') return;
      await tx.creditRedemption.update({ where: { id: r.id }, data: { status: 'applied' } });
      await tx.user.update({
        where: { id: r.userId },
        data: { creditCents: { decrement: r.amountCents } },
      });
      // Guard against ever going negative (concurrent spends).
      const fresh = await tx.user.findUnique({ where: { id: r.userId }, select: { creditCents: true } });
      if (fresh && fresh.creditCents < 0) {
        await tx.user.update({ where: { id: r.userId }, data: { creditCents: 0 } });
      }
    });
  } catch (err) {
    console.error('[payments] failed to consume redemption %s:', redemptionId, err);
  }
}
