/**
 * Rung 1 — Official APIs.
 *
 * Sanctioned by the publisher = highest legal cleanliness. The orchestrator
 * consults this registry before any web-fetch attempt: if a domain has a
 * documented API and we have credentials (or the API is keyless), prefer
 * that path over scraping HTML.
 *
 * V1 starts small — only the APIs the cortextOS fleet actually touches
 * today. Entries are added as we observe a real fetch need against the
 * matching domain. Don't pre-populate with imaginary callers.
 */

import type { Rung } from './types.js';

export const RUNG_OFFICIAL_API: Rung = 1;

export interface OfficialApiEntry {
  /** Registrable domain key (e.g. 'notion.so'). */
  domain: string;
  /** Public name (display only). */
  name: string;
  /** Base URL for the API. */
  api_base: string;
  /** True if the API requires an auth credential to read public-ish data. */
  auth_required: boolean;
  /** Env var name where the credential lives (if applicable). */
  auth_env?: string;
  /** Short note about scope / quirks. */
  note?: string;
}

/**
 * The V1 registry. Order does not matter — lookup is by domain. Boss policy:
 * NEVER store an API key value here; store only the env-var NAME so the
 * resolution happens at use-time from the agent's .env.
 */
export const OFFICIAL_API_REGISTRY: ReadonlyArray<OfficialApiEntry> = [
  {
    domain: 'notion.so',
    name: 'Notion',
    api_base: 'https://api.notion.com/v1',
    auth_required: true,
    auth_env: 'NOTION_API_KEY',
    note: 'Notion API: every request needs a Bearer integration token. Pages/databases must be shared with the integration first.',
  },
  {
    domain: 'github.com',
    name: 'GitHub',
    api_base: 'https://api.github.com',
    auth_required: false,
    auth_env: 'GITHUB_TOKEN',
    note: 'GitHub REST API: unauthenticated reads work for public repos at 60 req/hr; authenticated reads at 5000 req/hr.',
  },
  {
    domain: 'archive.org',
    name: 'Internet Archive',
    api_base: 'https://archive.org',
    auth_required: false,
    note: 'Internet Archive metadata + items: keyless, public.',
  },
  {
    domain: 'wikipedia.org',
    name: 'MediaWiki / Wikipedia',
    api_base: 'https://en.wikipedia.org/w/api.php',
    auth_required: false,
    note: 'MediaWiki API: keyless, generous rate limits.',
  },
  {
    domain: 'reddit.com',
    name: 'Reddit',
    api_base: 'https://www.reddit.com',
    auth_required: false,
    note: 'Public JSON endpoints (append .json to a URL). For real API use OAuth.',
  },
  {
    domain: 'ycombinator.com',
    name: 'Hacker News (Firebase)',
    api_base: 'https://hacker-news.firebaseio.com/v0',
    auth_required: false,
    note: 'Firebase-backed read-only API; keyless.',
  },
  {
    domain: 'openstreetmap.org',
    name: 'OpenStreetMap (Nominatim)',
    api_base: 'https://nominatim.openstreetmap.org',
    auth_required: false,
    note: 'Geocoding. Respect 1 req/sec rate limit + honest UA.',
  },
];

/**
 * Look up an official API entry by domain. Returns undefined if the domain
 * is not in the registry (orchestrator escalates to rung 2).
 */
export function lookupOfficialApi(domain: string): OfficialApiEntry | undefined {
  return OFFICIAL_API_REGISTRY.find((e) => e.domain === domain);
}

/**
 * Check whether the registered auth credential is actually present in the
 * environment. Returns true for keyless APIs.
 */
export function hasCredentialsFor(entry: OfficialApiEntry): boolean {
  if (!entry.auth_required) return true;
  if (!entry.auth_env) return false;
  return !!process.env[entry.auth_env];
}
