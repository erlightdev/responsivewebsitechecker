// Post-build patch for the Astro Vercel adapter's routing.
//
// The adapter ends `.vercel/output/config.json` with a catch-all:
//   { "src": "^/.*$", "dest": "_render", "status": 404 }
// Any path that isn't an explicitly-listed page matches it and Vercel's edge
// stamps the response 404 — even though the `_render` function actually ran and
// returned a 200. Our reverse-proxy (src/middleware.ts) mirrors the upstream's
// real path (e.g. `/assets/app.js?__vphost=https://site.com`), so every proxied
// subresource lands on this catch-all and the browser sees a 404 on a stylesheet
// or module script → the framed SPA renders blank.
//
// Fix: insert two routes *before* the 404 catch-all that send any request
// carrying the `__vphost` proxy marker to `_render`, letting the function's real
// status pass through. The marker rides either on the query string (rewritten
// document + subresources) or, for resources a SPA builds at runtime, on the
// Referer. Genuinely unknown paths still fall through to the edge 404.
//
// Idempotent: re-running detects the bypass routes and does nothing.

import { readFileSync, writeFileSync } from 'node:fs';

const CONFIG = '.vercel/output/config.json';

let config;
try {
  config = JSON.parse(readFileSync(CONFIG, 'utf8'));
} catch (err) {
  console.error(`[fix-vercel-routes] could not read ${CONFIG}:`, err.message);
  process.exit(1);
}

if (!Array.isArray(config.routes)) {
  console.error('[fix-vercel-routes] unexpected config: no routes array; skipping');
  process.exit(0);
}

const MARK = '__vphost';
const bypassRoutes = [
  // Rewritten document + subresources carry the marker in the query string.
  { src: '^/.*$', has: [{ type: 'query', key: MARK }], dest: '_render' },
  // SPA-built subresources (e.g. `new Image().src = '/x.png'`) have no marker on
  // the URL — they're identified by a Referer that carries one.
  { src: '^/.*$', has: [{ type: 'header', key: 'referer', value: `.*${MARK}.*` }], dest: '_render' },
];

const alreadyPatched = config.routes.some(
  (r) => Array.isArray(r.has) && r.has.some((h) => h && (h.key === MARK || (h.value || '').includes(MARK)))
);
if (alreadyPatched) {
  console.log('[fix-vercel-routes] proxy bypass routes already present; nothing to do');
  process.exit(0);
}

// Insert right before the final `^/.*$` 404 catch-all so it stays the last
// resort for genuinely unknown paths.
const idx = config.routes.findIndex((r) => r.src === '^/.*$' && r.status === 404);
if (idx === -1) {
  // Adapter output changed shape — fail loudly rather than silently shipping the bug.
  console.error('[fix-vercel-routes] could not find the 404 catch-all route; aborting');
  process.exit(1);
}

config.routes.splice(idx, 0, ...bypassRoutes);
writeFileSync(CONFIG, JSON.stringify(config, null, '\t') + '\n');
console.log(`[fix-vercel-routes] inserted ${bypassRoutes.length} proxy bypass routes before the 404 catch-all`);
