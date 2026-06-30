import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { fetchUrl } from '../../../src/fetch-ladder/index.js';
import { loadSitePolicy } from '../../../src/fetch-ladder/site-policy.js';
import { resetArchiveTodayCounter } from '../../../src/fetch-ladder/archive.js';

beforeEach(() => {
  resetArchiveTodayCounter();
});

function freshTmp(): string {
  return mkdtempSync(join(tmpdir(), 'orch-'));
}

/** Build a mock fetch that responds based on URL pattern matching. */
function mockFetcher(handlers: Array<{ match: RegExp | ((u: string) => boolean); respond: () => Response | Promise<Response> }>) {
  return (async (urlOrReq: any, _init?: any) => {
    const url = typeof urlOrReq === 'string' ? urlOrReq : urlOrReq.url;
    for (const h of handlers) {
      const ok = typeof h.match === 'function' ? h.match(url) : h.match.test(url);
      if (ok) return h.respond();
    }
    return new Response('not handled', { status: 599 });
  }) as unknown as typeof fetch;
}

describe('fetchUrl — pre-flight + URL validation', () => {
  it('returns failure for invalid URL', async () => {
    const tmp = freshTmp();
    try {
      const r = await fetchUrl('not a url', { ctxRoot: tmp });
      expect(r.success).toBe(false);
      expect(r.attempts[0].detail).toMatch(/invalid URL/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns failure for non-http(s) scheme', async () => {
    const tmp = freshTmp();
    try {
      const r = await fetchUrl('ftp://example.com/file', { ctxRoot: tmp });
      expect(r.success).toBe(false);
      expect(r.attempts[0].detail).toMatch(/unsupported scheme/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('hard-stops a domain marked do_not_attempt', async () => {
    const tmp = freshTmp();
    try {
      // Seed a do_not_attempt policy via an initial run that gets disallowed
      const fetcher = mockFetcher([
        { match: /\/robots\.txt$/, respond: () => new Response('User-agent: *\nDisallow: /\n', { status: 200 }) },
      ]);
      const first = await fetchUrl('https://blockme.example/page', { ctxRoot: tmp, fetcher });
      expect(first.do_not_attempt).toBe(true);

      // Second call: should short-circuit without any further fetcher calls
      let secondCalls = 0;
      const fetcher2 = mockFetcher([
        { match: () => { secondCalls += 1; return true; }, respond: () => new Response('', { status: 200 }) },
      ]);
      const second = await fetchUrl('https://blockme.example/another', { ctxRoot: tmp, fetcher: fetcher2 });
      expect(second.do_not_attempt).toBe(true);
      expect(secondCalls).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('fetchUrl — rung 0 (robots.txt)', () => {
  it('marks domain do_not_attempt when robots disallows', async () => {
    const tmp = freshTmp();
    try {
      const fetcher = mockFetcher([
        { match: /\/robots\.txt$/, respond: () => new Response('User-agent: *\nDisallow: /\n', { status: 200 }) },
      ]);
      const r = await fetchUrl('https://example.com/page', { ctxRoot: tmp, fetcher });
      expect(r.success).toBe(false);
      expect(r.do_not_attempt).toBe(true);
      const policy = loadSitePolicy(tmp, 'example.com');
      expect(policy.do_not_attempt).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('proceeds past rung 0 when robots permits', async () => {
    const tmp = freshTmp();
    try {
      const fetcher = mockFetcher([
        { match: /\/robots\.txt$/, respond: () => new Response('User-agent: *\nDisallow:\n', { status: 200 }) },
        // Structured rung — return a feed
        { match: /\/feed$/, respond: () => new Response('<rss version="2.0"><channel><item><title>x</title><link>https://example.com/1</link></item></channel></rss>', { status: 200, headers: { 'content-type': 'application/rss+xml' } }) },
      ]);
      const r = await fetchUrl('https://example.com/feed', { ctxRoot: tmp, fetcher });
      expect(r.success).toBe(true);
      expect(r.rung_succeeded).toBe(2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('fetchUrl — rung 1 (official API)', () => {
  it('surfaces API metadata as facts (escalates, expecting caller to use direct API)', async () => {
    const tmp = freshTmp();
    const origKey = process.env.NOTION_API_KEY;
    process.env.NOTION_API_KEY = 'fake-key';
    try {
      const fetcher = mockFetcher([
        { match: /\/robots\.txt$/, respond: () => new Response('', { status: 404 }) },
        // structured fetch fails (no sitemap, no feed, plain HTML with no structured data)
        { match: () => true, respond: () => new Response('<html><body>nothing structured</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }) },
      ]);
      const r = await fetchUrl('https://notion.so/some-page', { ctxRoot: tmp, fetcher });
      // The official-api attempt should record the API exists
      const apiAttempt = r.attempts.find((a) => a.rung === 1);
      expect(apiAttempt?.detail).toMatch(/API available/);
    } finally {
      if (origKey === undefined) delete process.env.NOTION_API_KEY;
      else process.env.NOTION_API_KEY = origKey;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('notes auth_env missing when API exists but credentials are not set', async () => {
    const tmp = freshTmp();
    const origKey = process.env.NOTION_API_KEY;
    delete process.env.NOTION_API_KEY;
    try {
      const fetcher = mockFetcher([
        { match: /\/robots\.txt$/, respond: () => new Response('', { status: 404 }) },
        { match: () => true, respond: () => new Response('<html><body>nothing</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }) },
      ]);
      const r = await fetchUrl('https://notion.so/p', { ctxRoot: tmp, fetcher });
      const apiAttempt = r.attempts.find((a) => a.rung === 1);
      expect(apiAttempt?.detail).toMatch(/NOTION_API_KEY/);
    } finally {
      if (origKey !== undefined) process.env.NOTION_API_KEY = origKey;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('fetchUrl — rung 2 (structured) success', () => {
  it('returns sitemap success and updates best_rung', async () => {
    const tmp = freshTmp();
    try {
      const fetcher = mockFetcher([
        { match: /\/robots\.txt$/, respond: () => new Response('', { status: 404 }) },
        { match: /sitemap\.xml$/, respond: () => new Response('<urlset><url><loc>https://example.com/a</loc></url></urlset>', { status: 200, headers: { 'content-type': 'application/xml' } }) },
      ]);
      const r = await fetchUrl('https://example.com/sitemap.xml', { ctxRoot: tmp, fetcher });
      expect(r.success).toBe(true);
      expect(r.rung_succeeded).toBe(2);
      expect(r.content).toContain('https://example.com/a');
      const policy = loadSitePolicy(tmp, 'example.com');
      expect(policy.best_rung).toBe(2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns OG-meta success on HTML page with OpenGraph tags', async () => {
    const tmp = freshTmp();
    try {
      const fetcher = mockFetcher([
        { match: /\/robots\.txt$/, respond: () => new Response('', { status: 404 }) },
        { match: () => true, respond: () => new Response('<html><head><meta property="og:title" content="Test Page"/></head></html>', { status: 200, headers: { 'content-type': 'text/html' } }) },
      ]);
      const r = await fetchUrl('https://example.com/page', { ctxRoot: tmp, fetcher });
      expect(r.success).toBe(true);
      expect(r.rung_succeeded).toBe(2);
      expect(r.content).toContain('Test Page');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('fetchUrl — rung 4 (archive) fallback', () => {
  it('falls back to Wayback when earlier rungs fail', async () => {
    const tmp = freshTmp();
    const origKey = process.env.BRAVE_SEARCH_KEY;
    delete process.env.BRAVE_SEARCH_KEY;
    try {
      const fetcher = mockFetcher([
        { match: /\/robots\.txt$/, respond: () => new Response('', { status: 404 }) },
        { match: /archive\.org\/wayback\/available/, respond: () => new Response(JSON.stringify({
          archived_snapshots: { closest: { available: true, url: 'https://web.archive.org/web/20260101/https://example.com/x', timestamp: '20260101' } }
        }), { status: 200 }) },
        // Structured rung returns HTML with no structured data
        { match: () => true, respond: () => new Response('<html><body>nothing</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }) },
      ]);
      const r = await fetchUrl('https://example.com/x', { ctxRoot: tmp, fetcher });
      expect(r.success).toBe(true);
      expect(r.rung_succeeded).toBe(4);
      expect(r.facts?.snapshot_source).toBe('wayback');
    } finally {
      if (origKey !== undefined) process.env.BRAVE_SEARCH_KEY = origKey;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('fetchUrl — site-policy learning', () => {
  it('promotes best_rung on success at a lower rung', async () => {
    const tmp = freshTmp();
    try {
      const fetcher = mockFetcher([
        { match: /\/robots\.txt$/, respond: () => new Response('', { status: 404 }) },
        { match: /sitemap\.xml$/, respond: () => new Response('<urlset><url><loc>x</loc></url></urlset>', { status: 200, headers: { 'content-type': 'application/xml' } }) },
      ]);
      const r1 = await fetchUrl('https://example.com/sitemap.xml', { ctxRoot: tmp, fetcher });
      expect(r1.success).toBe(true);
      const policy = loadSitePolicy(tmp, 'example.com');
      expect(policy.best_rung).toBe(2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('records consecutive failures and demotes a rung after threshold', async () => {
    const tmp = freshTmp();
    try {
      const fetcher = mockFetcher([
        { match: /\/robots\.txt$/, respond: () => new Response('', { status: 404 }) },
        // Structured rung always returns nothing useful
        { match: () => true, respond: () => new Response('<html><body>none</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }) },
      ]);
      // Run twice — both fail at rung 2 (no structured data) → should block.
      await fetchUrl('https://lonely.example/a', { ctxRoot: tmp, fetcher, force: true });
      await fetchUrl('https://lonely.example/b', { ctxRoot: tmp, fetcher, force: true });
      const policy = loadSitePolicy(tmp, 'lonely.example');
      expect(policy.blocked_rungs).toContain(2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('flags needs_human_gate when anti-bot signal observed across all rungs', async () => {
    const tmp = freshTmp();
    const origKey = process.env.BRAVE_SEARCH_KEY;
    delete process.env.BRAVE_SEARCH_KEY;
    try {
      const fetcher = mockFetcher([
        { match: /\/robots\.txt$/, respond: () => new Response('', { status: 404 }) },
        // Cloudflare-style 403 on everything else
        { match: () => true, respond: () => new Response('cloudflare blocked', { status: 403 }) },
      ]);
      const r = await fetchUrl('https://protected.example/page', { ctxRoot: tmp, fetcher });
      expect(r.success).toBe(false);
      expect(r.needs_human_gate).toBe(true);
      const policy = loadSitePolicy(tmp, 'protected.example');
      expect(policy.needs_human_gate).toBe(true);
    } finally {
      if (origKey !== undefined) process.env.BRAVE_SEARCH_KEY = origKey;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('fetchUrl — attempt log structure', () => {
  it('always includes an entry for rung 0 (robots) first', async () => {
    const tmp = freshTmp();
    try {
      const fetcher = mockFetcher([
        { match: /\/robots\.txt$/, respond: () => new Response('', { status: 404 }) },
        { match: () => true, respond: () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }) },
      ]);
      const r = await fetchUrl('https://example.com/foo', { ctxRoot: tmp, fetcher });
      expect(r.attempts[0].rung).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
