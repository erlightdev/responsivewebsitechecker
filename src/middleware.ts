import { defineMiddleware, sequence } from 'astro:middleware';
import { fetchSite, errorPage, VPHOST } from './lib/proxy-core';
import { auth } from './lib/auth';
import { prisma } from './lib/prisma';
import { isProUser } from './lib/payments/subscription';

// 1) Reverse-proxy for the responsive checker. A proxied request is identified by
// a `__vphost=<origin>` marker — either on the request itself (the document and
// rewritten subresources) or, for resources the page builds at runtime (e.g. a
// SPA bundle inserting `<img src="/assets/logo.png">`), on the Referer. The
// request path mirrors the real path, so we just recombine it with the origin.
// Our own app never sets the marker, so its requests fall straight through.
const proxy = defineMiddleware(async ({ request }, next) => {
  if (request.method !== 'GET') return next();

  const url = new URL(request.url);
  const own = url.searchParams.get(VPHOST);

  let originRaw = own;
  if (!originRaw) {
    const referer = request.headers.get('referer');
    if (referer) {
      try {
        originRaw = new URL(referer).searchParams.get(VPHOST);
      } catch {
        /* malformed referer — ignore */
      }
    }
  }
  if (!originRaw) return next();

  let origin: string;
  try {
    const o = new URL(originRaw);
    if (o.protocol !== 'http:' && o.protocol !== 'https:') return next();
    origin = o.origin;
  } catch {
    return next();
  }

  const params = new URLSearchParams(url.search);
  params.delete(VPHOST);
  const qs = params.toString();
  const target = origin + url.pathname + (qs ? `?${qs}` : '');

  try {
    const entry = await fetchSite(target);
    return new Response(entry.body, { status: entry.status, headers: entry.headers });
  } catch (e) {
    // Only the document/subresource we explicitly proxied gets an error page;
    // referer-only guesses just fall through to a normal 404.
    if (!own) return next();
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(errorPage('Failed to fetch', msg), {
      status: 502,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }
});

// 2) Auth gating. Public marketing + auth pages stay open; the app is gated.
const PUBLIC_PATHS = new Set(['/', '/login', '/signup', '/forgot-password', '/reset-password']);
// Path → resource key for per-user resource flags.
const RESOURCE_BY_PREFIX: Array<[string, string]> = [
  ['/captures', 'captures'],
  ['/workspaces', 'workspaces'],
  ['/social', 'social'],
  ['/checker', 'checker'],
];

const isPublic = (p: string) =>
  PUBLIC_PATHS.has(p) ||
  p.startsWith('/api/auth') ||
  p === '/api/auth-method' ||
  // Payments endpoints enforce their own auth: webhook verifies a signature,
  // checkout requires a session inside the handler. Skip the redirect gate.
  p.startsWith('/api/payments') ||
  p.startsWith('/_') ||
  p.startsWith('/favicon') ||
  /\.[a-z0-9]+$/i.test(p); // static assets

const authGate = defineMiddleware(async (context, next) => {
  const { request, url } = context;
  const path = url.pathname;

  // Proxied subresource requests carry the marker — never gate those.
  if (url.searchParams.has(VPHOST) || request.headers.get('referer')?.includes(VPHOST)) {
    return next();
  }

  // Invite & earn: remember a referral code from the link (?ref=CODE) so it can be
  // attributed when the visitor later signs up. Short-lived, harmless if unused.
  const ref = url.searchParams.get('ref');
  if (ref && /^[A-Z0-9]{4,16}$/i.test(ref)) {
    context.cookies.set('vp_ref', ref.toUpperCase(), {
      path: '/',
      maxAge: 60 * 60 * 24 * 30, // 30 days
      httpOnly: true,
      sameSite: 'lax',
    });
  }

  const session = await auth.api.getSession({ headers: request.headers });
  const user = (session?.user ?? null) as App.Locals['user'];
  context.locals.user = user;

  if (isPublic(path)) {
    // Already signed in → bounce away from auth screens to the app.
    if (user && ['/login', '/signup'].includes(path)) {
      return context.redirect('/checker');
    }
    return next();
  }

  // The checker is open to guests (free 3-screen preview). Signed-in users still
  // get the ban + per-resource checks; the screen cap itself is applied in the UI.
  if (path === '/checker' || path.startsWith('/checker/')) {
    if (user?.banned) return context.redirect('/login?error=banned');
    if (user && user.role !== 'superadmin') {
      const flag = await prisma.resourceFlag.findUnique({
        where: { userId_resource: { userId: user.id, resource: 'checker' } },
        select: { allowed: true },
      });
      if (flag && !flag.allowed) return context.redirect('/account?error=restricted');
    }
    return next();
  }

  // Gated from here on.
  if (!user) {
    return context.redirect(`/login?next=${encodeURIComponent(path)}`);
  }

  if (user.banned) {
    return context.redirect('/login?error=banned');
  }

  // Superadmin area.
  if (path.startsWith('/admin')) {
    if (user.role !== 'superadmin') return new Response('Not found', { status: 404 });
    return next();
  }

  // Pro-only features (Social preview + Captures). Access for superadmin or an
  // active paid Pro subscription; everyone else is bounced back.
  const PRO_PREFIXES = ['/social', '/captures'];
  if (PRO_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) {
    const entitled = user.role === 'superadmin' || (await isProUser(user.id));
    if (!entitled) return context.redirect('/checker?error=pro');
  }

  // Per-resource restriction (superadmin bypasses all flags).
  if (user.role !== 'superadmin') {
    const match = RESOURCE_BY_PREFIX.find(([prefix]) => path.startsWith(prefix));
    if (match) {
      const flag = await prisma.resourceFlag.findUnique({
        where: { userId_resource: { userId: user.id, resource: match[1] } },
        select: { allowed: true },
      });
      if (flag && !flag.allowed) {
        return context.redirect('/checker?error=restricted');
      }
    }
  }

  return next();
});

export const onRequest = sequence(proxy, authGate);
