import type { APIRoute } from 'astro';
import { auth } from '../../lib/auth';

export const prerender = false;

// Sets a password for the currently signed-in user who doesn't have one yet
// (e.g. just completed passwordless OTP signup). Uses Better Auth's server-only
// setPassword endpoint, which requires a fresh session.
export const POST: APIRoute = async ({ request }) => {
  let newPassword = '';
  try {
    const body = await request.json();
    newPassword = String(body?.password || '');
  } catch {
    /* ignore */
  }

  if (newPassword.length < 8) {
    return json({ error: 'Password must be at least 8 characters.' }, 400);
  }

  try {
    await auth.api.setPassword({ body: { newPassword }, headers: request.headers });
    return json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Could not set the password.';
    return json({ error: msg }, 400);
  }
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
