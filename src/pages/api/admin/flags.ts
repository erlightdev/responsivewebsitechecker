import type { APIRoute } from 'astro';
import { auth } from '../../../lib/auth';
import { prisma } from '../../../lib/prisma';

export const prerender = false;

const RESOURCES = ['checker', 'captures', 'workspaces', 'social'];

async function requireSuperadmin(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  const user = session?.user as { id: string; role?: string | null } | undefined;
  return user?.role === 'superadmin' ? user : null;
}

// GET ?userId= → current flags for a user (missing = allowed)
export const GET: APIRoute = async ({ request, url }) => {
  if (!(await requireSuperadmin(request))) return new Response('Forbidden', { status: 403 });
  const userId = url.searchParams.get('userId');
  if (!userId) return json({ error: 'userId required' }, 400);
  const flags = await prisma.resourceFlag.findMany({ where: { userId }, select: { resource: true, allowed: true } });
  const map: Record<string, boolean> = {};
  RESOURCES.forEach((r) => (map[r] = true));
  flags.forEach((f) => (map[f.resource] = f.allowed));
  return json({ flags: map });
};

// POST { userId, resource, allowed } → upsert a flag
export const POST: APIRoute = async ({ request }) => {
  if (!(await requireSuperadmin(request))) return new Response('Forbidden', { status: 403 });
  let body: { userId?: string; resource?: string; allowed?: boolean } = {};
  try {
    body = await request.json();
  } catch {
    /* ignore */
  }
  const { userId, resource, allowed } = body;
  if (!userId || !resource || !RESOURCES.includes(resource) || typeof allowed !== 'boolean') {
    return json({ error: 'invalid payload' }, 400);
  }
  await prisma.resourceFlag.upsert({
    where: { userId_resource: { userId, resource } },
    create: { userId, resource, allowed },
    update: { allowed },
  });
  return json({ ok: true });
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
