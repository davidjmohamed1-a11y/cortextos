/**
 * Per-registrable-domain policy cache. The fleet-wide memory of which fetch
 * rung works for which site — so we stop re-banging Cloudflare on every fetch.
 *
 * Storage: <ctxRoot>/state/fetch-ladder/site-policy/<registrable-domain>.json
 * Writes are atomic via src/utils/atomic.ts. Reads are best-effort: corrupt or
 * unreadable files return null + a fresh default policy.
 *
 * Promote-on-success: when a rung lower than `best_rung` succeeds, lower
 * `best_rung` to that rung. Demote-on-fail: after RUNG_BLOCK_THRESHOLD
 * consecutive failures at a rung, add it to `blocked_rungs`.
 */

import { existsSync, readFileSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';

import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import type { Rung, SitePolicy } from './types.js';
import { RUNG_BLOCK_THRESHOLD, SITE_POLICY_DEFAULT_TTL_HOURS } from './types.js';

/** Resolve the directory holding site-policy entries. */
export function sitePolicyDir(ctxRoot: string): string {
  return join(ctxRoot, 'state', 'fetch-ladder', 'site-policy');
}

/**
 * Reduce a hostname to its registrable domain (the "PSL+1").
 *
 * V1 implementation: heuristic — strip leading 'www.', then trim multi-label
 * subdomains down to the last 2 labels for most TLDs, last 3 for known
 * 2-label public suffixes (co.uk, co.jp, com.au, etc.). Sufficient for the
 * sites the fleet currently touches. A full PSL lookup is a V2 nice-to-have.
 */
const TWO_LABEL_PUBLIC_SUFFIXES = new Set([
  'co.uk', 'co.jp', 'co.kr', 'co.za', 'co.nz',
  'com.au', 'com.br', 'com.cn', 'com.mx', 'com.sg', 'com.tr',
  'org.uk', 'gov.uk', 'ac.uk', 'net.uk',
  'gov.au', 'edu.au',
]);

export function registrableDomain(hostname: string): string {
  if (!hostname) return '';
  let h = hostname.toLowerCase().trim();
  if (h.startsWith('www.')) h = h.slice(4);
  const labels = h.split('.');
  if (labels.length <= 2) return h;
  const lastTwo = labels.slice(-2).join('.');
  if (TWO_LABEL_PUBLIC_SUFFIXES.has(lastTwo)) {
    // Need last 3 labels.
    if (labels.length === 2) return h;
    return labels.slice(-3).join('.');
  }
  return lastTwo;
}

/** Compose a default empty SitePolicy for a domain we have not seen yet. */
export function emptyPolicy(domain: string): SitePolicy {
  return {
    domain,
    blocked_rungs: [],
    updated_at: new Date(0).toISOString(),
    ttl_hours: SITE_POLICY_DEFAULT_TTL_HOURS,
  };
}

/**
 * Load the SitePolicy for a domain, returning a fresh empty policy when there
 * is no entry (or the entry is unreadable). Never throws.
 */
export function loadSitePolicy(ctxRoot: string, domain: string): SitePolicy {
  const path = join(sitePolicyDir(ctxRoot), `${domain}.json`);
  if (!existsSync(path)) return emptyPolicy(domain);
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as SitePolicy;
    // Defense-in-depth: ensure required arrays exist on legacy entries.
    if (!Array.isArray(parsed.blocked_rungs)) parsed.blocked_rungs = [];
    if (!parsed.ttl_hours) parsed.ttl_hours = SITE_POLICY_DEFAULT_TTL_HOURS;
    return parsed;
  } catch {
    return emptyPolicy(domain);
  }
}

/**
 * Persist a SitePolicy. Atomic write, mode 0600 by virtue of atomicWriteSync.
 * Stamps updated_at before write.
 */
export function saveSitePolicy(ctxRoot: string, policy: SitePolicy, now: Date = new Date()): void {
  const dir = sitePolicyDir(ctxRoot);
  ensureDir(dir);
  const stamped: SitePolicy = { ...policy, updated_at: now.toISOString() };
  atomicWriteSync(join(dir, `${policy.domain}.json`), JSON.stringify(stamped, null, 2));
}

/** Check whether a SitePolicy entry has aged past its TTL. */
export function isPolicyStale(policy: SitePolicy, now: Date = new Date()): boolean {
  if (!policy.updated_at) return true;
  const updatedAt = Date.parse(policy.updated_at);
  if (!isFinite(updatedAt)) return true;
  const ageMs = now.getTime() - updatedAt;
  const ttlMs = (policy.ttl_hours ?? SITE_POLICY_DEFAULT_TTL_HOURS) * 60 * 60 * 1000;
  return ageMs > ttlMs;
}

/**
 * Record a successful fetch at the given rung. Promote `best_rung` if the
 * succeeding rung is lower (better) than the current best.
 */
export function recordSuccess(
  policy: SitePolicy,
  rung: Rung,
  now: Date = new Date(),
): SitePolicy {
  const next: SitePolicy = { ...policy };
  next.last_success = { rung, at: now.toISOString() };
  // Promote: lower rung is better.
  if (next.best_rung === undefined || rung < next.best_rung) {
    next.best_rung = rung;
  }
  // Clear failure streak for this rung — it just succeeded.
  if (next.fail_streak && next.fail_streak[rung]) {
    const fs = { ...next.fail_streak };
    delete fs[rung];
    next.fail_streak = fs;
  }
  // If this rung was previously blocked, un-block it (success rehabilitates).
  if (next.blocked_rungs.includes(rung)) {
    next.blocked_rungs = next.blocked_rungs.filter((r) => r !== rung);
  }
  return next;
}

/**
 * Record a failed fetch at the given rung. Demote: after
 * RUNG_BLOCK_THRESHOLD consecutive failures, add the rung to blocked_rungs
 * so we skip it on the next fetchUrl() walk.
 */
export function recordFailure(
  policy: SitePolicy,
  rung: Rung,
  reason: string,
  now: Date = new Date(),
): SitePolicy {
  const next: SitePolicy = { ...policy };
  next.last_fail = { rung, at: now.toISOString(), reason };
  const fs = { ...(next.fail_streak ?? {}) };
  fs[rung] = (fs[rung] ?? 0) + 1;
  next.fail_streak = fs;
  if ((fs[rung] ?? 0) >= RUNG_BLOCK_THRESHOLD && !next.blocked_rungs.includes(rung)) {
    next.blocked_rungs = [...next.blocked_rungs, rung];
  }
  return next;
}

/**
 * List every domain that has a cached policy entry. Used by the
 * `cortextos bus site-policy list` operator CLI.
 */
export function listSitePolicies(ctxRoot: string): string[] {
  const dir = sitePolicyDir(ctxRoot);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Drop a domain's cached policy entry. Operator override — used when a site's
 * behavior has changed (new API, lifted ToS, etc.) and we want to re-discover.
 */
export function forgetSitePolicy(ctxRoot: string, domain: string): boolean {
  const path = join(sitePolicyDir(ctxRoot), `${domain}.json`);
  if (!existsSync(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}
