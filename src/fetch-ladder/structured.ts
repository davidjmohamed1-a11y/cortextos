/**
 * Rung 2 — structured data: sitemap.xml + RSS/Atom feeds + JSON-LD / OpenGraph.
 *
 * Sites publish these formats specifically for machines. They're the cheapest
 * legal way to get the data we want, since the publisher has explicitly opted
 * in to programmatic access. No browser. No HTML scraping. Just parse what's
 * declared.
 *
 * V1 implements:
 *   - sitemap.xml + sitemap-index.xml URL extraction
 *   - RSS 2.0 + Atom feed item extraction (title, link, description, date)
 *   - JSON-LD blocks (<script type="application/ld+json">)
 *   - OpenGraph meta tags (og:title, og:description, og:url, og:image)
 *   - Schema.org microdata (basic — itemprop name/url/description)
 *
 * No external XML/HTML parser dependency — uses bounded regex extraction.
 * Every parser is best-effort: malformed input returns empty extraction,
 * never throws. Inputs are capped at MAX_INPUT_BYTES.
 */

import type { Rung } from './types.js';
import { FETCH_LADDER_USER_AGENT } from './robots.js';

export const RUNG_STRUCTURED: Rung = 2;

/** Cap on input size for any single parse pass (defensive vs 100MB sitemaps). */
const MAX_INPUT_BYTES = 10 * 1024 * 1024; // 10MB

// ---------------------------------------------------------------------------
// Sitemap
// ---------------------------------------------------------------------------

export interface SitemapEntry {
  loc: string;
  lastmod?: string;
}

/**
 * Parse a sitemap.xml body. Handles both regular sitemaps (list of URLs) and
 * sitemap indexes (list of nested sitemaps). Returns the extracted URL list.
 * Caller decides whether to recurse into sub-sitemaps.
 */
export function parseSitemap(xml: string): SitemapEntry[] {
  if (!xml || xml.length === 0) return [];
  const capped = xml.length > MAX_INPUT_BYTES ? xml.slice(0, MAX_INPUT_BYTES) : xml;
  const out: SitemapEntry[] = [];
  // Match every <loc>...</loc> in <url> or <sitemap> envelopes.
  const urlBlockRe = /<(?:url|sitemap)\b[^>]*>([\s\S]*?)<\/(?:url|sitemap)>/gi;
  let m: RegExpExecArray | null;
  while ((m = urlBlockRe.exec(capped)) !== null) {
    const block = m[1];
    const loc = pluck(block, 'loc');
    if (!loc) continue;
    const entry: SitemapEntry = { loc: decodeXmlEntities(loc) };
    const lastmod = pluck(block, 'lastmod');
    if (lastmod) entry.lastmod = lastmod;
    out.push(entry);
  }
  // Fallback for malformed sitemaps with bare <loc> tags
  if (out.length === 0) {
    const loose = /<loc\b[^>]*>([\s\S]*?)<\/loc>/gi;
    while ((m = loose.exec(capped)) !== null) {
      out.push({ loc: decodeXmlEntities(m[1].trim()) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// RSS / Atom feeds
// ---------------------------------------------------------------------------

export interface FeedItem {
  title?: string;
  link?: string;
  description?: string;
  published_at?: string;
}

/** Detects whether a body looks like an RSS, Atom, or non-feed document. */
export function detectFeedKind(xml: string): 'rss' | 'atom' | null {
  if (!xml) return null;
  const head = xml.slice(0, 4096).toLowerCase();
  if (head.includes('<feed') && head.includes('xmlns="http://www.w3.org/2005/atom"')) return 'atom';
  if (head.includes('<feed') && head.includes('atom')) return 'atom';
  if (head.includes('<rss')) return 'rss';
  if (head.includes('<channel>') && head.includes('<item')) return 'rss';
  return null;
}

export function parseFeed(xml: string): FeedItem[] {
  if (!xml) return [];
  const capped = xml.length > MAX_INPUT_BYTES ? xml.slice(0, MAX_INPUT_BYTES) : xml;
  const kind = detectFeedKind(capped);
  if (!kind) return [];
  if (kind === 'rss') return parseRssItems(capped);
  return parseAtomEntries(capped);
}

function parseRssItems(xml: string): FeedItem[] {
  const out: FeedItem[] = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const item: FeedItem = {};
    const title = pluck(block, 'title');
    if (title) item.title = stripCdata(title);
    const link = pluck(block, 'link');
    if (link) item.link = stripCdata(link);
    const desc = pluck(block, 'description');
    if (desc) item.description = stripCdata(desc).slice(0, 500);
    const pub = pluck(block, 'pubDate') ?? pluck(block, 'dc:date');
    if (pub) item.published_at = pub;
    out.push(item);
  }
  return out;
}

function parseAtomEntries(xml: string): FeedItem[] {
  const out: FeedItem[] = [];
  const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml)) !== null) {
    const block = m[1];
    const item: FeedItem = {};
    const title = pluck(block, 'title');
    if (title) item.title = stripCdata(title);
    // Atom link is <link href="..."/>
    const linkAttr = block.match(/<link\b[^>]*\bhref="([^"]+)"/i);
    if (linkAttr) item.link = linkAttr[1];
    const summary = pluck(block, 'summary') ?? pluck(block, 'content');
    if (summary) item.description = stripCdata(summary).slice(0, 500);
    const published = pluck(block, 'published') ?? pluck(block, 'updated');
    if (published) item.published_at = published;
    out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// JSON-LD + OpenGraph + schema.org
// ---------------------------------------------------------------------------

export interface StructuredHtmlData {
  jsonld: any[];
  opengraph: Record<string, string>;
  schema_org: Record<string, string>;
}

/**
 * Extract structured data from an HTML body. Returns empty fields rather than
 * throwing on malformed HTML.
 */
export function extractStructuredFromHtml(html: string): StructuredHtmlData {
  if (!html) return { jsonld: [], opengraph: {}, schema_org: {} };
  const capped = html.length > MAX_INPUT_BYTES ? html.slice(0, MAX_INPUT_BYTES) : html;
  return {
    jsonld: extractJsonLd(capped),
    opengraph: extractOpenGraph(capped),
    schema_org: extractSchemaOrg(capped),
  };
}

function extractJsonLd(html: string): any[] {
  const out: any[] = [];
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) out.push(...parsed);
      else out.push(parsed);
    } catch {
      // Skip malformed JSON-LD blocks silently — they're worthless to us.
    }
  }
  return out;
}

function extractOpenGraph(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  // <meta property="og:title" content="..." /> OR <meta content="..." property="og:title">
  const re = /<meta\b[^>]*\bproperty=["'](og:[^"']+)["'][^>]*\bcontent=["']([^"']*)["']/gi;
  const reReverse = /<meta\b[^>]*\bcontent=["']([^"']*)["'][^>]*\bproperty=["'](og:[^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out[m[1]] = m[2];
  while ((m = reReverse.exec(html)) !== null) {
    if (!(m[2] in out)) out[m[2]] = m[1];
  }
  return out;
}

function extractSchemaOrg(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Very lightweight: itemprop="name" content="..." and itemprop="url" content="..."
  // (Full microdata parsing is overkill; JSON-LD usually carries the same data.)
  const re = /<[^>]*\bitemprop=["']([^"']+)["'][^>]*\bcontent=["']([^"']*)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (!(m[1] in out)) out[m[1]] = m[2];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Network helpers
// ---------------------------------------------------------------------------

export interface StructuredFetchResult {
  ok: boolean;
  status?: number;
  kind?: 'sitemap' | 'feed' | 'html-structured';
  sitemap_entries?: SitemapEntry[];
  feed_items?: FeedItem[];
  html_data?: StructuredHtmlData;
  error?: string;
}

/**
 * Best-effort fetch + auto-detect. Identifies whether the URL is a sitemap,
 * an RSS/Atom feed, or an HTML page with embedded structured data, and
 * extracts accordingly. Never throws.
 */
export async function fetchStructured(
  url: string,
  opts: { fetcher?: typeof fetch; timeoutMs?: number; userAgent?: string } = {},
): Promise<StructuredFetchResult> {
  const fetchFn = opts.fetcher ?? fetch;
  const ua = opts.userAgent ?? FETCH_LADDER_USER_AGENT;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetchFn(url, {
      headers: { 'User-Agent': ua, Accept: 'application/xml,text/xml,application/rss+xml,application/atom+xml,text/html;q=0.9' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      return { ok: false, status: resp.status, error: `HTTP ${resp.status}` };
    }
    const body = await resp.text();
    const contentType = (resp.headers.get('content-type') ?? '').toLowerCase();

    // 1. Sitemap detection — URL ending sitemap*.xml OR <urlset/<sitemapindex root.
    if (/sitemap[^/]*\.xml/i.test(url) || /<(urlset|sitemapindex)\b/i.test(body.slice(0, 2048))) {
      const entries = parseSitemap(body);
      return { ok: true, status: resp.status, kind: 'sitemap', sitemap_entries: entries };
    }
    // 2. Feed detection — by sniff
    if (detectFeedKind(body)) {
      const items = parseFeed(body);
      return { ok: true, status: resp.status, kind: 'feed', feed_items: items };
    }
    // 3. HTML structured-data extraction
    if (contentType.includes('text/html') || /<html\b/i.test(body.slice(0, 1024))) {
      const data = extractStructuredFromHtml(body);
      return { ok: true, status: resp.status, kind: 'html-structured', html_data: data };
    }
    // 4. Unknown — return body status so caller can decide.
    return { ok: true, status: resp.status };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function pluck(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : undefined;
}

function stripCdata(s: string): string {
  const m = s.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return (m ? m[1] : s).trim();
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
