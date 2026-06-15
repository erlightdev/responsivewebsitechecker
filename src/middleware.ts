import { defineMiddleware, sequence } from 'astro:middleware';
import { fetchSite, errorPage, extractProxyCookies, VPHOST } from './lib/proxy-core';
import { auth } from './lib/auth';
import { prisma } from './lib/prisma';
import { isProUser } from './lib/payments/subscription';

// 1) Reverse-proxy for the responsive checker. A proxied request is identified by
// a `__vphost=<origin>` marker — either on the request itself (the document and
// rewritten subresources) or, for resources the page builds at runtime (e.g. a
// SPA bundle inserting `<img src="/assets/logo.png">`), on the Referer. The
// request path mirrors the real path, so we just recombine it with the origin.
// Our own app never sets the marker, so its requests fall straight through.
// Vite/Astro dev-server internals (`/@id/…`, `/@vite/…`, `/@fs/…`, HMR client).
// These must always be served by the dev server, never proxied — when a proxied
// page is in the iframe its `referer` carries __vphost, which would otherwise
// make us fetch the dev-toolbar module from the remote origin (corrupted MIME).
const isDevInternal = (p: string) => p.startsWith('/@') || p.startsWith('/node_modules/');

// Remembers the origin of the site currently being previewed. Lets subresources
// that arrive with NEITHER a __vphost marker NOR a usable Referer (e.g. images a
// SPA loads with referrerpolicy="no-referrer") still resolve to the right upstream
// instead of 404ing against our own origin. The checker previews one URL at a time
// across all device panes, so a single cookie is sufficient. Its name must NOT
// start with the `__vp_` upstream-cookie prefix, or it'd be forwarded to the
// third-party site (see extractProxyCookies).
const PROXY_ORIGIN_COOKIE = 'vp_proxy_origin';

// The remembered origin is only used for genuine static subresources — never for
// top-level navigations (`document`) or app data fetches (`empty`/`cors`), so the
// webapp's own pages and API calls always stay on the webapp.
const SUBRESOURCE_DEST = new Set([
  'image', 'script', 'style', 'font', 'audio', 'video', 'track', 'manifest', 'object', 'embed',
]);

function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const seg = part.trim();
    const eq = seg.indexOf('=');
    if (eq <= 0) continue;
    if (seg.slice(0, eq) === name) return decodeURIComponent(seg.slice(eq + 1));
  }
  return null;
}

const proxy = defineMiddleware(async ({ request }, next) => {
  const url = new URL(request.url);
  if (isDevInternal(url.pathname)) return next();

  // Cloudflare injects RUM/analytics beacons that POST to /cdn-cgi/* with no
  // __vphost marker, so they 404 against our origin and spam the console.
  // They only exist on Cloudflare's edge — swallow them silently.
  if (url.pathname.startsWith('/cdn-cgi/')) return new Response(null, { status: 204 });

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
  if (!originRaw) {
    // No marker on the URL or Referer. If this is a static subresource of the
    // previewed page — not an app navigation/API call, and not one of the
    // webapp's own asset paths — resolve it against the remembered origin (the
    // URL the user typed in the checker) instead of letting it 404 on us.
    const dest = request.headers.get('sec-fetch-dest') ?? '';
    const appOwned = url.pathname.startsWith('/_') || url.pathname.startsWith('/favicon');
    if (SUBRESOURCE_DEST.has(dest) && !appOwned) {
      originRaw = readCookie(request.headers.get('cookie'), PROXY_ORIGIN_COOKIE);
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

  const method = request.method;
  // Forward the request body for form submissions / API calls (e.g. a login POST).
  const body =
    method === 'GET' || method === 'HEAD'
      ? null
      : new Uint8Array(await request.arrayBuffer());

  try {
    const entry = await fetchSite(target, {
      method,
      // Only the upstream's own (namespaced) cookies are forwarded — the app's
      // session cookies are filtered out so they never reach the third party.
      cookie: extractProxyCookies(request.headers.get('cookie')),
      body,
      contentType: request.headers.get('content-type'),
    });
    
    const headers = new Headers(entry.headers);

    // FIX 1: Remove clickjacking headers so auth screens can be rendered inside the iframe initially
    headers.delete('x-frame-options');
    headers.delete('content-security-policy');

    // FIX 2: Ensure session/auth cookies work inside the cross-origin iframe
    for (const c of entry.setCookie ?? []) {
      let cookie = c;
      // Force SameSite=None and Secure for iframe compatibility
      if (/SameSite=(Lax|Strict)/i.test(cookie)) {
        cookie = cookie.replace(/SameSite=(Lax|Strict)/ig, 'SameSite=None');
      } else if (!/SameSite=/i.test(cookie)) {
        cookie += '; SameSite=None';
      }
      if (!/Secure/i.test(cookie)) {
        cookie += '; Secure';
      }
      headers.append('set-cookie', cookie);
    }

    // FIX 3: Break out of the iframe for external Auth/Payment redirects
    if ([301, 302, 303, 307, 308].includes(entry.status)) {
      const location = headers.get('location');
      if (location) {
        try {
          const locUrl = new URL(location, target);
          const targetUrl = new URL(target);
          
          // Check if redirecting to a third-party service (e.g., Stripe, PayPal, Auth0)
          if (locUrl.hostname !== targetUrl.hostname && !locUrl.hostname.endsWith('.' + targetUrl.hostname)) {
            const dest = request.headers.get('sec-fetch-dest');
            const accept = request.headers.get('accept') || '';
            
            // Only break out for actual top-level navigations (ignore API 'fetch' calls)
            if (dest === 'document' || dest === 'iframe' || accept.includes('text/html')) {
              return new Response(
                `<!DOCTYPE html>
                <html>
                  <head><title>Redirecting securely...</title></head>
                  <body>
                    <script>
                      // Break out of the responsive tester to safely complete auth/payment
                      window.top.location.href = ${JSON.stringify(locUrl.href)};
                    </script>
                    <noscript>
                      <a href="${locUrl.href}" target="_top">Click here to continue to ${locUrl.hostname}</a>
                    </noscript>
                  </body>
                </html>`,
                {
                  status: 200,
                  headers: { 'content-type': 'text/html; charset=utf-8' }
                }
              );
            }
          }
        } catch {
          // Malformed Location URL, ignore and fall through to standard proxying
        }
      }
    }

    // On a freshly-loaded preview document, remember its origin so the page's
    // referer-less subresources can resolve to it (see the cookie fallback above).
    if (own && (entry.headers['content-type'] ?? '').includes('text/html')) {
      headers.append(
        'set-cookie',
        // Also updated to SameSite=None; Secure so the fallback cookie reliably works in iframes
        `${PROXY_ORIGIN_COOKIE}=${encodeURIComponent(origin)}; Path=/; Max-Age=86400; SameSite=None; Secure; HttpOnly`
      );
    }
    
    return new Response(entry.body as BodyInit, { status: entry.status, headers });
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