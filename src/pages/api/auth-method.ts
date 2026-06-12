import type { APIRoute } from 'astro';
import { prisma } from '../../lib/prisma';

export const prerender = false;

// Email-first login: given an email, report whether an account exists, whether
// it's verified, and which sign-in methods are wired up (credential/github/google)
// so the login screen can show the right step.
export const POST: APIRoute = async ({ request }) => {
  let email = '';
  try {
    const body = await request.json();
    email = String(body?.email || '').trim().toLowerCase();
  } catch {
    /* ignore */
  }

  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(email)) {
    return json({ error: 'invalid_email' }, 400);
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { emailVerified: true, accounts: { select: { providerId: true } } },
  });

  if (!user) return json({ exists: false, verified: false, methods: [] });

  const methods = [...new Set(user.accounts.map((a) => a.providerId))].filter((p) =>
    ['credential', 'github', 'google'].includes(p)
  );

  return json({ exists: true, verified: user.emailVerified, methods });
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
