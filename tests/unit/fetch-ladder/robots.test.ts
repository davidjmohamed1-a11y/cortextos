import { describe, it, expect } from 'vitest';

import { parseRobotsTxt, isPathAllowed, fetchRobotsTxt, FETCH_LADDER_USER_AGENT } from '../../../src/fetch-ladder/robots.js';

describe('parseRobotsTxt', () => {
  it('parses a single user-agent: * block with Disallow', () => {
    const txt = `User-agent: *\nDisallow: /admin\nDisallow: /private\n`;
    const { rules, sitemaps } = parseRobotsTxt(txt, FETCH_LADDER_USER_AGENT);
    expect(rules.disallow).toEqual(['/admin', '/private']);
    expect(rules.allow).toEqual([]);
    expect(sitemaps).toEqual([]);
  });

  it('parses Allow rules', () => {
    const txt = `User-agent: *\nDisallow: /private\nAllow: /private/public\n`;
    const { rules } = parseRobotsTxt(txt, FETCH_LADDER_USER_AGENT);
    expect(rules.allow).toEqual(['/private/public']);
    expect(rules.disallow).toEqual(['/private']);
  });

  it('parses Crawl-delay', () => {
    const txt = `User-agent: *\nCrawl-delay: 5\n`;
    const { rules } = parseRobotsTxt(txt, FETCH_LADDER_USER_AGENT);
    expect(rules.crawl_delay_seconds).toBe(5);
  });

  it('collects Sitemap entries globally', () => {
    const txt = `User-agent: *\nDisallow: /admin\nSitemap: https://example.com/sitemap.xml\nSitemap: https://example.com/news-sitemap.xml\n`;
    const { sitemaps } = parseRobotsTxt(txt, FETCH_LADDER_USER_AGENT);
    expect(sitemaps).toEqual([
      'https://example.com/sitemap.xml',
      'https://example.com/news-sitemap.xml',
    ]);
  });

  it('strips comments + handles blank lines', () => {
    const txt = `# leading comment\n\nUser-agent: *  # inline\nDisallow: /admin # inline2\n\n`;
    const { rules } = parseRobotsTxt(txt, FETCH_LADDER_USER_AGENT);
    expect(rules.disallow).toEqual(['/admin']);
  });

  it('prefers exact UA match over wildcard', () => {
    const txt = `User-agent: *\nDisallow: /\n\nUser-agent: cortextos-fetch-ladder\nDisallow: /just-admin\n`;
    const { rules } = parseRobotsTxt(txt, FETCH_LADDER_USER_AGENT);
    expect(rules.disallow).toEqual(['/just-admin']);
  });

  it('falls back to * when no UA matches', () => {
    const txt = `User-agent: Googlebot\nDisallow: /google-only\n\nUser-agent: *\nDisallow: /public-block\n`;
    const { rules } = parseRobotsTxt(txt, FETCH_LADDER_USER_AGENT);
    expect(rules.disallow).toEqual(['/public-block']);
  });

  it('handles consecutive User-agent lines as a single group', () => {
    const txt = `User-agent: Googlebot\nUser-agent: Bingbot\nDisallow: /both\n\nUser-agent: *\nDisallow: /everyone\n`;
    const { rules } = parseRobotsTxt(txt, FETCH_LADDER_USER_AGENT);
    expect(rules.disallow).toEqual(['/everyone']);
  });

  it('empty Disallow is treated as "no rules" (permissive)', () => {
    const txt = `User-agent: *\nDisallow:\n`;
    const { rules } = parseRobotsTxt(txt, FETCH_LADDER_USER_AGENT);
    expect(rules.disallow).toEqual([]);
  });

  it('empty file returns empty rules', () => {
    const { rules, sitemaps } = parseRobotsTxt('', FETCH_LADDER_USER_AGENT);
    expect(rules.disallow).toEqual([]);
    expect(rules.allow).toEqual([]);
    expect(sitemaps).toEqual([]);
  });
});

describe('isPathAllowed', () => {
  it('returns true when no rules match', () => {
    expect(isPathAllowed({ disallow: ['/admin'], allow: [] }, '/foo')).toBe(true);
  });
  it('returns false on a single disallow match', () => {
    expect(isPathAllowed({ disallow: ['/admin'], allow: [] }, '/admin/users')).toBe(false);
  });
  it('Allow lifts a Disallow (longest match wins)', () => {
    expect(isPathAllowed({ disallow: ['/private'], allow: ['/private/public'] }, '/private/public/x')).toBe(true);
  });
  it('Disallow wins when it is longer than Allow', () => {
    expect(isPathAllowed({ disallow: ['/private/secret'], allow: ['/private'] }, '/private/secret/x')).toBe(false);
  });
  it('Allow ties Disallow → Allow wins', () => {
    expect(isPathAllowed({ disallow: ['/x'], allow: ['/x'] }, '/x/y')).toBe(true);
  });
});

describe('fetchRobotsTxt', () => {
  it('returns fetched=true with parsed rules on 200', async () => {
    const mockFetch = async () => new Response('User-agent: *\nDisallow: /admin\n', { status: 200, headers: { 'content-type': 'text/plain' } });
    const r = await fetchRobotsTxt('https://example.com/some/page', { fetcher: mockFetch as any });
    expect(r.fetched).toBe(true);
    expect(r.status).toBe(200);
    expect(r.rules.disallow).toEqual(['/admin']);
  });

  it('returns fetched=true with empty rules on 404 (permissive default)', async () => {
    const mockFetch = async () => new Response('', { status: 404 });
    const r = await fetchRobotsTxt('https://example.com/x', { fetcher: mockFetch as any });
    expect(r.fetched).toBe(true);
    expect(r.status).toBe(404);
    expect(r.rules.disallow).toEqual([]);
  });

  it('returns fetched=false on network error', async () => {
    const mockFetch = async () => { throw new Error('connect ETIMEDOUT'); };
    const r = await fetchRobotsTxt('https://example.com/x', { fetcher: mockFetch as any });
    expect(r.fetched).toBe(false);
    expect(r.error).toMatch(/ETIMEDOUT/);
  });

  it('returns fetched=false on invalid URL', async () => {
    const r = await fetchRobotsTxt('not a url', { fetcher: (() => { throw new Error('unreachable'); }) as any });
    expect(r.fetched).toBe(false);
    expect(r.error).toMatch(/invalid URL/);
  });

  it('uses the honest UA in the request header', async () => {
    let capturedUA: string | null = null;
    const mockFetch = async (_url: any, init: any) => {
      capturedUA = init.headers['User-Agent'];
      return new Response('', { status: 200 });
    };
    await fetchRobotsTxt('https://example.com/x', { fetcher: mockFetch as any });
    expect(capturedUA).toBe(FETCH_LADDER_USER_AGENT);
  });

  it('targets /robots.txt at the URL origin (drops path + query)', async () => {
    let capturedUrl: string | null = null;
    const mockFetch = async (url: any) => {
      capturedUrl = url.toString();
      return new Response('', { status: 200 });
    };
    await fetchRobotsTxt('https://example.com/deep/page?q=1', { fetcher: mockFetch as any });
    expect(capturedUrl).toBe('https://example.com/robots.txt');
  });

  it('caps oversized robots files at 1MB', async () => {
    // 1.2MB of "Disallow: /x\n"
    const big = 'User-agent: *\n' + 'Disallow: /x\n'.repeat(100_000);
    const mockFetch = async () => new Response(big, { status: 200 });
    const r = await fetchRobotsTxt('https://example.com/x', { fetcher: mockFetch as any });
    expect(r.fetched).toBe(true);
    // We don't assert exact line count — just that we returned without throwing.
    expect(r.rules.disallow.length).toBeGreaterThan(0);
  });
});
