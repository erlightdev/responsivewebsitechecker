export const prerender = false;

import type { APIRoute } from 'astro';

const STRIP_REQ_HEADERS = new Set(['host', 'origin', 'referer', 'cookie']);
const STRIP_RES_HEADERS = new Set([
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'transfer-encoding',
  'content-encoding', // fetch auto-decompresses
  'connection',
  'keep-alive',
]);

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

export const GET: APIRoute = async ({ request }) => {
  const { searchParams } = new URL(request.url);
  const raw = searchParams.get('url');

  if (!raw) return html(400, err('No URL', 'Pass ?url= to this endpoint.'));

  let targetUrl: URL;
  try {
    targetUrl = new URL(raw);
    if (!['http:', 'https:'].includes(targetUrl.protocol)) throw new Error();
  } catch {
    return html(400, err('Invalid URL', 'Only http:// and https:// URLs are supported.'));
  }

  try {
    const upstream = await fetch(targetUrl.href, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.5' },
      redirect: 'follow',
    });

    const ct = upstream.headers.get('content-type') ?? '';
    const outHeaders = new Headers();

    // Copy safe upstream headers
    for (const [k, v] of upstream.headers) {
      if (!STRIP_RES_HEADERS.has(k.toLowerCase())) outHeaders.set(k, v);
    }
    // Allow framing from our own origin
    outHeaders.set('X-Frame-Options', 'SAMEORIGIN');
    outHeaders.set('Content-Security-Policy', "frame-ancestors 'self'");

    if (ct.includes('text/html')) {
      let body = await upstream.text();

      // Remove any existing <base> tags, then inject ours so relative URLs resolve correctly
      const base = `<base href="${upstream.url}">`;
      body = body.replace(/<base[^>]*>/gi, '');
      body = /<head/i.test(body)
        ? body.replace(/(<head[^>]*>)/i, `$1${base}`)
        : base + body;

      outHeaders.set('Content-Type', 'text/html; charset=utf-8');
      return new Response(body, { status: upstream.status, headers: outHeaders });
    }

    // Non-HTML assets — stream through as-is
    return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return html(502, err('Failed to fetch', msg));
  }
};

function html(status: number, body: string) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function err(title: string, detail: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{font-family:system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;gap:10px;background:#0d1117;color:#e6edf3;padding:2rem;text-align:center}
    svg{opacity:.5}h2{margin:0;font-size:.95rem;font-weight:600}p{margin:0;font-size:.8rem;color:#8b949e;max-width:32ch}code{font-size:.75rem;background:#161b22;border:1px solid #30363d;border-radius:4px;padding:2px 6px;word-break:break-all}
  </style></head><body>
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#58a6ff" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
    <h2>${title}</h2><p>${detail}</p>
  </body></html>`;
}
