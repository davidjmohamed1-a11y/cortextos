/**
 * Fetch ladder orchestrator.
 *
 * Walks the legal rungs (0→4 in Phase 1, +5/6 in Phase 2) in order, consults
 * the per-domain SitePolicy cache, escalates only on CONTENT failure, stops
 * on POLICY failure. Records every attempt so callers can diagnose why each
 * rung failed.
 *
 * Phase 1 rungs:
 *   0 — robots.txt + ToS pre-check  (also feeds metadata for higher rungs)
 *   1 — Official API (Notion, GitHub, etc.) — registry lookup + auth check
 *   2 — Structured data (sitemap / feed / JSON-LD / OpenGraph)
 *   3 — Search API (Brave; built-in WebSearch in agent contexts)
 *   4 — Web archive (Wayback first, archive.today fallback)
 *
 * Phase 2 rungs (HOLD — gated on David's Chrome setup):
 *   5 — Real-browser session (agent-browser headful + persistent profile)
 *   6 — Human-in-the-loop handshake via Telegram
 *
 * No browser in Phase 1. No login. No CAPTCHA-defeat. The hard-rule hooks
 * back-stop any agent that tries to slip into Phase-2-territory before it's
 * wired.
 */

import type { FetchResult, FetchAttempt, Rung, SitePolicy } from './types.js';
import { PHASE_1_RUNGS } from './types.js';
import {
  registrableDomain,
  loadSitePolicy,
  saveSitePolicy,
  recordSuccess,
  recordFailure,
  isPolicyStale,
} from './site-policy.js';
import {
  fetchRobotsTxt,
  isPathAllowed,
  RUNG_ROBOTS,
} from './robots.js';
import { lookupOfficialApi, hasCredentialsFor, RUNG_OFFICIAL_API } from './official-api.js';
import { fetchStructured, RUNG_STRUCTURED } from './structured.js';
import { searchWeb, RUNG_SEARCH } from './search-api.js';
import { fetchFromArchive, RUNG_ARCHIVE } from './archive.js';

export interface FetchUrlOptions {
  /** cortextOS root for site-policy caching. */
  ctxRoot: string;
  /** Inject fetcher (tests). */
  fetcher?: typeof fetch;
  /** Force re-evaluation even if best_rung is cached. */
  force?: boolean;
  /** Cap retries on a single rung (transport errors). Defaults to 1. */
  retriesPerRung?: number;
  /** Override Date.now for stable tests. */
  now?: Date;
  /** Restrict to a specific rung set (testing / single-rung CLI invocation). */
  rungs?: Rung[];
}

/**
 * Main entry point. Walks the ladder, returns a FetchResult with the
 * full attempt history + (on success) the consumed content.
 */
export async function fetchUrl(url: string, opts: FetchUrlOptions): Promise<FetchResult> {
  const now = opts.now ?? new Date();
  const attempts: FetchAttempt[] = [];

  // --- Pre-flight: parse URL + load policy ---------------------------------
  let domain: string;
  let pathname: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`unsupported scheme: ${parsed.protocol}`);
    }
    domain = registrableDomain(parsed.hostname);
    pathname = parsed.pathname || '/';
  } catch (err: any) {
    return {
      url,
      success: false,
      attempts: [{ rung: 0, ok: false, fail_reason: 'policy', detail: `invalid URL: ${err?.message ?? err}`, fetched_at: now.toISOString() }],
      policy_after: { domain: '', blocked_rungs: [], updated_at: now.toISOString(), ttl_hours: 168 },
    };
  }

  let policy = loadSitePolicy(opts.ctxRoot, domain);
  const stale = isPolicyStale(policy, now);

  // Hard legal stop — never retry.
  if (policy.do_not_attempt) {
    return {
      url,
      success: false,
      do_not_attempt: true,
      attempts: [{ rung: 0, ok: false, fail_reason: 'policy', detail: 'domain marked do_not_attempt', fetched_at: now.toISOString() }],
      policy_after: policy,
    };
  }

  // --- Determine rung order -----------------------------------------------
  // Default: Phase 1 rungs in order. If best_rung is set (and not stale +
  // not forced), start at best_rung. Always include rung 0 first if no cached
  // robots OR cached robots are stale, so we re-check policy.
  const rungsToTry: Rung[] = opts.rungs
    ? [...opts.rungs]
    : computeRungOrder(policy, stale, opts.force ?? false);

  // --- Rung 0 (robots) is a PRE-CHECK, not a content-returning rung. -----
  // We update `policy.robots` from its outcome but do NOT call
  // recordSuccess/recordFailure (those govern best_rung / blocked_rungs which
  // are about content-returning rungs 1-6). A robots disallow is a hard
  // legal stop — set do_not_attempt + abort. Robots transport failure is
  // non-fatal (we proceed to the data rungs with "robots unknown").
  let robotsAllowed = true;
  if (rungsToTry[0] === RUNG_ROBOTS) {
    const r = await runRobots(url, pathname, opts, now);
    attempts.push(r.attempt);
    if (r.policy_update) policy = r.policy_update(policy);
    if (!r.ok && r.attempt.fail_reason === 'policy') {
      robotsAllowed = false;
      policy.do_not_attempt = true;
      saveSitePolicy(opts.ctxRoot, policy, now);
      return {
        url,
        success: false,
        do_not_attempt: true,
        attempts,
        policy_after: policy,
      };
    }
    rungsToTry.shift();
  }

  if (!robotsAllowed) {
    saveSitePolicy(opts.ctxRoot, policy, now);
    return { url, success: false, attempts, policy_after: policy };
  }

  // --- Walk remaining rungs ------------------------------------------------
  for (const rung of rungsToTry) {
    if (policy.blocked_rungs.includes(rung)) {
      attempts.push({ rung, ok: false, fail_reason: 'content', detail: 'rung previously blocked', fetched_at: now.toISOString() });
      continue;
    }

    const outcome = await runRung(rung, url, domain, opts, now);
    attempts.push(outcome.attempt);

    if (outcome.ok) {
      policy = recordSuccess(policy, rung, now);
      saveSitePolicy(opts.ctxRoot, policy, now);
      return {
        url,
        success: true,
        rung_succeeded: rung,
        content: outcome.content,
        content_type: outcome.content_type,
        facts: outcome.facts,
        attempts,
        policy_after: policy,
      };
    }

    if (outcome.attempt.fail_reason === 'policy') {
      // Stop the walk — policy failures are bright-line.
      policy.do_not_attempt = true;
      saveSitePolicy(opts.ctxRoot, policy, now);
      return { url, success: false, do_not_attempt: true, attempts, policy_after: policy };
    }

    policy = recordFailure(policy, rung, outcome.attempt.detail ?? 'unknown', now);
  }

  // --- All rungs exhausted -------------------------------------------------
  // If any attempt observed an anti-bot system, flag the domain so Phase 2 +
  // operator know it needs the real-browser rung.
  const sawAntiBot = attempts.some((a) => /cloudflare|turnstile|recaptcha|403|429/i.test(a.detail ?? ''));
  if (sawAntiBot) {
    policy.needs_human_gate = true;
    if (!policy.anti_bot_observed) policy.anti_bot_observed = 'cloudflare';
  }
  saveSitePolicy(opts.ctxRoot, policy, now);
  return {
    url,
    success: false,
    needs_human_gate: policy.needs_human_gate,
    attempts,
    policy_after: policy,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function computeRungOrder(policy: SitePolicy, stale: boolean, force: boolean): Rung[] {
  const out: Rung[] = [];
  // Always include rung 0 if we have no robots data OR data is stale OR force.
  const needRobots = force || stale || !policy.robots;
  if (needRobots) out.push(0);
  // Then proceed through Phase 1 rungs in order, optionally skipping ones
  // below best_rung (we already know they don't have what we want).
  for (const r of PHASE_1_RUNGS) {
    if (r === 0) continue; // handled above
    if (!force && policy.best_rung !== undefined && r < policy.best_rung) continue;
    out.push(r);
  }
  return out;
}

interface RungOutcome {
  ok: boolean;
  attempt: FetchAttempt;
  content?: string;
  content_type?: string;
  facts?: Record<string, unknown>;
}

async function runRung(
  rung: Rung,
  url: string,
  domain: string,
  opts: FetchUrlOptions,
  now: Date,
): Promise<RungOutcome> {
  switch (rung) {
    case RUNG_OFFICIAL_API:
      return runOfficialApi(url, domain, opts, now);
    case RUNG_STRUCTURED:
      return runStructured(url, opts, now);
    case RUNG_SEARCH:
      return runSearch(url, opts, now);
    case RUNG_ARCHIVE:
      return runArchive(url, opts, now);
    default:
      return {
        ok: false,
        attempt: {
          rung,
          ok: false,
          fail_reason: 'content',
          detail: `rung ${rung} not implemented (Phase 2)`,
          fetched_at: now.toISOString(),
        },
      };
  }
}

async function runRobots(
  url: string,
  pathname: string,
  opts: FetchUrlOptions,
  now: Date,
): Promise<{ ok: boolean; attempt: FetchAttempt; policy_update?: (p: SitePolicy) => SitePolicy }> {
  const r = await fetchRobotsTxt(url, { fetcher: opts.fetcher });
  if (!r.fetched) {
    return {
      ok: false,
      attempt: {
        rung: RUNG_ROBOTS,
        ok: false,
        fail_reason: 'transport',
        detail: `robots unreachable: ${r.error ?? 'unknown'}`,
        fetched_at: now.toISOString(),
      },
    };
  }
  const allowed = isPathAllowed(r.rules, pathname);
  if (!allowed) {
    return {
      ok: false,
      attempt: {
        rung: RUNG_ROBOTS,
        ok: false,
        fail_reason: 'policy',
        detail: 'robots.txt disallows our UA on this path',
        fetched_at: now.toISOString(),
      },
      policy_update: (p) => ({
        ...p,
        robots: {
          allowed: false,
          crawl_delay_ms: r.rules.crawl_delay_seconds ? r.rules.crawl_delay_seconds * 1000 : undefined,
          sitemap: r.sitemaps[0],
          fetched_at: now.toISOString(),
        },
      }),
    };
  }
  return {
    ok: true,
    attempt: {
      rung: RUNG_ROBOTS,
      ok: true,
      detail: r.sitemaps.length > 0 ? `robots OK; ${r.sitemaps.length} sitemap(s) declared` : 'robots OK',
      fetched_at: now.toISOString(),
    },
    policy_update: (p) => ({
      ...p,
      robots: {
        allowed: true,
        crawl_delay_ms: r.rules.crawl_delay_seconds ? r.rules.crawl_delay_seconds * 1000 : undefined,
        sitemap: r.sitemaps[0],
        fetched_at: now.toISOString(),
      },
    }),
  };
}

async function runOfficialApi(
  url: string,
  domain: string,
  _opts: FetchUrlOptions,
  now: Date,
): Promise<RungOutcome> {
  const entry = lookupOfficialApi(domain);
  if (!entry) {
    return {
      ok: false,
      attempt: { rung: RUNG_OFFICIAL_API, ok: false, fail_reason: 'content', detail: 'no official API in registry', fetched_at: now.toISOString() },
    };
  }
  if (!hasCredentialsFor(entry)) {
    return {
      ok: false,
      attempt: {
        rung: RUNG_OFFICIAL_API,
        ok: false,
        fail_reason: 'content',
        detail: `API requires ${entry.auth_env} env var (not set)`,
        fetched_at: now.toISOString(),
      },
    };
  }
  // V1: surface the API entry to the caller as a fact + escalate. We don't
  // wrap every documented API surface here — that's per-caller. The value is
  // *knowing the API exists + having the base URL + auth status* so the
  // caller can choose a specific endpoint.
  return {
    ok: false,
    attempt: {
      rung: RUNG_OFFICIAL_API,
      ok: false,
      fail_reason: 'content',
      detail: `API available (${entry.name}, base=${entry.api_base}); call directly with credentials`,
      fetched_at: now.toISOString(),
    },
    facts: {
      api_name: entry.name,
      api_base: entry.api_base,
      auth_env: entry.auth_env,
      note: entry.note,
    },
  };
}

async function runStructured(url: string, opts: FetchUrlOptions, now: Date): Promise<RungOutcome> {
  const r = await fetchStructured(url, { fetcher: opts.fetcher });
  if (!r.ok) {
    return {
      ok: false,
      attempt: {
        rung: RUNG_STRUCTURED,
        ok: false,
        fail_reason: r.status === 429 || r.status === 403 ? 'transport' : 'content',
        detail: `structured fetch failed: ${r.error ?? `HTTP ${r.status}`}`,
        fetched_at: now.toISOString(),
      },
    };
  }
  // We consider it a "success" if we extracted something useful.
  if (r.kind === 'sitemap' && r.sitemap_entries && r.sitemap_entries.length > 0) {
    return {
      ok: true,
      attempt: { rung: RUNG_STRUCTURED, ok: true, detail: `sitemap: ${r.sitemap_entries.length} entries`, fetched_at: now.toISOString() },
      content: r.sitemap_entries.map((e) => e.loc).join('\n'),
      content_type: 'text/plain',
      facts: { sitemap_count: r.sitemap_entries.length, sitemap_first_10: r.sitemap_entries.slice(0, 10) },
    };
  }
  if (r.kind === 'feed' && r.feed_items && r.feed_items.length > 0) {
    return {
      ok: true,
      attempt: { rung: RUNG_STRUCTURED, ok: true, detail: `feed: ${r.feed_items.length} items`, fetched_at: now.toISOString() },
      content: JSON.stringify(r.feed_items.slice(0, 50), null, 2),
      content_type: 'application/json',
      facts: { feed_item_count: r.feed_items.length, feed_first_5: r.feed_items.slice(0, 5) },
    };
  }
  if (r.kind === 'html-structured' && r.html_data) {
    const hasAnything = r.html_data.jsonld.length > 0
      || Object.keys(r.html_data.opengraph).length > 0
      || Object.keys(r.html_data.schema_org).length > 0;
    if (hasAnything) {
      return {
        ok: true,
        attempt: {
          rung: RUNG_STRUCTURED,
          ok: true,
          detail: `HTML structured: jsonld=${r.html_data.jsonld.length} og=${Object.keys(r.html_data.opengraph).length} schema=${Object.keys(r.html_data.schema_org).length}`,
          fetched_at: now.toISOString(),
        },
        content: JSON.stringify(r.html_data, null, 2),
        content_type: 'application/json',
        facts: { opengraph: r.html_data.opengraph, jsonld_count: r.html_data.jsonld.length },
      };
    }
  }
  return {
    ok: false,
    attempt: { rung: RUNG_STRUCTURED, ok: false, fail_reason: 'content', detail: 'no structured data on this URL', fetched_at: now.toISOString() },
  };
}

async function runSearch(url: string, opts: FetchUrlOptions, now: Date): Promise<RungOutcome> {
  // Use the URL itself as the query — the caller wants context about THIS page.
  // We strip the scheme + trim to keep the query reasonable.
  const query = url.replace(/^https?:\/\//, '').slice(0, 200);
  const r = await searchWeb(query, { fetcher: opts.fetcher });
  if (!r.ok) {
    return {
      ok: false,
      attempt: {
        rung: RUNG_SEARCH,
        ok: false,
        fail_reason: 'content',
        detail: r.skipped ?? r.error ?? `HTTP ${r.status}`,
        fetched_at: now.toISOString(),
      },
    };
  }
  if (!r.hits || r.hits.length === 0) {
    return {
      ok: false,
      attempt: { rung: RUNG_SEARCH, ok: false, fail_reason: 'content', detail: 'search returned no hits', fetched_at: now.toISOString() },
    };
  }
  return {
    ok: true,
    attempt: { rung: RUNG_SEARCH, ok: true, detail: `search: ${r.hits.length} hits`, fetched_at: now.toISOString() },
    content: JSON.stringify(r.hits, null, 2),
    content_type: 'application/json',
    facts: { hit_count: r.hits.length, top_hits: r.hits.slice(0, 5) },
  };
}

async function runArchive(url: string, opts: FetchUrlOptions, now: Date): Promise<RungOutcome> {
  const r = await fetchFromArchive(url, { fetcher: opts.fetcher });
  if (!r.ok) {
    return {
      ok: false,
      attempt: { rung: RUNG_ARCHIVE, ok: false, fail_reason: 'content', detail: r.error ?? r.skipped ?? 'archive failed', fetched_at: now.toISOString() },
    };
  }
  return {
    ok: true,
    attempt: { rung: RUNG_ARCHIVE, ok: true, detail: `archive: ${r.source} snapshot`, fetched_at: now.toISOString() },
    content: r.content ?? `[snapshot URL] ${r.snapshot_url}`,
    content_type: r.content_type ?? 'text/plain',
    facts: { snapshot_url: r.snapshot_url, snapshot_source: r.source, snapshot_timestamp: r.snapshot_timestamp },
  };
}

// Re-exports for downstream callers
export { registrableDomain, loadSitePolicy, listSitePolicies, forgetSitePolicy } from './site-policy.js';
export type { FetchResult, FetchAttempt, SitePolicy } from './types.js';
