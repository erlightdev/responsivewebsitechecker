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
  'set-cookie',
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
};

const cache = new Map<string, ProxyEntry>();
const inflight = new Map<string, Promise<ProxyEntry>>();

const enc = (s: string) => new TextEncoder().encode(s);

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
  html = html.replace(/\s+crossorigin(\s*=\s*("|')[^"']*\2)?/gi, '');

  // Force a full-URL referer so JS-created subresources carry __vphost.
  html = html.replace(/<meta[^>]+name=["']?referrer["']?[^>]*>/gi, '');
  const referrerMeta = '<meta name="referrer" content="unsafe-url">';
  html = /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (m) => m + referrerMeta)
    : referrerMeta + html;

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

async function build(target: string): Promise<ProxyEntry> {
  const upstream = await fetch(target, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
  });

  const ct = upstream.headers.get('content-type') ?? '';
  const headers: Record<string, string> = {};
  for (const [k, v] of upstream.headers) {
    if (!STRIP_RES_HEADERS.has(k.toLowerCase())) headers[k] = v;
  }
  // Allow framing only from our own origin.
  headers['x-frame-options'] = 'SAMEORIGIN';
  headers['content-security-policy'] = "frame-ancestors 'self'";

  const base = upstream.url || target;
  let body: Uint8Array;

  if (ct.includes('text/html')) {
    body = enc(rewriteHtml(await upstream.text(), base));
    headers['content-type'] = 'text/html; charset=utf-8';
  } else if (ct.includes('css')) {
    body = enc(rewriteCss(await upstream.text(), base));
  } else {
    body = new Uint8Array(await upstream.arrayBuffer());
    if (!headers['cache-control']) headers['cache-control'] = 'public, max-age=300';
  }

  return { status: upstream.status, headers, body, expires: Date.now() + TTL_MS };
}

/**
 * Fetch + transform an upstream URL, served from an in-memory TTL cache.
 * Concurrent requests for the same URL share a single upstream fetch.
 */
export function fetchSite(target: string): Promise<ProxyEntry> {
  const hit = cache.get(target);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit);

  const pending = inflight.get(target);
  if (pending) return pending;

  const p = build(target)
    .then((entry) => {
      if (entry.status < 400 && entry.body.byteLength <= MAX_CACHE_BYTES) {
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
