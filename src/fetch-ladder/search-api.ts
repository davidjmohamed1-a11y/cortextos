/**
 * Rung 3 — search/grounding API.
 *
 * Inside an agent context, the BUILT-IN WebSearch tool is the primary path
 * and is invoked directly by the agent. This module wraps the secondary path:
 * the Brave Search API (free tier: ~2000 queries/month), used by the CLI and
 * by code paths that don't have access to WebSearch.
 *
 * NOTE: Bing Web Search API was retired Aug 11 2025. Do not build on it.
 *
 * Brave is the V1 single backend. Tavily/Exa are V1.5 candidates if usage
 * exceeds Brave's free tier or response quality is insufficient.
 *
 * Config: BRAVE_SEARCH_KEY env var. If missing, searchWeb returns
 * `{ ok: false, skipped: 'no API key' }` so the orchestrator can escalate
 * cleanly rather than throwing.
 */

import type { Rung } from './types.js';
import { FETCH_LADDER_USER_AGENT } from './robots.js';

export const RUNG_SEARCH: Rung = 3;

export interface SearchHit {
  title: string;
  url: string;
  description?: string;
}

export interface SearchResult {
  ok: boolean;
  skipped?: string;
  hits?: SearchHit[];
  error?: string;
  status?: number;
}

export interface SearchOptions {
  /** Override the env var (used in tests). */
  apiKey?: string;
  /** Inject a fetch implementation (used in tests). */
  fetcher?: typeof fetch;
  /** Max results to return. Brave free tier supports up to 20. */
  count?: number;
  timeoutMs?: number;
}

/**
 * Query the Brave Search API. Best-effort: missing key → ok=false with
 * skipped reason; transport/HTTP errors → ok=false with error message;
 * never throws.
 */
export async function searchWeb(query: string, opts: SearchOptions = {}): Promise<SearchResult> {
  const key = opts.apiKey ?? process.env.BRAVE_SEARCH_KEY;
  if (!key) {
    return { ok: false, skipped: 'no API key (BRAVE_SEARCH_KEY unset)' };
  }
  const trimmed = query.trim();
  if (!trimmed) {
    return { ok: false, error: 'empty query' };
  }
  const fetchFn = opts.fetcher ?? fetch;
  const count = Math.max(1, Math.min(opts.count ?? 10, 20));
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(trimmed)}&count=${count}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 12_000);
  try {
    const resp = await fetchFn(url, {
      headers: {
        'X-Subscription-Token': key,
        Accept: 'application/json',
        'User-Agent': FETCH_LADDER_USER_AGENT,
      },
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      return { ok: false, status: resp.status, error: `Brave search HTTP ${resp.status}` };
    }
    const body = await resp.json() as any;
    const rawHits: any[] = body?.web?.results ?? [];
    const hits: SearchHit[] = rawHits
      .filter((h) => h && typeof h.url === 'string' && typeof h.title === 'string')
      .map((h) => ({
        title: h.title,
        url: h.url,
        description: typeof h.description === 'string' ? h.description : undefined,
      }));
    return { ok: true, status: resp.status, hits };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  } finally {
    clearTimeout(timer);
  }
}
