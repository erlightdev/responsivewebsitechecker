import type { APIRoute } from 'astro';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

function normalizeUrl(raw: string): URL | null {
  let value = raw.trim();
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

function textBetween(html: string, tag: string): string {
  const match = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? decode(match[1].trim()) : '';
}

function attr(tag: string, name: string): string {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return decode((match?.[2] || match?.[3] || match?.[4] || '').trim());
}

function decode(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function metas(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const key = attr(tag, 'property') || attr(tag, 'name') || attr(tag, 'itemprop');
    const content = attr(tag, 'content');
    if (key && content && !out[key.toLowerCase()]) out[key.toLowerCase()] = content;
  }
  return out;
}

function absolute(value: string, base: URL): string {
  if (!value) return '';
  try {
    return new URL(value, base).href;
  } catch {
    return '';
  }
}

export const GET: APIRoute = async ({ request }) => {
  const input = new URL(request.url).searchParams.get('url') || '';
  const target = normalizeUrl(input);
  if (!target) {
    return Response.json({ error: 'Enter a valid http or https URL.' }, { status: 400 });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);

  try {
    const res = await fetch(target, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.6',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
      return Response.json({ error: 'This URL did not return a readable web page.' }, { status: 415 });
    }

    const html = (await res.text()).slice(0, 500_000);
    const finalUrl = new URL(res.url || target.href);
    const m = metas(html);
    const host = finalUrl.hostname.replace(/^www\./i, '');
    const title = m['og:title'] || m['twitter:title'] || textBetween(html, 'title') || host;
    const description = m['og:description'] || m['twitter:description'] || m.description || '';
    const image = absolute(m['og:image'] || m['twitter:image'] || m.image || '', finalUrl);
    const siteName = m['og:site_name'] || host.split('.')[0] || host;
    const type = m['og:type'] || '';

    return Response.json({
      url: finalUrl.href,
      host,
      title,
      description,
      image,
      siteName,
      type,
    });
  } catch (error) {
    const message = error instanceof Error && error.name === 'AbortError'
      ? 'Preview fetch timed out.'
      : 'Could not fetch preview metadata for this URL.';
    return Response.json({ error: message }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
};
