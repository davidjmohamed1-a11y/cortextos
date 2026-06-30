import { describe, it, expect } from 'vitest';

import { searchWeb } from '../../../src/fetch-ladder/search-api.js';

describe('searchWeb', () => {
  it('returns skipped when BRAVE_SEARCH_KEY is missing', async () => {
    const orig = process.env.BRAVE_SEARCH_KEY;
    delete process.env.BRAVE_SEARCH_KEY;
    try {
      const r = await searchWeb('hello world');
      expect(r.ok).toBe(false);
      expect(r.skipped).toMatch(/no API key/);
    } finally {
      if (orig !== undefined) process.env.BRAVE_SEARCH_KEY = orig;
    }
  });

  it('returns error for empty query', async () => {
    const r = await searchWeb('   ', { apiKey: 'fake' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/empty query/);
  });

  it('parses Brave response into normalized hits', async () => {
    const mockFetch = async (_url: any, _init: any) => new Response(JSON.stringify({
      web: {
        results: [
          { title: 'Result A', url: 'https://example.com/a', description: 'desc a' },
          { title: 'Result B', url: 'https://example.com/b' },
        ],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const r = await searchWeb('query', { apiKey: 'fake', fetcher: mockFetch as any });
    expect(r.ok).toBe(true);
    expect(r.hits).toEqual([
      { title: 'Result A', url: 'https://example.com/a', description: 'desc a' },
      { title: 'Result B', url: 'https://example.com/b', description: undefined },
    ]);
  });

  it('passes API key in X-Subscription-Token header', async () => {
    let capturedHeader: string | null = null;
    const mockFetch = async (_url: any, init: any) => {
      capturedHeader = init.headers['X-Subscription-Token'];
      return new Response('{"web":{"results":[]}}', { status: 200 });
    };
    await searchWeb('foo', { apiKey: 'my-secret', fetcher: mockFetch as any });
    expect(capturedHeader).toBe('my-secret');
  });

  it('returns ok=false on non-2xx', async () => {
    const mockFetch = async () => new Response('rate limited', { status: 429 });
    const r = await searchWeb('foo', { apiKey: 'fake', fetcher: mockFetch as any });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(429);
  });

  it('returns ok=false on transport error', async () => {
    const mockFetch = async () => { throw new Error('econnreset'); };
    const r = await searchWeb('foo', { apiKey: 'fake', fetcher: mockFetch as any });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/econnreset/);
  });

  it('caps count at 20 (Brave max)', async () => {
    let capturedUrl: string | null = null;
    const mockFetch = async (url: any) => {
      capturedUrl = url.toString();
      return new Response('{"web":{"results":[]}}', { status: 200 });
    };
    await searchWeb('foo', { apiKey: 'fake', count: 99, fetcher: mockFetch as any });
    expect(capturedUrl).toContain('count=20');
  });

  it('filters malformed result entries', async () => {
    const mockFetch = async () => new Response(JSON.stringify({
      web: {
        results: [
          { title: 'ok', url: 'https://example.com/ok' },
          { url: 'https://example.com/nofield' }, // missing title
          null,
        ],
      },
    }), { status: 200 });
    const r = await searchWeb('foo', { apiKey: 'fake', fetcher: mockFetch as any });
    expect(r.hits?.length).toBe(1);
    expect(r.hits?.[0].url).toBe('https://example.com/ok');
  });
});
