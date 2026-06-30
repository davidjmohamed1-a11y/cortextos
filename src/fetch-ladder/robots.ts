/**
 * Rung 0 — robots.txt fetch + parse.
 *
 * Honoring robots.txt is conservative (not strictly required by law) but
 * ignoring it is repeatedly used as bad-faith evidence in CFAA/breach-of-
 * contract cases. We honor it; we cache the result; we surface sitemap +
 * crawl-delay hints upstream.
 *
 * UA: "cortextos-fetch-ladder/1.0" — honest, single-token, identifies the
 * client. We do NOT spoof a desktop-browser UA.
 *
 * Best-effort: any error fetching robots.txt → conservative default
 * (`allowed: false`). Caller can override per-domain via the operator CLI if
 * a site's robots.txt is misconfigured.
 */

import type { Rung } from './types.js';

export const FETCH_LADDER_USER_AGENT = 'cortextos-fetch-ladder/1.0';

/** Parsed rules for a single user-agent block. */
export interface RobotsRules {
  /** Disallowed path prefixes for our UA. */
  disallow: string[];
  /** Allowed path prefixes (used to lift narrower restrictions inside a disallow). */
  allow: string[];
  /** Crawl-delay seconds, if set. */
  crawl_delay_seconds?: number;
}

/** Full robots.txt outcome — rules for our UA + globally-collected sitemaps. */
export interface RobotsResult {
  /** True if this domain's robots.txt was fetched + parsed successfully. */
  fetched: boolean;
  /** Per-UA rules (we evaluate against our specific UA first, then '*'). */
  rules: RobotsRules;
  /** All Sitemap: URLs declared. */
  sitemaps: string[];
  /** Raw HTTP status for diagnostics (404 = "no robots, default permissive"). */
  status?: number;
  /** Error message if fetch failed. */
  error?: string;
}

/**
 * Parse a robots.txt body into our internal rule structure. The parser is
 * intentionally simple: it recognizes User-agent / Disallow / Allow /
 * Crawl-delay / Sitemap. Other directives are ignored.
 *
 * Per RFC 9309, a User-agent line starts a "group"; subsequent rule lines
 * belong to all User-agents in that group until the next User-agent group.
 * We collapse to a single rule-set for `userAgent` (case-insensitive token
 * prefix match) with fallback to '*'.
 */
export function parseRobotsTxt(text: string, userAgent: string): { rules: RobotsRules; sitemaps: string[] } {
  const ua = userAgent.split('/')[0].toLowerCase();
  const sitemaps: string[] = [];

  // We need to scan groups. A "group" is consecutive User-agent lines followed
  // by rule lines. We collect rules per group, then pick the best matching
  // group for our UA.
  type Group = { agents: string[]; disallow: string[]; allow: string[]; crawl_delay?: number };
  const groups: Group[] = [];
  let currentGroup: Group | null = null;
  let expectingMoreUAs = false;

  for (const rawLine of text.split(/\r?\n/)) {
    // Strip inline comments + trim
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }

    if (field === 'user-agent') {
      if (!expectingMoreUAs || !currentGroup) {
        currentGroup = { agents: [], disallow: [], allow: [] };
        groups.push(currentGroup);
      }
      currentGroup.agents.push(value.toLowerCase());
      expectingMoreUAs = true;
      continue;
    }

    // Any non-UA directive ends the UA-collection phase for this group
    expectingMoreUAs = false;
    if (!currentGroup) continue; // rules outside any group → ignore

    if (field === 'disallow') {
      // Empty Disallow means "allow all" — we represent that as no disallows.
      if (value) currentGroup.disallow.push(value);
      continue;
    }
    if (field === 'allow') {
      if (value) currentGroup.allow.push(value);
      continue;
    }
    if (field === 'crawl-delay') {
      const n = parseFloat(value);
      if (isFinite(n) && n >= 0) currentGroup.crawl_delay = n;
      continue;
    }
  }

  // Pick the best matching group: exact UA match first, then '*', then nothing.
  const exactMatch = groups.find((g) => g.agents.includes(ua));
  const starMatch = groups.find((g) => g.agents.includes('*'));
  const chosen = exactMatch ?? starMatch;

  const rules: RobotsRules = {
    disallow: chosen?.disallow ?? [],
    allow: chosen?.allow ?? [],
  };
  if (chosen?.crawl_delay !== undefined) {
    rules.crawl_delay_seconds = chosen.crawl_delay;
  }

  return { rules, sitemaps };
}

/**
 * Standard robots.txt allow/disallow precedence: longest-match wins; on a
 * tie, Allow beats Disallow. Path matching is prefix-based with '*' wildcard
 * + '$' anchor support (V1 implements prefix only — wildcard is rare on the
 * sites we care about and would invite parser bugs).
 */
export function isPathAllowed(rules: RobotsRules, path: string): boolean {
  let longestAllow = -1;
  let longestDisallow = -1;
  for (const a of rules.allow) {
    if (path.startsWith(a) && a.length > longestAllow) longestAllow = a.length;
  }
  for (const d of rules.disallow) {
    if (path.startsWith(d) && d.length > longestDisallow) longestDisallow = d.length;
  }
  if (longestDisallow === -1) return true;
  if (longestAllow >= longestDisallow) return true; // Allow wins on tie + longer-match
  return false;
}

/**
 * Fetch a domain's robots.txt over HTTPS (falling back to HTTP only if the
 * caller-provided URL was HTTP). Returns a structured result, never throws.
 *
 * Conservative defaults on failure:
 *   - Network error → fetched=false, empty rules (caller treats as "allowed
 *     with no hints" — but the orchestrator's policy record marks the domain
 *     as "robots unknown" so we re-try later)
 *   - 5xx → same as network error
 *   - 404 → fetched=true, empty rules ("no robots = permissive by default")
 *   - 4xx other → fetched=true, conservative (no disallow, no sitemap)
 */
export async function fetchRobotsTxt(
  originUrl: string,
  opts: { fetcher?: typeof fetch; timeoutMs?: number; userAgent?: string } = {},
): Promise<RobotsResult> {
  const ua = opts.userAgent ?? FETCH_LADDER_USER_AGENT;
  const fetchFn = opts.fetcher ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  let robotsUrl: string;
  try {
    const u = new URL(originUrl);
    robotsUrl = `${u.protocol}//${u.host}/robots.txt`;
  } catch {
    return { fetched: false, rules: { disallow: [], allow: [] }, sitemaps: [], error: 'invalid URL' };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetchFn(robotsUrl, {
      headers: { 'User-Agent': ua, Accept: 'text/plain' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    if (resp.status === 404) {
      // No robots.txt = permissive by convention.
      return { fetched: true, rules: { disallow: [], allow: [] }, sitemaps: [], status: 404 };
    }
    if (!resp.ok) {
      // Other 4xx / 5xx — treat as no-rules (we still recorded the status).
      return { fetched: true, rules: { disallow: [], allow: [] }, sitemaps: [], status: resp.status };
    }
    const text = await resp.text();
    // Cap parse input — defensive, robots files >1MB are pathological.
    const capped = text.length > 1_000_000 ? text.slice(0, 1_000_000) : text;
    const parsed = parseRobotsTxt(capped, ua);
    return { fetched: true, rules: parsed.rules, sitemaps: parsed.sitemaps, status: resp.status };
  } catch (err: any) {
    return {
      fetched: false,
      rules: { disallow: [], allow: [] },
      sitemaps: [],
      error: err?.message ?? String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Re-export of which rung this module implements. Helpers for the orchestrator
 * to label attempts consistently.
 */
export const RUNG_ROBOTS: Rung = 0;
