// Shared reverse-proxy core used by the proxy middleware. Fetches an upstream
// URL, neutralises framing headers, and rewrites SAME-ORIGIN resource URLs so
// they load through us at a path that mirrors the real one — e.g.
// `/assets/app.js?__vphost=https://site.com`. Mirroring the path matters: SPA
// routers branch on `location.pathname`, so the iframe must look like the real
// page (`/`) rather than a proxy endpoint, or the app renders its own 404.
// Cross-origin assets are left untouched (they load directly — no extra hop).
// Responses are cached + de-duplicated so loading one URL across several device
// panes only hits the network once.

export const VPHOST = '__vphost';

// Proxied upstream cookies are stored on OUR origin (the response comes from us).
// To stop them colliding with the app's own cookies — Better-Auth session,
// `vp_ref`, etc. — and to avoid leaking those app cookies back to the third-party
// upstream, every upstream cookie name is prefixed with this on the way out and
// the prefix is stripped (and everything else dropped) on the way back in.
const COOKIE_PREFIX = '__vp_';

const STRIP_RES_HEADERS = new Set([
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'referrer-policy', // keep full-URL referer so subresources can find their origin
  'transfer-encoding',
  'content-encoding', // fetch auto-decompresses
  'content-length', // wrong once we rewrite / decompress the body
  'connection',
  'keep-alive',
  'set-cookie', // handled separately: re-scoped + namespaced, see rescopeCookies
  // Caching/revalidation headers from the upstream must never reach a shared CDN
  // (Vercel's edge): the proxied URL isn't a stable static asset, and a single
  // transient upstream 404 forwarded with `immutable` would get frozen at the
  // edge and served to everyone. We set our own `cache-control` below instead.
  'cache-control',
  'etag',
  'expires',
  'last-modified',
  'age',
  'pragma',
]);

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const TTL_MS = 60_000;
const MAX_ENTRIES = 150;
// Don't buffer giant binaries (video etc.) into the cache.
const MAX_CACHE_BYTES = 12 * 1024 * 1024;

export type ProxyEntry = {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  expires: number;
  // Set-Cookie values (re-scoped + namespaced) to forward to the browser. Kept
  // out of `headers` because there can be several and they must not be cached.
  setCookie?: string[];
};

export type FetchOpts = {
  method?: string;
  cookie?: string | null; // already-extracted upstream cookies (see extractProxyCookies)
  body?: Uint8Array | null;
  contentType?: string | null;
};

/**
 * From the browser's Cookie header, pick only the cookies we previously set for
 * a proxied upstream (the `__vp_`-prefixed ones), strip the prefix, and rebuild
 * a Cookie string to send upstream. App cookies (Better-Auth, vp_ref) are left
 * behind so they never reach the third-party site.
 */
export function extractProxyCookies(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  const out: string[] = [];
  for (const part of cookieHeader.split(';')) {
    const seg = part.trim();
    const eq = seg.indexOf('=');
    if (eq <= 0) continue;
    const name = seg.slice(0, eq);
    if (name.startsWith(COOKIE_PREFIX)) {
      out.push(`${name.slice(COOKIE_PREFIX.length)}=${seg.slice(eq + 1)}`);
    }
  }
  return out.length ? out.join('; ') : null;
}

/**
 * Turn upstream Set-Cookie headers into values safe to set on our origin: drop
 * the `Domain` attribute (so the cookie binds to our proxy host) and namespace
 * the cookie name with `COOKIE_PREFIX`.
 */
function rescopeCookies(headers: Headers): string[] {
  const getSetCookie = (headers as { getSetCookie?: () => string[] }).getSetCookie;
  const raw = typeof getSetCookie === 'function'
    ? getSetCookie.call(headers)
    : (headers.get('set-cookie') ? [headers.get('set-cookie') as string] : []);
  return raw.map((c) => `${COOKIE_PREFIX}${c.replace(/;\s*domain=[^;]*/gi, '')}`);
}

const cache = new Map<string, ProxyEntry>();
const inflight = new Map<string, Promise<ProxyEntry>>();

const enc = (s: string) => new TextEncoder().encode(s);

const injectedScrollbarStyle = `<style data-viewport-scrollbar>
  html[data-viewport-proxy-scrollbars],
  html[data-viewport-proxy-scrollbars] body,
  html[data-viewport-proxy-scrollbars] * {
    scrollbar-width: thin !important;
    scrollbar-color: rgb(113 113 122 / 0.8) transparent !important;
  }
  html[data-viewport-proxy-scrollbars]::-webkit-scrollbar,
  html[data-viewport-proxy-scrollbars] body::-webkit-scrollbar,
  html[data-viewport-proxy-scrollbars] *::-webkit-scrollbar {
    width: 6px !important;
    height: 6px !important;
  }
  html[data-viewport-proxy-scrollbars]::-webkit-scrollbar-track,
  html[data-viewport-proxy-scrollbars] body::-webkit-scrollbar-track,
  html[data-viewport-proxy-scrollbars] *::-webkit-scrollbar-track {
    background: transparent !important;
  }
  html[data-viewport-proxy-scrollbars]::-webkit-scrollbar-thumb,
  html[data-viewport-proxy-scrollbars] body::-webkit-scrollbar-thumb,
  html[data-viewport-proxy-scrollbars] *::-webkit-scrollbar-thumb {
    background: rgb(113 113 122 / 0.8) !important;
    border-radius: 999px !important;
    border: 0 !important;
  }
  html[data-viewport-proxy-scrollbars]::-webkit-scrollbar-thumb:hover,
  html[data-viewport-proxy-scrollbars] body::-webkit-scrollbar-thumb:hover,
  html[data-viewport-proxy-scrollbars] *::-webkit-scrollbar-thumb:hover {
    background: rgb(82 82 91 / 0.95) !important;
  }
</style>`;

/** Map a same-origin absolute URL to a path-mirroring proxy URL. */
function proxied(abs: string): string {
  try {
    const a = new URL(abs);
    const params = new URLSearchParams(a.search);
    params.set(VPHOST, a.origin);
    return `${a.pathname}?${params.toString()}${a.hash}`;
  } catch {
    return abs;
  }
}

/**
 * Resolve `ref` against `base`, then decide how to serve it:
 * same origin → mirror through us; cross origin → leave as a direct absolute
 * URL; unresolvable → leave untouched.
 */
function mapRef(ref: string, base: string, baseOrigin: string): string | null {
  let abs: URL;
  try {
    abs = new URL(ref, base);
  } catch {
    return null;
  }
  return abs.origin === baseOrigin ? proxied(abs.href) : abs.href;
}

function rewriteCssUrls(s: string, base: string, baseOrigin: string): string {
  return s.replace(/url\(\s*("|'|)([^"')]+)\1\s*\)/gi, (m, q, raw) => {
    const v = raw.trim();
    if (!v || /^(data:|blob:|#)/i.test(v)) return m;
    const mapped = mapRef(v, base, baseOrigin);
    return mapped ? `url(${q}${mapped}${q})` : m;
  });
}

function rewriteCss(css: string, base: string): string {
  const baseOrigin = new URL(base).origin;
  css = css.replace(/@import\s+("|')([^"']+)\1/gi, (m, q, u) => {
    const mapped = mapRef(u, base, baseOrigin);
    return mapped ? `@import ${q}${mapped}${q}` : m;
  });
  return rewriteCssUrls(css, base, baseOrigin);
}

function rewriteHtml(html: string, base: string): string {
  const baseOrigin = new URL(base).origin;

  // Drop <base> (we resolve URLs ourselves) and SRI/crossorigin attributes:
  // rewritten bodies won't match the original hashes and shouldn't be forced
  // into CORS mode.
  html = html.replace(/<base\b[^>]*>/gi, '');
  html = html.replace(/\s+integrity\s*=\s*("|')[^"']*\1/gi, '');
  
  html = html.replace(/<html\b(?![^>]*\bdata-viewport-proxy-scrollbars\b)([^>]*)>/i, '<html data-viewport-proxy-scrollbars$1>');

  // Force a full-URL referer so JS-created subresources carry __vphost.
  html = html.replace(/<meta[^>]+name=["']?referrer["']?[^>]*>/gi, '');
  const referrerMeta = '<meta name="referrer" content="unsafe-url">';
  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head[^>]*>/i, (m) => m + referrerMeta);
    html = /<\/head>/i.test(html)
      ? html.replace(/<\/head>/i, injectedScrollbarStyle + '</head>')
      : html + injectedScrollbarStyle;
  } else {
    html = referrerMeta + injectedScrollbarStyle + html;
  }

  // srcset: rewrite each candidate URL, preserve descriptors.
  html = html.replace(/\bsrcset\s*=\s*("|')([^"']*)\1/gi, (_m, q, val) => {
    const out = val
      .split(',')
      .map((part: string) => {
        const seg = part.trim();
        if (!seg) return part;
        const bits = seg.split(/\s+/);
        const mapped = mapRef(bits[0], base, baseOrigin);
        if (!mapped) return part;
        bits[0] = mapped;
        return bits.join(' ');
      })
      .join(', ');
    return `srcset=${q}${out}${q}`;
  });

  // src / href / poster / action / data-src.
  html = html.replace(
    /\b(src|href|poster|action|data-src)\s*=\s*("|')([^"']*)\2/gi,
    (m, attr, q, val) => {
      const v = val.trim();
      if (!v || /^(data:|blob:|#|mailto:|tel:|javascript:)/i.test(v)) return m;
      const mapped = mapRef(v, base, baseOrigin);
      return mapped ? `${attr}=${q}${mapped}${q}` : m;
    }
  );

  // Inline <style> blocks and style="" attributes.
  return rewriteCssUrls(html, base, baseOrigin);
}

async function build(target: string, opts: FetchOpts = {}): Promise<ProxyEntry> {
  const method = (opts.method ?? 'GET').toUpperCase();
  const reqHeaders: Record<string, string> = {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  if (opts.cookie) reqHeaders.Cookie = opts.cookie;
  if (opts.contentType) reqHeaders['Content-Type'] = opts.contentType;

  const upstream = await fetch(target, {
    method,
    headers: reqHeaders,
    body: method === 'GET' || method === 'HEAD' ? undefined : (opts.body as BodyInit | undefined) ?? undefined,
    // Manual: login flows answer with a 3xx + Set-Cookie. `follow` would swallow
    // the cookie on the intermediate hop, so we re-emit the redirect ourselves
    // (Location rewritten through the proxy) and let the browser store the cookie.
    redirect: 'manual',
  });

  const setCookie = rescopeCookies(upstream.headers);

  // Re-emit redirects through the proxy so the iframe never leaves our origin.
  if (upstream.status >= 300 && upstream.status < 400 && upstream.headers.has('location')) {
    const loc = upstream.headers.get('location') as string;
    let location = loc;
    try {
      location = proxied(new URL(loc, target).href);
    } catch {
      /* unparseable Location — pass through untouched */
    }
    return {
      status: upstream.status,
      headers: { location, 'cache-control': 'no-store' },
      body: new Uint8Array(),
      expires: 0,
      setCookie,
    };
  }

  const ct = upstream.headers.get('content-type') ?? '';
  const headers: Record<string, string> = {};
  for (const [k, v] of upstream.headers) {
    if (!STRIP_RES_HEADERS.has(k.toLowerCase())) headers[k] = v;
  }
  // Allow framing only from our own origin.
  headers['x-frame-options'] = 'SAMEORIGIN';
  headers['content-security-policy'] = "frame-ancestors 'self'";
  headers['Access-Control-Allow-Origin'] = '*';
  // Keep proxied responses out of any shared/CDN cache. The browser may still
  // cache successful subresources for the session; errors are never stored, so a
  // transient upstream failure can't get frozen and re-served.
  headers['cache-control'] =
    upstream.status >= 400 ? 'no-store' : 'private, max-age=0, must-revalidate';

  const base = upstream.url || target;
  const isHtml = ct.includes('text/html');
  let body: Uint8Array;

  if (isHtml) {
    body = enc(rewriteHtml(await upstream.text(), base));
    headers['content-type'] = 'text/html; charset=utf-8';
  } else if (ct.includes('css')) {
    body = enc(rewriteCss(await upstream.text(), base));
  } else {
    body = new Uint8Array(await upstream.arrayBuffer());
  }

  // Some hosts (regional CDN/cache skew, misconfigured SPA backends) serve a
  // subresource's real bytes but with an error status. Browsers discard module
  // scripts and stylesheets that arrive non-2xx, even when the body is valid,
  // which leaves the framed SPA blank. For a visual testing proxy we'd rather
  // render: if a non-HTML resource came back with a body but an error status,
  // normalise it to 200. The HTML document keeps its true status so real
  // navigation / SPA routing isn't masked.
  const status =
    !isHtml && upstream.status >= 400 && body.byteLength > 0 ? 200 : upstream.status;

  return { status, headers, body, expires: Date.now() + TTL_MS, setCookie };
}

/**
 * Fetch + transform an upstream URL, served from an in-memory TTL cache.
 * Concurrent requests for the same URL share a single upstream fetch.
 *
 * Only plain GETs with no forwarded cookie are cacheable — anything carrying a
 * session, or any non-GET, is fetched fresh and never shared (its response is
 * user-specific and may carry Set-Cookie).
 */
export function fetchSite(target: string, opts: FetchOpts = {}): Promise<ProxyEntry> {
  const method = (opts.method ?? 'GET').toUpperCase();
  const cacheable = method === 'GET' && !opts.cookie;
  if (!cacheable) return build(target, opts);

  const hit = cache.get(target);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit);

  const pending = inflight.get(target);
  if (pending) return pending;

  const p = build(target, opts)
    .then((entry) => {
      // Never cache a response that sets cookies — it's session-establishing.
      if (entry.status < 400 && !entry.setCookie?.length && entry.body.byteLength <= MAX_CACHE_BYTES) {
        cache.set(target, entry);
        if (cache.size > MAX_ENTRIES) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
      }
      inflight.delete(target);
      return entry;
    })
    .catch((err) => {
      inflight.delete(target);
      throw err;
    });

  inflight.set(target, p);
  return p;
}

export function errorPage(title: string, detail: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{font-family:system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;gap:10px;background:#0d1117;color:#e6edf3;padding:2rem;text-align:center}
    svg{opacity:.5}h2{margin:0;font-size:.95rem;font-weight:600}p{margin:0;font-size:.8rem;color:#8b949e;max-width:32ch}code{font-size:.75rem;background:#161b22;border:1px solid #30363d;border-radius:4px;padding:2px 6px;word-break:break-all}
  </style></head><body>
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#58a6ff" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
    <h2>${title}</h2><p>${detail}</p>
  </body></html>`;
}
