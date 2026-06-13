// Admin plans API (superadmin only). Lets a superadmin author the Pro plans in
// the app; each save creates/updates the matching Dodo Payments product via API.
import type { APIRoute } from 'astro';
import { auth } from '../../../lib/auth';
import { isPaymentsConfigured } from '../../../lib/payments/dodo';
import { listPlans, upsertAndSyncPlan, archivePlan } from '../../../lib/payments/plan-store';

export const prerender = false;

const INTERVALS = new Set(['monthly', 'yearly']);
const TAX = new Set(['saas', 'digital_products', 'e_book', 'edtech']);

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

async function requireSuperadmin(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  const user = session?.user as { id: string; role?: string | null } | undefined;
  return user?.role === 'superadmin' ? user : null;
}

export const GET: APIRoute = async ({ request }) => {
  if (!(await requireSuperadmin(request))) return new Response('Forbidden', { status: 403 });
  return json({ plans: await listPlans() });
};

// POST { interval, name, priceCents, currency?, taxCategory?, description? } → upsert + sync to Dodo
export const POST: APIRoute = async ({ request }) => {
  if (!(await requireSuperadmin(request))) return new Response('Forbidden', { status: 403 });
  if (!isPaymentsConfigured) return json({ error: 'payments_not_configured' }, 503);

  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    /* ignore */
  }

  const interval = String(body.interval ?? '');
  const name = String(body.name ?? '').trim();
  const priceCents = Number(body.priceCents);
  const currency = body.currency ? String(body.currency).toUpperCase() : 'USD';
  const taxCategory = body.taxCategory ? String(body.taxCategory) : 'saas';
  const description = body.description ? String(body.description) : null;

  if (!INTERVALS.has(interval)) return json({ error: 'invalid interval' }, 400);
  if (!name) return json({ error: 'name required' }, 400);
  if (!Number.isInteger(priceCents) || priceCents <= 0) return json({ error: 'priceCents must be a positive integer' }, 400);
  if (!TAX.has(taxCategory)) return json({ error: 'invalid taxCategory' }, 400);

  try {
    const plan = await upsertAndSyncPlan({
      interval: interval as 'monthly' | 'yearly',
      name,
      priceCents,
      currency,
      taxCategory: taxCategory as 'saas' | 'digital_products' | 'e_book' | 'edtech',
      description,
    });
    return json({ ok: true, plan });
  } catch (err) {
    console.error('[admin/plans] sync failed:', err);
    return json({ error: 'sync_failed', message: err instanceof Error ? err.message : 'unknown' }, 502);
  }
};

// DELETE ?interval=monthly → archive in Dodo + deactivate locally
export const DELETE: APIRoute = async ({ request, url }) => {
  if (!(await requireSuperadmin(request))) return new Response('Forbidden', { status: 403 });
  const interval = url.searchParams.get('interval') ?? '';
  if (!INTERVALS.has(interval)) return json({ error: 'invalid interval' }, 400);
  try {
    await archivePlan(interval as 'monthly' | 'yearly');
    return json({ ok: true });
  } catch (err) {
    console.error('[admin/plans] archive failed:', err);
    return json({ error: 'archive_failed' }, 502);
  }
};
