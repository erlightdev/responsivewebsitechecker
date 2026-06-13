// DB-backed plan catalog. Plans are authored by a superadmin in the app and
// synced to Dodo Payments (a Dodo product is created/updated via API and its id
// stored on the Plan row). Checkout/webhook resolve product ids from here — no
// product ids live in env.
import type { Plan } from '@prisma/client';
import { prisma } from '../prisma';
import { dodo } from './dodo';
import type { Interval, PlanId } from './plans';

const DODO_INTERVAL: Record<Interval, 'Month' | 'Year'> = {
  monthly: 'Month',
  yearly: 'Year',
};

export interface PlanInput {
  interval: Interval;
  name: string;
  description?: string | null;
  priceCents: number;
  currency?: string;
  taxCategory?: 'saas' | 'digital_products' | 'e_book' | 'edtech';
}

export async function listPlans(): Promise<Plan[]> {
  return prisma.plan.findMany({ orderBy: { priceCents: 'asc' } });
}

export interface PriceView {
  priceCents: number;
  currency: string;
  amount: string; // e.g. "$3"
  period: '/mo' | '/yr';
}

export interface PublicPricing {
  configured: boolean; // true when at least the monthly Pro plan is active+synced
  monthly: PriceView | null;
  yearly: PriceView | null;
  yearlySavingsPct: number; // discount of yearly vs 12×monthly; 0 when none
}

function fmt(cents: number, currency: string): string {
  const major = cents / 100;
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: major % 1 === 0 ? 0 : 2,
  }).format(major);
}

/** Pricing for public/marketing + billing UI, sourced from synced plans. */
export async function getPublicPricing(): Promise<PublicPricing> {
  const rows = await prisma.plan.findMany({ where: { active: true } });
  const m = rows.find((r) => r.interval === 'monthly' && r.dodoProductId);
  const y = rows.find((r) => r.interval === 'yearly' && r.dodoProductId);

  const monthly: PriceView | null = m
    ? { priceCents: m.priceCents, currency: m.currency, amount: fmt(m.priceCents, m.currency), period: '/mo' }
    : null;
  const yearly: PriceView | null = y
    ? { priceCents: y.priceCents, currency: y.currency, amount: fmt(y.priceCents, y.currency), period: '/yr' }
    : null;

  let yearlySavingsPct = 0;
  if (monthly && yearly) {
    const fullYear = monthly.priceCents * 12;
    if (fullYear > 0 && yearly.priceCents < fullYear) {
      yearlySavingsPct = Math.round((1 - yearly.priceCents / fullYear) * 100);
    }
  }

  return { configured: Boolean(monthly), monthly, yearly, yearlySavingsPct };
}

/** Dodo product id for a paid (plan, interval), or null if no active synced plan. */
export async function resolveProductId(plan: PlanId, interval: Interval): Promise<string | null> {
  if (plan !== 'pro') return null;
  const row = await prisma.plan.findUnique({ where: { interval } });
  return row && row.active ? row.dodoProductId : null;
}

/** Map a Dodo product id back to our (plan, interval). Defaults to pro/monthly. */
export async function productToPlan(
  productId: string | null | undefined,
): Promise<{ plan: PlanId; interval: Interval }> {
  if (productId) {
    const row = await prisma.plan.findUnique({ where: { dodoProductId: productId } });
    if (row) return { plan: 'pro', interval: row.interval as Interval };
  }
  return { plan: 'pro', interval: 'monthly' };
}

function buildRecurringPrice(input: Required<Pick<PlanInput, 'interval' | 'priceCents'>> & { currency: string }) {
  const unit = DODO_INTERVAL[input.interval];
  return {
    type: 'recurring_price' as const,
    currency: input.currency,
    discount: 0,
    price: input.priceCents,
    purchasing_power_parity: false,
    payment_frequency_count: 1,
    payment_frequency_interval: unit,
    subscription_period_count: 1,
    subscription_period_interval: unit,
  };
}

/**
 * Upsert a plan locally and sync it to Dodo:
 *  - no Dodo product yet → create one and store its product_id
 *  - already linked    → update the existing Dodo product in place
 * Returns the saved Plan row.
 */
export async function upsertAndSyncPlan(input: PlanInput): Promise<Plan> {
  const currency = input.currency ?? 'USD';
  const taxCategory = input.taxCategory ?? 'saas';

  // 1) Persist locally first (so the catalog reflects intent even if Dodo lags).
  const existing = await prisma.plan.findUnique({ where: { interval: input.interval } });
  const saved = await prisma.plan.upsert({
    where: { interval: input.interval },
    create: {
      interval: input.interval,
      name: input.name,
      description: input.description ?? null,
      priceCents: input.priceCents,
      currency,
      taxCategory,
    },
    update: {
      name: input.name,
      description: input.description ?? null,
      priceCents: input.priceCents,
      currency,
      taxCategory,
    },
  });

  // 2) Sync to Dodo.
  const price = buildRecurringPrice({ interval: input.interval, priceCents: input.priceCents, currency });
  let productId = existing?.dodoProductId ?? null;

  if (productId) {
    await dodo.products.update(productId, {
      name: saved.name,
      description: saved.description,
      price,
      tax_category: taxCategory,
    } as Parameters<typeof dodo.products.update>[1]);
  } else {
    const product = await dodo.products.create({
      name: saved.name,
      description: saved.description ?? undefined,
      price,
      tax_category: taxCategory,
    } as Parameters<typeof dodo.products.create>[0]);
    productId = (product as { product_id: string }).product_id;
  }

  // 3) Store the link.
  return prisma.plan.update({
    where: { id: saved.id },
    data: { dodoProductId: productId, active: true },
  });
}

/** Archive a plan in Dodo and deactivate it locally (keeps existing subs intact). */
export async function archivePlan(interval: Interval): Promise<void> {
  const row = await prisma.plan.findUnique({ where: { interval } });
  if (!row) return;
  if (row.dodoProductId) {
    await dodo.products.archive(row.dodoProductId).catch(() => {/* already archived */});
  }
  await prisma.plan.update({ where: { id: row.id }, data: { active: false } });
}
