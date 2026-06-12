import { defineMiddleware } from 'astro:middleware';
import { fetchSite, errorPage, VPHOST } from './lib/proxy-core';

// Reverse-proxy for the responsive checker. A proxied request is identified by
// a `__vphost=<origin>` marker — either on the request itself (the document and
// rewritten subresources) or, for resources the page builds at runtime (e.g. a
// SPA bundle inserting `<img src="/assets/logo.png">`), on the Referer. The
// request path mirrors the real path, so we just recombine it with the origin.
// Our own app never sets the marker, so its requests fall straight through.
export const onRequest = defineMiddleware(async ({ request }, next) => {
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
