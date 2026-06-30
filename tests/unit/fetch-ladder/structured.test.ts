import { describe, it, expect } from 'vitest';

import {
  parseSitemap,
  detectFeedKind,
  parseFeed,
  extractStructuredFromHtml,
  fetchStructured,
} from '../../../src/fetch-ladder/structured.js';

describe('parseSitemap', () => {
  it('extracts URLs from a standard sitemap', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/a</loc><lastmod>2026-06-29</lastmod></url>
  <url><loc>https://example.com/b</loc></url>
</urlset>`;
    const entries = parseSitemap(xml);
    expect(entries).toEqual([
      { loc: 'https://example.com/a', lastmod: '2026-06-29' },
      { loc: 'https://example.com/b' },
    ]);
  });

  it('extracts entries from a sitemap-index', () => {
    const xml = `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/sitemap1.xml</loc></sitemap>
  <sitemap><loc>https://example.com/sitemap2.xml</loc></sitemap>
</sitemapindex>`;
    const entries = parseSitemap(xml);
    expect(entries.map((e) => e.loc)).toEqual([
      'https://example.com/sitemap1.xml',
      'https://example.com/sitemap2.xml',
    ]);
  });

  it('decodes XML entities in URLs', () => {
    const xml = `<urlset><url><loc>https://example.com/a?x=1&amp;y=2</loc></url></urlset>`;
    const entries = parseSitemap(xml);
    expect(entries[0].loc).toBe('https://example.com/a?x=1&y=2');
  });

  it('returns empty on malformed XML', () => {
    expect(parseSitemap('<not valid')).toEqual([]);
    expect(parseSitemap('')).toEqual([]);
  });

  it('handles loose <loc> tags as a fallback', () => {
    const xml = `<garbage><loc>https://example.com/foo</loc></garbage>`;
    const entries = parseSitemap(xml);
    expect(entries[0].loc).toBe('https://example.com/foo');
  });
});

describe('detectFeedKind', () => {
  it('detects RSS by <rss tag', () => {
    expect(detectFeedKind('<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>')).toBe('rss');
  });
  it('detects RSS by <channel> + <item>', () => {
    expect(detectFeedKind('<channel><item><title>x</title></item></channel>')).toBe('rss');
  });
  it('detects Atom by xmlns', () => {
    expect(detectFeedKind('<feed xmlns="http://www.w3.org/2005/Atom"></feed>')).toBe('atom');
  });
  it('returns null on non-feed XML', () => {
    expect(detectFeedKind('<urlset></urlset>')).toBeNull();
    expect(detectFeedKind('')).toBeNull();
  });
});

describe('parseFeed (RSS)', () => {
  const rss = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Example</title>
    <item>
      <title>First post</title>
      <link>https://example.com/posts/1</link>
      <description>Hello world</description>
      <pubDate>Mon, 29 Jun 2026 10:00:00 GMT</pubDate>
    </item>
    <item>
      <title><![CDATA[Second post]]></title>
      <link>https://example.com/posts/2</link>
    </item>
  </channel>
</rss>`;
  it('extracts items + title/link/description', () => {
    const items = parseFeed(rss);
    expect(items.length).toBe(2);
    expect(items[0]).toEqual({
      title: 'First post',
      link: 'https://example.com/posts/1',
      description: 'Hello world',
      published_at: 'Mon, 29 Jun 2026 10:00:00 GMT',
    });
  });
  it('strips CDATA from title', () => {
    const items = parseFeed(rss);
    expect(items[1].title).toBe('Second post');
  });
});

describe('parseFeed (Atom)', () => {
  const atom = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example</title>
  <entry>
    <title>An Atom entry</title>
    <link href="https://example.com/atom/1"/>
    <summary>Short summary</summary>
    <published>2026-06-29T10:00:00Z</published>
  </entry>
</feed>`;
  it('extracts atom entry with href link + summary + published', () => {
    const items = parseFeed(atom);
    expect(items.length).toBe(1);
    expect(items[0]).toEqual({
      title: 'An Atom entry',
      link: 'https://example.com/atom/1',
      description: 'Short summary',
      published_at: '2026-06-29T10:00:00Z',
    });
  });
});

describe('extractStructuredFromHtml', () => {
  it('extracts JSON-LD blocks', () => {
    const html = `<html><head>
<script type="application/ld+json">{"@type":"Article","headline":"Hi"}</script>
</head></html>`;
    const d = extractStructuredFromHtml(html);
    expect(d.jsonld).toEqual([{ '@type': 'Article', headline: 'Hi' }]);
  });

  it('extracts JSON-LD arrays as multiple entries', () => {
    const html = `<script type="application/ld+json">[{"@type":"A"},{"@type":"B"}]</script>`;
    const d = extractStructuredFromHtml(html);
    expect(d.jsonld).toEqual([{ '@type': 'A' }, { '@type': 'B' }]);
  });

  it('skips malformed JSON-LD silently', () => {
    const html = `<script type="application/ld+json">{broken json</script><script type="application/ld+json">{"ok":true}</script>`;
    const d = extractStructuredFromHtml(html);
    expect(d.jsonld).toEqual([{ ok: true }]);
  });

  it('extracts OpenGraph meta tags', () => {
    const html = `<head>
<meta property="og:title" content="Example Title" />
<meta property="og:url" content="https://example.com/foo" />
<meta content="An image" property="og:image" />
</head>`;
    const d = extractStructuredFromHtml(html);
    expect(d.opengraph).toEqual({
      'og:title': 'Example Title',
      'og:url': 'https://example.com/foo',
      'og:image': 'An image',
    });
  });

  it('extracts schema.org itemprop pairs', () => {
    const html = `<div><meta itemprop="name" content="Foo Inc"/><meta itemprop="url" content="https://foo.com"/></div>`;
    const d = extractStructuredFromHtml(html);
    expect(d.schema_org).toEqual({ name: 'Foo Inc', url: 'https://foo.com' });
  });

  it('returns empty fields on empty input', () => {
    const d = extractStructuredFromHtml('');
    expect(d).toEqual({ jsonld: [], opengraph: {}, schema_org: {} });
  });
});

describe('fetchStructured', () => {
  it('detects + parses a sitemap by URL pattern', async () => {
    const mockFetch = async () => new Response(
      `<urlset><url><loc>https://example.com/a</loc></url></urlset>`,
      { status: 200, headers: { 'content-type': 'application/xml' } },
    );
    const r = await fetchStructured('https://example.com/sitemap.xml', { fetcher: mockFetch as any });
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('sitemap');
    expect(r.sitemap_entries?.[0].loc).toBe('https://example.com/a');
  });

  it('detects + parses an RSS feed by body sniff', async () => {
    const rss = `<rss version="2.0"><channel><item><title>x</title><link>y</link></item></channel></rss>`;
    const mockFetch = async () => new Response(rss, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
    const r = await fetchStructured('https://example.com/feed', { fetcher: mockFetch as any });
    expect(r.kind).toBe('feed');
    expect(r.feed_items?.length).toBe(1);
  });

  it('extracts JSON-LD + OG from HTML', async () => {
    const html = `<html><head>
<script type="application/ld+json">{"@type":"Article"}</script>
<meta property="og:title" content="Test"/>
</head><body></body></html>`;
    const mockFetch = async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
    const r = await fetchStructured('https://example.com/page', { fetcher: mockFetch as any });
    expect(r.kind).toBe('html-structured');
    expect(r.html_data?.jsonld[0]).toEqual({ '@type': 'Article' });
    expect(r.html_data?.opengraph['og:title']).toBe('Test');
  });

  it('returns ok=false on non-2xx', async () => {
    const mockFetch = async () => new Response('not found', { status: 404 });
    const r = await fetchStructured('https://example.com/missing', { fetcher: mockFetch as any });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
  });

  it('returns ok=false on network error', async () => {
    const mockFetch = async () => { throw new Error('econnreset'); };
    const r = await fetchStructured('https://example.com/x', { fetcher: mockFetch as any });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/econnreset/);
  });
});
